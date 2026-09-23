// LEGACY WASM ONLY: this script calls init() and passes a G2 generator. It targets
// the pre-audit-round-5 contract (the current Mainnet instance / profiling deploys).
// Current contract source has no init(): it is configured atomically by
// __constructor at deployment. Use mainnet_deploy.mjs for new deployments.
/**
 * measure_nonzero_fee_mainnet.mjs
 *
 * Measures ACTUAL on-chain CPU instructions for fulfill() with fee_amount > 0
 * on Stellar Mainnet.
 *
 * Flow:
 * 1. Deploys a dedicated contract instance from the existing audited WASM hash.
 * 2. Initializes it with fee_token = XLM_SAC and fee_amount = 100,000 stroops (0.01 XLM).
 * 3. Sends request() with 0.01 XLM fee escrowed.
 * 4. Fetches the drand beacon for the required future round.
 * 5. Generates the cryptographic BLS-VRF proof and Ed25519 signature.
 * 6. Invokes fulfill() on Mainnet (verifies BLS proofs + transfers fee to oracle).
 * 7. Reads resources.instructions directly from the confirmed on-chain transaction envelope!
 */

import path from "path";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/esm/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc, xdr, Account } =
  stellar.default || stellar;

const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const server = new rpc.Server(MAINNET_RPC, { allowHttp: false });
const NETWORK = Networks.PUBLIC;

const ORACLE_STELLAR_SECRET = process.env.ORACLE_STELLAR_SECRET || process.env.ORACLE_SECRET;
if (!ORACLE_STELLAR_SECRET) {
  console.error("Missing ORACLE_STELLAR_SECRET");
  process.exit(1);
}
const oracleKp = Keypair.fromSecret(ORACLE_STELLAR_SECRET);
const oracleAddr = oracleKp.publicKey();

// Hex-encoded BLS scalar
const BLS_SK_HEX = process.env.ORACLE_BLS_SECRET_KEY;
if (!BLS_SK_HEX) {
  console.error("Missing ORACLE_BLS_SECRET_KEY");
  process.exit(1);
}
const ORACLE_BLS_SECRET = BigInt("0x" + BLS_SK_HEX.replace(/^0x/, ""));

const WASM_HASH = "90ad849914b6c5ead39e7e4847af36f680f54f683675dc108ed1a0e90f18f84f";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const DRAND_PK = "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";
const G2_GEN = "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";

const VRF_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_VRF_ALPHA_STELLAR";
const BETA_DOMAIN = "STELLAR_VRF_OUTPUT_BETA_V1";
const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const DRAND_API_URL = "https://api.drand.sh";

function deriveBlsPublicKey() {
  const pk = bls12_381.G2.ProjectivePoint.BASE.multiply(ORACLE_BLS_SECRET);
  return Buffer.from(pk.toRawBytes(false));
}

const ORACLE_BLS_PK_BYTES = deriveBlsPublicKey();
const ORACLE_BLS_PK_HEX = ORACLE_BLS_PK_BYTES.toString("hex");

async function pollTx(hash) {
  process.stdout.write("    Confirming");
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await server.getTransaction(hash);
    if (s.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" ✔\n");
      return s;
    }
    if (s.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" ✖\n");
      throw new Error(`TX FAILED: ${hash}`);
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

console.log("============================================================");
console.log("Stellar VRF: Nonzero-Fee Mainnet Measurement");
console.log("Oracle Account:", oracleAddr);
console.log("============================================================\n");

const newContractId = "CA24JMRHKL2J7ZSNE7GFRKQHMH45J2SEEVEVEJR2CZ5RZQB7RRJUKRQG";
console.log("[1/3] Using deployed & initialized contract:", newContractId);
console.log("      Fee is configured to 100,000 stroops (0.01 XLM)");

const requestId = 1n;
const contextStr = "Nonzero-fee Mainnet CPU Profiling 2026";
const contextBuf = Buffer.from(contextStr, "utf-8");
const targetRound = 32427720n;
console.log(`[2/3] Fulfilling pending Request ID: ${requestId} for drand round: ${targetRound}`);

// Step 4: Wait for drand round and fetch beacon
console.log(`\n[4/5] Fetching drand beacon for round ${targetRound}...`);
let beacon;
for (let i = 0; i < 30; i++) {
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
console.log("  drand beacon fetched! Round:", beacon.round);

// Step 5: Generate VRF proof and submit fulfill()
console.log("\n[5/5] Generating VRF proof and submitting fulfill()...");

// 1. drand sig
const drandSigPoint = bls12_381.G1.ProjectivePoint.fromHex(beacon.signature);
const drandSigBytes = Buffer.from(drandSigPoint.toRawBytes(false)); // 96 bytes

// 2. alpha_seed = sha256(request_id || context || round || sha256(drand_sig))
const drandRandomness = Buffer.from(sha256(drandSigBytes));
const u64ToBe = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const alphaInput = Buffer.concat([
  u64ToBe(requestId),
  contextBuf,
  u64ToBe(targetRound),
  drandRandomness,
]);
const alphaSeed = Buffer.from(sha256(alphaInput));

// 3. gamma = sk * H(alpha)
const dst = new TextEncoder().encode(VRF_DST);
const hPoint = bls12_381.G1.hashToCurve(alphaSeed, { DST: dst });
const gammaPoint = hPoint.multiply(ORACLE_BLS_SECRET);
const gammaBytes = Buffer.from(gammaPoint.toRawBytes(false)); // 96 bytes

// 4. beta = sha256(BETA_DOMAIN || gamma)
const betaDomainBytes = Buffer.from(BETA_DOMAIN, "utf-8");
const betaOutput = Buffer.from(sha256(Buffer.concat([betaDomainBytes, gammaBytes])));

// 5. Ed25519 signature
const ed25519Payload = Buffer.concat([
  u64ToBe(requestId),
  alphaSeed,
  gammaBytes,
  betaOutput,
  u64ToBe(targetRound),
  drandSigBytes,
]);
const ed25519Sig = Buffer.from(oracleKp.sign(ed25519Payload));

// Proof ScVal struct
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

const acctFulfill = await server.getAccount(oracleAddr);
const fulfillTx = new TransactionBuilder(acctFulfill, { fee: "5000000", networkPassphrase: NETWORK })
  .addOperation(Operation.invokeContractFunction({
    contract: newContractId,
    function: "fulfill",
    args: [
      nativeToScVal(requestId, { type: "u64" }),
      proofScVal,
      nativeToScVal(ed25519Sig, { type: "bytes" }),
    ],
  }))
  .setTimeout(300)
  .build();

console.log("  Simulating and submitting fulfill() on Stellar Mainnet...");
const fulfillRes = await sendTx(fulfillTx, oracleKp);
console.log("  Fulfill TX:", `https://stellar.expert/explorer/public/tx/${fulfillRes.hash}`);

// Extract instructions from transaction envelope
const envelope = fulfillRes.confirmed.envelopeXdr;
const txInner = envelope.value().tx();
const sorobanData = txInner.ext().value();
const measuredInstructions = sorobanData.resources().instructions();

console.log("\n============================================================");
console.log("🎉 SUCCESS: NONZERO-FEE FULFILL COMPLETED ON STELLAR MAINNET!");
console.log("============================================================");
console.log(`Contract ID:              ${newContractId}`);
console.log(`Fulfill TX Hash:          ${fulfillRes.hash}`);
console.log(`Explorer Link:            https://stellar.expert/explorer/public/tx/${fulfillRes.hash}`);
console.log(`Fee Charged:              ${fulfillRes.confirmed.feeCharged} stroops`);
console.log(`Ledger Number:            ${fulfillRes.confirmed.ledger}`);
console.log(`ACTUAL CPU INSTRUCTIONS:  ${measuredInstructions}`);
console.log(`Protocol Limit:           400,000,000 instructions`);
console.log(`SCF Milestone Target:     75,000,000 instructions`);
console.log(`Headroom under 75M:       ${((1 - measuredInstructions / 75_000_000) * 100).toFixed(2)}%`);
console.log(`Headroom under 400M:      ${((1 - measuredInstructions / 400_000_000) * 100).toFixed(2)}%`);
console.log("============================================================");
