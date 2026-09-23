/**
 * mainnet_deploy.mjs — Deploy the VRF contract on Stellar Mainnet (configured atomically by its constructor)
 *
 * Usage:
 *   DRY_RUN=1 FEE_AMOUNT_STROOPS=2000000 node mainnet_deploy.mjs   # preflight only
 *   FEE_AMOUNT_STROOPS=2000000 node mainnet_deploy.mjs             # deploy
 *
 * FEE_AMOUNT_STROOPS is required and immutable after deployment; see below.
 *
 * Configuration precedence (highest first):
 *   1. the shell environment (explicit, e.g. `FEE_AMOUNT_STROOPS=… node …`)
 *   2. `.env.mainnet`   — Mainnet-specific values
 *   3. `.env`           — shared worker config (only fills what is still unset)
 * dotenv never overwrites, and this script used to load `.env` FIRST, so a
 * testnet value in `.env` silently beat `.env.mainnet`. The effective value of
 * every deploy-relevant variable and its source are printed in the preflight
 * before anything is sent (use DRY_RUN=1 to stop there).
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { bls12_381 } from "@noble/curves/bls12-381";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_MAINNET = path.resolve(__dirname, ".env.mainnet");
const ENV_SHARED = path.resolve(__dirname, ".env");

// Record where each deploy-relevant variable comes from, then load.
const TRACKED = ["ORACLE_STELLAR_SECRET", "ORACLE_SECRET", "ORACLE_BLS_SECRET_KEY", "ORACLE_BLS_PK", "FEE_AMOUNT_STROOPS", "ALLOW_UNFUNDED_FEE", "NETWORK_PASSPHRASE"];
const source = Object.fromEntries(TRACKED.filter((k) => process.env[k] !== undefined).map((k) => [k, "shell"]));
function load(file) {
  if (!fs.existsSync(file)) return;
  const parsed = dotenv.parse(fs.readFileSync(file));
  for (const k of TRACKED) {
    if (parsed[k] !== undefined && process.env[k] === undefined) source[k] = path.basename(file);
  }
  dotenv.config({ path: file }); // never overrides what is already set
}
load(ENV_MAINNET); // most specific file first, so it wins over .env
load(ENV_SHARED);

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");

const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/esm/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, scValToNative, rpc, xdr, Account } =
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

if (process.env.NETWORK_PASSPHRASE && process.env.NETWORK_PASSPHRASE !== NETWORK) {
  console.error(
    `ERROR: NETWORK_PASSPHRASE (from ${source.NETWORK_PASSPHRASE}) is "${process.env.NETWORK_PASSPHRASE}", ` +
      `but this script deploys to Mainnet ("${NETWORK}"). Fix .env.mainnet.`
  );
  process.exit(1);
}

// ── Oracle BLS public key: DERIVED from the secret the worker will use ──────
// It used to be a hard-coded constant here, so rotating ORACLE_BLS_SECRET_KEY
// without editing this file deployed a contract whose oracle key the worker
// could never satisfy (every fulfill() would fail "oracle key mismatch").
// Now it is derived exactly like the worker does (src/vrf.ts:
// deriveBlsPublicKey), and an optional pinned ORACLE_BLS_PK must match.
const BLS_SK_HEX = (process.env.ORACLE_BLS_SECRET_KEY ?? "").trim().replace(/^0x/, "");
if (!/^[0-9a-fA-F]{1,64}$/.test(BLS_SK_HEX)) {
  console.error("ERROR: ORACLE_BLS_SECRET_KEY (hex scalar from `npm run keygen`) is required");
  process.exit(1);
}
const BLS_SK = BigInt("0x" + BLS_SK_HEX);
if (BLS_SK === 0n || BLS_SK >= bls12_381.G2.CURVE.n) {
  console.error("ERROR: ORACLE_BLS_SECRET_KEY is not a valid BLS12-381 scalar (0 < sk < r)");
  process.exit(1);
}
const ORACLE_BLS_PK = Buffer.from(
  bls12_381.G2.ProjectivePoint.BASE.multiply(BLS_SK).toRawBytes(false)
).toString("hex");
const PINNED_BLS_PK = (process.env.ORACLE_BLS_PK ?? "").trim().toLowerCase().replace(/^0x/, "");
if (PINNED_BLS_PK && PINNED_BLS_PK !== ORACLE_BLS_PK) {
  console.error(
    `ERROR: ORACLE_BLS_PK (from ${source.ORACLE_BLS_PK}) does not match the public key derived from ` +
      `ORACLE_BLS_SECRET_KEY (from ${source.ORACLE_BLS_SECRET_KEY}).\n` +
      `       pinned : ${PINNED_BLS_PK.slice(0, 32)}…\n` +
      `       derived: ${ORACLE_BLS_PK.slice(0, 32)}…\n` +
      "       The worker would be unable to fulfill any request. Refusing to deploy."
  );
  process.exit(1);
}
// drand quicknet G2 public key — 192 bytes UNCOMPRESSED (required by contract's Bls12381G2Affine::from_bytes)
const DRAND_PK = "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";

// XLM SAC on mainnet
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

// ── Per-request fee (immutable after deployment) ──────────────────────────────────
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
      "       It is immutable after deployment and must cover the oracle's fulfill() cost."
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

// ── Preflight: show exactly what will be deployed, and from where ──────────
const src = (k) => source[k] ?? "unset";
console.log("\n=== Preflight (effective configuration) ===");
console.log(`  Network            : ${NETWORK}`);
console.log(`  RPC                : ${MAINNET_RPC}`);
console.log(`  Oracle account     : ${ORACLE_PUBLIC}   [${src(process.env.ORACLE_STELLAR_SECRET ? "ORACLE_STELLAR_SECRET" : "ORACLE_SECRET")}]`);
console.log(`  Oracle BLS pk      : ${ORACLE_BLS_PK.slice(0, 32)}…   [derived from ORACLE_BLS_SECRET_KEY, ${src("ORACLE_BLS_SECRET_KEY")}]${PINNED_BLS_PK ? " (matches pinned ORACLE_BLS_PK)" : ""}`);
console.log(`  Fee token          : ${XLM_SAC} (native XLM SAC)`);
console.log(`  Fee amount         : ${FEE_AMOUNT} stroops   [${src("FEE_AMOUNT_STROOPS")}]${FEE_AMOUNT < MIN_SELF_FUNDING_FEE ? "  ⚠ UNFUNDED (override set)" : ""}`);
console.log(`  WASM               : ${WASM_PATH}`);
if (DRY_RUN) {
  console.log("\nDRY_RUN set: nothing was sent. Re-run without DRY_RUN to deploy.");
  process.exit(0);
}

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

/** Read-only contract call via simulation (nothing is signed or sent). */
async function simRead(publicKey, contractId, fn, fnArgs) {
  const account = await getAccount(publicKey);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args: fnArgs }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Sim error (${fn}): ${JSON.stringify(sim.error)}`);
  return scValToNative(sim.result.retval);
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
console.log("\n[3/4] Deploying + configuring contract instance (constructor)...");
const salt = crypto.randomBytes(32);
console.log(`  Salt (hex): ${salt.toString("hex")}`);

// Deploy + configure in ONE operation: the contract's `__constructor` runs as
// part of creation, so there is no window in which an uninitialised instance
// exists and someone else could call an `init()` first (there is no init()).
// The G2 generator is compiled into the contract and no longer passed.
const constructorArgs = [
  bytesVal(ORACLE_BLS_PK),
  new Address(ORACLE_PUBLIC).toScVal(),
  bytesVal(ORACLE_ED25519),
  bytesVal(DRAND_PK),
  u64Val(1692803367n),
  u32Val(3),
  u32Val(2),
  new Address(XLM_SAC).toScVal(),
  i128Val(FEE_AMOUNT),
];

const deployAcct = await getAccount(ORACLE_PUBLIC);
const deployTx = new TransactionBuilder(deployAcct, { fee: "1000000", networkPassphrase: NETWORK })
  .addOperation(Operation.createCustomContract({
    wasmHash: wasmHash,
    address: new Address(ORACLE_PUBLIC),
    salt: salt,
    constructorArgs,
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

// 4. Verify the constructor stored what we passed (read-only simulation).
console.log("\n[4/4] Verifying constructor configuration...");
const storedPkHex = Buffer.from(await simRead(ORACLE_PUBLIC, contractId, "oracle_pk", [])).toString("hex");
if (storedPkHex !== ORACLE_BLS_PK) {
  throw new Error(`Constructor check failed: oracle_pk() = ${storedPkHex.slice(0, 32)}…, expected ${ORACLE_BLS_PK.slice(0, 32)}…`);
}
const storedOracle = await simRead(ORACLE_PUBLIC, contractId, "oracle_address", []);
if (storedOracle !== ORACLE_PUBLIC) {
  throw new Error(`Constructor check failed: oracle_address() = ${storedOracle}, expected ${ORACLE_PUBLIC}`);
}
console.log("  oracle_pk() and oracle_address() match the constructor arguments ✔");

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
  configuredBy: "__constructor (atomic with deployment)",
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

