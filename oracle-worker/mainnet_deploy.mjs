/**
 * mainnet_deploy.mjs — Deploy and initialize VRF contract on Stellar Mainnet
 *
 * Usage: FEE_AMOUNT_STROOPS=2000000 node mainnet_deploy.mjs
 *
 * FEE_AMOUNT_STROOPS is required and immutable after init(); see below.
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, ".env.mainnet") });

const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/esm/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc, xdr, Account } =
  stellar.default || stellar;

// ── Config ────────────────────────────────────────────────────────────────────
const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const NETWORK     = Networks.PUBLIC;
const server      = new rpc.Server(MAINNET_RPC, { allowHttp: false });

async function getAccount(publicKey) {
  try {
    return await server.getAccount(publicKey);
  } catch (e) {
    const resp = await fetch(`https://horizon.stellar.org/accounts/${publicKey}`);
    if (!resp.ok) throw new Error(`Horizon account not found: ${publicKey}`);
    const data = await resp.json();
    return new Account(publicKey, data.sequence);
  }
}

const ORACLE_SECRET  = process.env.ORACLE_STELLAR_SECRET || process.env.ORACLE_SECRET;
if (!ORACLE_SECRET) { console.error("ERROR: ORACLE_STELLAR_SECRET or ORACLE_SECRET env var is required"); process.exit(1); }
const ORACLE_KP      = Keypair.fromSecret(ORACLE_SECRET);
const ORACLE_PUBLIC  = ORACLE_KP.publicKey();
const ORACLE_ED25519 = ORACLE_KP.rawPublicKey().toString("hex");

// BLS keys (from keygen)
const ORACLE_BLS_PK = "0eb7e2ddf281bd96d81988e1ed0318c7d481f479048af7ab038557508c6a0468ec174a227e93deed4aa9d48f22e00754164ac02fa3937a68d4162d015958139418853e4705c843305686d8017c7d5a8cc61579973f9ddc5b5d1d58307ec555660f71eb42297319aa7e2b8b45ad45fba933dd5e9b2453f80755b375f26f9a87c5ef3f8e11c6711103789d9cc44641e1110038272b39aafb997f3eb07ef494360efeb34f4e1c2bdd937636bacb5d019aaee6ff75f4c16b3bd2814e1311f6c3383d";
// drand quicknet G2 public key — 192 bytes UNCOMPRESSED (required by contract's Bls12381G2Affine::from_bytes)
const DRAND_PK = "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";
const G2_GEN        = "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";

// XLM SAC on mainnet
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

// ── Per-request fee (immutable after init) ──────────────────────────────────
// The requester escrows FEE_AMOUNT_STROOPS in XLM on request(); fulfill()
// releases it to the oracle. The oracle pays the fulfill() network fee
// (measured ~1.39–1.49M stroops on Mainnet, see docs/PROFILING.md). A fee below
// that lets anyone drain the oracle with permissionless requests. The live
// instance CBTCC5QL… was initialised with 0 and can't be changed.
// So this script refuses to deploy unless the fee is set explicitly and covers
// the cost. There is no default.
const MIN_SELF_FUNDING_FEE = 1_500_000n; // 0.15 XLM, ≈ measured fulfill cost + margin
const feeEnv = process.env.FEE_AMOUNT_STROOPS;
if (!feeEnv || !/^\d+$/.test(feeEnv)) {
  console.error(
    "ERROR: set FEE_AMOUNT_STROOPS (integer stroops, e.g. 2000000 = 0.2 XLM).\n" +
      "       It is immutable after init() and must cover the oracle's fulfill() cost."
  );
  process.exit(1);
}
const FEE_AMOUNT = BigInt(feeEnv);
if (FEE_AMOUNT < MIN_SELF_FUNDING_FEE && process.env.ALLOW_UNFUNDED_FEE !== "yes-i-accept-oracle-drain") {
  console.error(
    `ERROR: FEE_AMOUNT_STROOPS=${FEE_AMOUNT} is below the fulfill cost (${MIN_SELF_FUNDING_FEE}).\n` +
      "       Requests would not pay for themselves and the oracle could be drained by spam.\n" +
      "       To deploy anyway (e.g. a private/allowlisted instance), also set\n" +
      "       ALLOW_UNFUNDED_FEE=yes-i-accept-oracle-drain and run the worker fee guard."
  );
  process.exit(1);
}
const WASM_PATH = path.resolve(__dirname, "../soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.optimized.wasm");

// ── Helpers ───────────────────────────────────────────────────────────────────
function bytesVal(hex) {
  return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}
function u64Val(n) {
  return xdr.ScVal.scvU64(BigInt(n));
}
function u32Val(n) {
  return xdr.ScVal.scvU32(Number(n));
}
function i128Val(n) {
  return nativeToScVal(n, { type: "i128" });
}

async function pollTx(hash) {
  process.stdout.write("  Confirming");
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await server.getTransaction(hash);
    if (s.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" ✔\n");
      return s;
    }
    if (s.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" ✖\n");
      throw new Error(`TX FAILED: ${hash} — ${JSON.stringify(s.resultXdr || s.errorResult || s)}`);
    }
    process.stdout.write(".");
  }
  throw new Error("Timeout: " + hash);
}

async function simAndSend(signerKP, contractId, fn, fnArgs) {
  const account = await getAccount(signerKP.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args: fnArgs }))
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Sim error: ${JSON.stringify(sim.error)}`);

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signerKP);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`Send error: ${JSON.stringify(sent.errorResult)}`);
  console.log(`  TX: https://stellar.expert/explorer/public/tx/${sent.hash}`);
  return pollTx(sent.hash);
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("\n=== Stellar VRF Oracle — Mainnet Deployment ===\n");
console.log(`Oracle: ${ORACLE_PUBLIC}`);

// 1. Check account
console.log("\n[1/4] Checking account...");
const acct = await getAccount(ORACLE_PUBLIC);
console.log(`  Sequence: ${acct.sequence}`);
console.log("  Account OK ✔");

// 2. Upload WASM
console.log("\n[2/4] Uploading WASM...");
if (!fs.existsSync(WASM_PATH)) {
  console.error("WASM not found:", WASM_PATH);
  console.error("Run: cd soroban-contract && cargo build --release --target wasm32v1-none");
  process.exit(1);
}
const wasmBytes = fs.readFileSync(WASM_PATH);
const expectedWasmHash = crypto.createHash("sha256").update(wasmBytes).digest();
console.log(`  WASM size: ${wasmBytes.length} bytes`);
console.log(`  WASM sha256: ${expectedWasmHash.toString("hex")}`);

const uploadAcct = await getAccount(ORACLE_PUBLIC);
const uploadTx = new TransactionBuilder(uploadAcct, { fee: "1000000", networkPassphrase: NETWORK })
  .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
  .setTimeout(300)
  .build();

const uploadSim = await server.simulateTransaction(uploadTx);
if (rpc.Api.isSimulationError(uploadSim)) throw new Error("Upload sim: " + JSON.stringify(uploadSim.error));

const uploadPrep = rpc.assembleTransaction(uploadTx, uploadSim).build();
uploadPrep.sign(ORACLE_KP);
const uploadSent = await server.sendTransaction(uploadPrep);
if (uploadSent.status === "ERROR") throw new Error("Upload send: " + JSON.stringify(uploadSent.errorResult));
console.log(`  TX: https://stellar.expert/explorer/public/tx/${uploadSent.hash}`);
const uploadRes = await pollTx(uploadSent.hash);

let wasmHash = expectedWasmHash;
try {
  const metaBytes = uploadRes.resultMetaXdr?.v3?.()?.sorobanMeta?.()?.returnValue?.()?.bytes?.();
  if (metaBytes) wasmHash = Buffer.from(metaBytes);
} catch (e) {
  // Use sha256
}
console.log(`  WASM hash: ${wasmHash.toString("hex")}`);

// 3. Deploy contract instance
console.log("\n[3/4] Deploying contract instance...");
const salt = crypto.randomBytes(32);
console.log(`  Salt (hex): ${salt.toString("hex")}`);

const deployAcct = await getAccount(ORACLE_PUBLIC);
const deployTx = new TransactionBuilder(deployAcct, { fee: "1000000", networkPassphrase: NETWORK })
  .addOperation(Operation.createCustomContract({
    wasmHash: wasmHash,
    address: new Address(ORACLE_PUBLIC),
    salt: salt,
  }))
  .setTimeout(300)
  .build();

const deploySim = await server.simulateTransaction(deployTx);
if (rpc.Api.isSimulationError(deploySim)) throw new Error("Deploy sim: " + JSON.stringify(deploySim.error));

const deployPrep = rpc.assembleTransaction(deployTx, deploySim).build();
deployPrep.sign(ORACLE_KP);
const deploySent = await server.sendTransaction(deployPrep);
if (deploySent.status === "ERROR") throw new Error("Deploy send: " + JSON.stringify(deploySent.errorResult));
console.log(`  TX: https://stellar.expert/explorer/public/tx/${deploySent.hash}`);
const deployRes = await pollTx(deploySent.hash);

let contractId;
try {
  const returnVal = deployRes.resultMetaXdr.v3().sorobanMeta().returnValue();
  contractId = Address.fromScVal(returnVal).toString();
} catch (e) {
  if (deploySim.result?.retval) {
    contractId = Address.fromScVal(deploySim.result.retval).toString();
  } else {
    contractId = deploySim.result?.auth?.[0]?.rootInvocation()?.function()?.contractAddress()?.toString();
  }
}

if (!contractId) throw new Error("Could not extract contract ID from deploy result");
console.log(`  CONTRACT ID: ${contractId}`);

// 4. Init
console.log("\n[4/4] Initializing contract...");
const initRes = await simAndSend(ORACLE_KP, contractId, "init", [
  bytesVal(ORACLE_BLS_PK),
  new Address(ORACLE_PUBLIC).toScVal(),
  bytesVal(ORACLE_ED25519),
  bytesVal(DRAND_PK),
  bytesVal(G2_GEN),
  u64Val(1692803367n),
  u32Val(3),
  u32Val(2),
  new Address(XLM_SAC).toScVal(),
  i128Val(FEE_AMOUNT),
]);

const deployedRecord = {
  contractAddress: contractId,
  wasmHash: wasmHash.toString("hex"),
  deployerPublicKey: ORACLE_PUBLIC,
  oraclePublicKeyHex: ORACLE_BLS_PK,
  oracleStellarAddress: ORACLE_PUBLIC,
  oracleEd25519Hex: ORACLE_ED25519,
  network: "mainnet",
  sorobanRpcUrl: MAINNET_RPC,
  deployedAt: new Date().toISOString(),
  explorerUrl: `https://stellar.expert/explorer/public/contract/${contractId}`,
  uploadTxHash: uploadSent.hash,
  deployTxHash: deploySent.hash,
  initTxHash: initRes.hash || "confirmed",
  feeAmountStroops: FEE_AMOUNT.toString(),
  securityFeatures: [
    "require_auth() — only oracle address can call fulfill()",
    "requester == callback_contract — prevents confused-deputy callback attacks",
    "MAX_CONTEXT_LEN = 1024 cap on user context",
    "PK match — proof.public_key must equal stored oracle BLS12-381 PK",
    "Ed25519 signature — proof data signed by oracle Ed25519 key, verified on-chain",
    "Alpha binding — alpha = sha256(context || round || sha256(drand_signature))",
    "On-chain BLS verification — drand + VRF pairing checks",
    "Future round enforcement — round_offset >= 2"
  ]
};

fs.writeFileSync(
  path.resolve(__dirname, "../soroban-contract/deployed.json"),
  JSON.stringify(deployedRecord, null, 2),
  "utf8"
);
fs.writeFileSync(
  path.resolve(__dirname, "deployed.mainnet.json"),
  JSON.stringify(deployedRecord, null, 2),
  "utf8"
);

console.log("\n╔═══════════════════════════════════════════════════════════╗");
console.log("║           MAINNET DEPLOYMENT COMPLETE ✅                  ║");
console.log("╠═══════════════════════════════════════════════════════════╣");
console.log(`║ Contract:  ${contractId}`);
console.log(`║ Oracle:    ${ORACLE_PUBLIC}`);
console.log(`║ Upload TX: https://stellar.expert/explorer/public/tx/${uploadSent.hash}`);
console.log(`║ Deploy TX: https://stellar.expert/explorer/public/tx/${deploySent.hash}`);
console.log(`║ Explorer:  https://stellar.expert/explorer/public/contract/${contractId}`);
console.log("╚═══════════════════════════════════════════════════════════╝\n");

