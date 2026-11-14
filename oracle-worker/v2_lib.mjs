/**
 * v2_lib.mjs — shared helpers for the V2 operator scripts (v2_deploy.mjs,
 * v2_rotate.mjs).
 *
 * Signing model (V2 separates the roles):
 *   - ADMIN: cold key or multisig account. It is the transaction SOURCE of
 *     every governance transaction, so its classic signers/thresholds apply.
 *     Give its secret(s) in ADMIN_SECRETS (comma-separated, for multisig), or
 *     leave it unset to get the transaction XDR to sign elsewhere (hardware
 *     wallet, Stellar Lab, another machine).
 *   - OPERATOR (hot key): signs only its own Soroban authorization entry
 *     (constructor / new-operator proof of control), never the envelope.
 */

import crypto from "crypto";
import { bls12_381 } from "@noble/curves/bls12-381";
import {
  Address,
  Keypair,
  TransactionBuilder,
  authorizeEntry,
  rpc,
} from "@stellar/stellar-sdk";

export const POP_DOMAIN = "STELLAR_VRF_BLS_POP_V2";
export const POP_BLS_DST = "SOROBAN_VRF_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_";

/** 192-byte uncompressed G2 public key of a BLS secret (hex scalar). */
export function blsPublicKey(secretHex) {
  const sk = parseBlsSecret(secretHex);
  return Buffer.from(bls12_381.G2.ProjectivePoint.BASE.multiply(sk).toRawBytes(false));
}

export function parseBlsSecret(secretHex) {
  const clean = String(secretHex ?? "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) throw new Error("BLS secret must be a hex scalar");
  const sk = BigInt("0x" + clean);
  if (sk <= 1n || sk >= bls12_381.fields.Fr.ORDER) throw new Error("BLS secret must be in [2, r)");
  return sk;
}

/** A fresh random BLS secret (hex), for key generation. */
export function randomBlsSecret() {
  for (;;) {
    const sk = BigInt("0x" + crypto.randomBytes(32).toString("hex")) % bls12_381.fields.Fr.ORDER;
    if (sk > 1n) return sk.toString(16).padStart(64, "0");
  }
}

/**
 * The message the contract checks in `propose_key_rotation`
 * (`pop_message` in lib.rs):
 *   POP_DOMAIN ‖ xdr(ScVal::Address(contract)) ‖ new_epoch_id (u32 BE) ‖ new_pk
 */
export function popMessage(contractId, newEpochId, newPk) {
  const epoch = Buffer.alloc(4);
  epoch.writeUInt32BE(newEpochId);
  return Buffer.concat([
    Buffer.from(POP_DOMAIN, "utf8"),
    new Address(contractId).toScVal().toXDR(),
    epoch,
    Buffer.from(newPk),
  ]);
}

/** BLS proof of possession (96-byte uncompressed G1) for a new epoch key. */
export function popSignature(contractId, newEpochId, secretHex) {
  const sk = parseBlsSecret(secretHex);
  const pk = blsPublicKey(secretHex);
  const h = bls12_381.G1.hashToCurve(popMessage(contractId, newEpochId, pk), {
    DST: new TextEncoder().encode(POP_BLS_DST),
  });
  return Buffer.from(h.multiply(sk).toRawBytes(false));
}

export function adminSigners() {
  const raw = (process.env.ADMIN_SECRETS ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => Keypair.fromSecret(s.trim()));
}

/**
 * Simulate, sign the given address-credential auth entries with their keys,
 * re-simulate with the signed entries, then either sign + submit with the
 * admin signers or print the XDR for external signing.
 *
 * @param buildTx   (auth?) => Transaction   builds the tx (source = admin)
 * @param authKeys  Map<G-address, Keypair>  keys for address-credential entries
 */
export async function simulateSignSubmit(server, networkPassphrase, buildTx, authKeys, { label }) {
  // record_allow_nonroot: the operator's require_auth() in the constructor is
  // not the root of the invocation (the root is the deployer's create-contract
  // call). The network accepts such entries; plain recording mode refuses to
  // record them. The entry signed below is bound to this exact invocation.
  const sim1 = await server.simulateTransaction(buildTx(undefined), undefined, "record_allow_nonroot");
  if (rpc.Api.isSimulationError(sim1)) throw new Error(`${label}: simulation failed: ${sim1.error}`);
  const latest = (await server.getLatestLedger()).sequence;
  const validUntil = latest + 100;

  const entries = sim1.result?.auth ?? [];
  const signed = [];
  for (const entry of entries) {
    // stellar-sdk v17 XDR objects are plain data (no accessor methods).
    const creds = entry.credentials;
    if (creds.type !== "sorobanCredentialsSourceAccount") {
      const addr = creds.address ?? creds.addressV2 ?? creds.addressWithDelegates?.addressCredentials;
      if (!addr) throw new Error(`${label}: unsupported credential type ${creds.type}`);
      const who = Address.fromScAddress(addr.address).toString();
      const kp = authKeys.get(who);
      if (!kp) throw new Error(`${label}: no key provided for the authorization of ${who}`);
      signed.push(await authorizeEntry(entry, kp, validUntil, networkPassphrase));
    } else {
      signed.push(entry); // source-account credentials: covered by the envelope signature
    }
  }

  const tx2 = buildTx(signed);
  const sim2 = await server.simulateTransaction(tx2);
  if (rpc.Api.isSimulationError(sim2)) throw new Error(`${label}: re-simulation failed: ${sim2.error}`);
  const prepared = rpc.assembleTransaction(tx2, sim2).build();

  const admins = adminSigners();
  if (admins.length === 0) {
    console.log(`\n${label}: ADMIN_SECRETS not set. Sign this transaction with the admin account`);
    console.log("(all signers needed to reach its medium threshold) and submit it:\n");
    console.log(prepared.toXDR());
    console.log(`\nValid until ledger ${validUntil} for the operator authorization.`);
    return null;
  }
  for (const kp of admins) prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`${label}: send error ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash, result: res };
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`${label}: transaction ${sent.hash} failed`);
  }
  throw new Error(`${label}: confirmation timeout for ${sent.hash}`);
}

export function newBuilder(account, networkPassphrase) {
  return new TransactionBuilder(account, { fee: "2000000", networkPassphrase }).setTimeout(300);
}
