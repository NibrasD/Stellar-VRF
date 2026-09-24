/**
 * mainnet_live_e2e_test.mjs
 * End-to-end live test on Stellar MAINNET for the newly deployed VRF contract.
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  Account,
} from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const NETWORK = Networks.PUBLIC;
const CONTRACT_ID = "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX";

const ORACLE_SECRET = process.env.ORACLE_STELLAR_SECRET || process.env.ORACLE_SECRET;
if (!ORACLE_SECRET) {
  console.error("Missing ORACLE_SECRET");
  process.exit(1);
}
const oracleKp = Keypair.fromSecret(ORACLE_SECRET);
const oracleAddr = oracleKp.publicKey();

const BLS_SK_HEX = (process.env.ORACLE_BLS_SECRET_KEY || "").trim().replace(/^0x/, "");
const BLS_SK = BigInt("0x" + BLS_SK_HEX);
const ORACLE_BLS_PK_BYTES = Buffer.from(
  bls12_381.G2.ProjectivePoint.BASE.multiply(BLS_SK).toRawBytes(false)
);

const VRF_DST = "SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_";
const BETA_DOMAIN = "VREP_BETA_V1";
const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const DRAND_API_URL = "https://api.drand.sh";

const server = new rpc.Server(MAINNET_RPC, { allowHttp: false });

async function getAccount(publicKey) {
  try {
    return await server.getAccount(publicKey);
  } catch (e) {
    const resp = await fetch(`https://horizon.stellar.org/accounts/${publicKey}`);
    if (!resp.ok) throw new Error(`Horizon mainnet account not found: ${publicKey}`);
    const data = await resp.json();
    return new Account(publicKey, data.sequence);
  }
}

async function pollTx(hash) {
  process.stdout.write("  Confirming");
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await server.getTransaction(hash);
    if (s.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" ✔\n");
      return s;
    }
    if (s.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" ✖\n");
      throw new Error(`TX FAILED: ${hash} — ${JSON.stringify(s)}`);
    }
    process.stdout.write(".");
  }
  throw new Error("Timeout: " + hash);
}

async function sendTx(tx, signerKp) {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signerKp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Send failed: ${JSON.stringify(sent.errorResult)}`);
  }
  const confirmed = await pollTx(sent.hash);
  return { hash: sent.hash, sim, confirmed };
}

async function simCall(fn, args) {
  const acct = await getAccount(oracleAddr);
  const tx = new TransactionBuilder(acct, { fee: "1000", networkPassphrase: NETWORK })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT_ID, function: fn, args }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simCall error (${fn}): ${JSON.stringify(sim.error)}`);
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

const u64ToBe = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

async function main() {
  console.log("============================================================");
  console.log("Stellar VRF MAINNET — Live End-to-End Test");
  console.log("Contract ID:   ", CONTRACT_ID);
  console.log("Oracle Account:", oracleAddr);
  console.log("============================================================\n");

  const contextStr = "Stellar VRF Production Verification " + Date.now();
  const contextBuf = Buffer.from(contextStr, "utf-8");

  console.log("[1/5] Submitting request() with 0.2 XLM escrow...");
  const acctReq = await getAccount(oracleAddr);
  const reqTx = new TransactionBuilder(acctReq, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: "request",
        args: [
          nativeToScVal(contextBuf, { type: "bytes" }),
          new Address(oracleAddr).toScVal(),
        ],
      })
    )
    .setTimeout(120)
    .build();

  const reqRes = await sendTx(reqTx, oracleKp);
  console.log("  Request TX Hash:", reqRes.hash);
  console.log(`  Explorer Link:   https://stellar.expert/explorer/public/tx/${reqRes.hash}`);

  // Retrieve returned request ID
  let requestId;
  try {
    const retVal = reqRes.confirmed.resultMetaXdr.v3().sorobanMeta().returnValue();
    requestId = scValToNative(retVal);
  } catch (e) {
    requestId = scValToNative(reqRes.sim.result.retval);
  }
  requestId = BigInt(requestId);
  console.log(`  Request ID:      ${requestId}`);

  console.log(`\n[2/5] Querying required drand round for Request #${requestId}...`);
  const targetRoundVal = await simCall("request_round", [nativeToScVal(requestId, { type: "u64" })]);
  const targetRound = BigInt(targetRoundVal);
  console.log(`  Target drand round: ${targetRound}`);

  console.log(`\n[3/5] Waiting for drand round ${targetRound}...`);
  let beacon;
  for (let i = 0; i < 45; i++) {
    try {
      const resp = await fetch(`${DRAND_API_URL}/${DRAND_CHAIN_HASH}/public/${targetRound}`);
      if (resp.ok) {
        beacon = await resp.json();
        break;
      }
    } catch {}
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!beacon) throw new Error("Could not fetch drand beacon");
  console.log(" ✔ drand beacon received! Round:", beacon.round);

  console.log(`\n[4/5] Generating VRF proof and submitting fulfill()...`);
  const drandSigPoint = bls12_381.G1.ProjectivePoint.fromHex(beacon.signature);
  const drandSigBytes = Buffer.from(drandSigPoint.toRawBytes(false));

  const drandRandomness = Buffer.from(sha256(drandSigBytes));
  const alphaInput = Buffer.concat([
    u64ToBe(requestId),
    contextBuf,
    u64ToBe(targetRound),
    drandRandomness,
  ]);
  const alphaSeed = Buffer.from(sha256(alphaInput));

  const dst = new TextEncoder().encode(VRF_DST);
  const hPoint = bls12_381.G1.hashToCurve(alphaSeed, { DST: dst });
  const gammaPoint = hPoint.multiply(BLS_SK);
  const gammaBytes = Buffer.from(gammaPoint.toRawBytes(false));

  const betaDomainBytes = Buffer.from(BETA_DOMAIN, "utf-8");
  const betaOutput = Buffer.from(sha256(Buffer.concat([betaDomainBytes, gammaBytes])));

  const ed25519Payload = Buffer.concat([
    u64ToBe(requestId),
    alphaSeed,
    gammaBytes,
    betaOutput,
    u64ToBe(targetRound),
    drandSigBytes,
  ]);
  const ed25519Sig = Buffer.from(oracleKp.sign(ed25519Payload));

  const proofScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("alpha_seed"),
      val: nativeToScVal(alphaSeed, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("beta_output"),
      val: nativeToScVal(betaOutput, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("drand_round"),
      val: nativeToScVal(targetRound, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("drand_signature"),
      val: nativeToScVal(drandSigBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("gamma_point"),
      val: nativeToScVal(gammaBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("public_key"),
      val: nativeToScVal(ORACLE_BLS_PK_BYTES, { type: "bytes" }),
    }),
  ]);

  const acctFulfill = await getAccount(oracleAddr);
  const fulfillTx = new TransactionBuilder(acctFulfill, { fee: "5000000", networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: "fulfill",
        args: [
          nativeToScVal(requestId, { type: "u64" }),
          proofScVal,
          nativeToScVal(ed25519Sig, { type: "bytes" }),
        ],
      })
    )
    .setTimeout(120)
    .build();

  const fulfillRes = await sendTx(fulfillTx, oracleKp);
  console.log("  Fulfill TX Hash: ", fulfillRes.hash);
  console.log(`  Explorer Link:   https://stellar.expert/explorer/public/tx/${fulfillRes.hash}`);

  // Extract CPU instructions and fee charged
  const envelope = fulfillRes.confirmed.envelopeXdr;
  const txInner = envelope.value().tx();
  const sorobanData = txInner.ext().value();
  const measuredInstructions = sorobanData.resources().instructions();
  const feeCharged = fulfillRes.confirmed.feeCharged;

  console.log(`\n[5/5] Verifying on-chain state and randomness derivation...`);
  const isFulfilled = await simCall("is_fulfilled", [nativeToScVal(requestId, { type: "u64" })]);
  console.log(`  is_fulfilled(${requestId}) = ${isFulfilled}`);

  const betaVal = await simCall("get_beta", [nativeToScVal(requestId, { type: "u64" })]);
  const betaHex = Buffer.from(betaVal).toString("hex");
  console.log(`  get_beta(${requestId})     = ${betaHex}`);

  const u64Val = await simCall("derive_random", [nativeToScVal(requestId, { type: "u64" })]);
  console.log(`  derive_random(${requestId}) = ${u64Val}`);

  const rangeVal = await simCall("derive_random_in_range", [
    nativeToScVal(requestId, { type: "u64" }),
    nativeToScVal(100n, { type: "u64" }),
  ]);
  console.log(`  derive_random_in_range(${requestId}, 100) = ${rangeVal} (uniform in [0, 99])`);

  console.log("\n============================================================");
  console.log("🎉 MAINNET LIVE TEST PASSED COMPLETELY!");
  console.log("============================================================");
  console.log(`Contract ID:       ${CONTRACT_ID}`);
  console.log(`Request TX:        ${reqRes.hash}`);
  console.log(`Fulfill TX:        ${fulfillRes.hash}`);
  console.log(`Drand Round:       ${targetRound}`);
  console.log(`Fee Charged:       ${feeCharged} stroops (~${Number(feeCharged)/1e7} XLM)`);
  console.log(`CPU Instructions:  ${measuredInstructions}`);
  console.log(`Beta Output:       ${betaHex}`);
  console.log(`Derived u64:       ${u64Val}`);
  console.log(`Derived [0..99]:   ${rangeVal}`);
  console.log("============================================================\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
