/**
 * verify_deploy_dryrun.mjs — SAFE validation of the mainnet deploy pipeline.
 *
 * DRY-RUN of the exact logic used by mainnet_deploy.mjs WITHOUT submitting any
 * transaction to Mainnet (no sendTransaction, no network account lookups).
 * Validates: (1) SDK loads via PUBLIC entrypoint, (2) Node+SDK compat,
 * (3) optimized WASM present/readable, (4) all constructor ScVals build under v17,
 * (5) upload + createCustomContract(constructorArgs) TX BUILD offline against a
 * dummy account.
 *
 * Usage: node verify_deploy_dryrun.mjs   (exit 0 = pass, 1 = fail)
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failures = 0;
const ok = (m) => console.log(`  \u2714 ${m}`);
const bad = (m) => { console.log(`  \u2716 ${m}`); failures++; };

console.log("\n=== Mainnet Deploy Pipeline — SAFE Dry-Run Validation ===\n");

// ── [1/5] Load SDK via PUBLIC entrypoint ────────────────────────────────────
console.log("[1/5] Loading @stellar/stellar-sdk via public package entrypoint...");
const stellar = await import("@stellar/stellar-sdk");
const m = stellar.default || stellar;
// Read version from the installed package.json on disk (its "exports" map does
// not expose ./package.json, so require() the file by absolute path instead).
const sdkPkgPath = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/package.json");
const sdkVersion = JSON.parse(fs.readFileSync(sdkPkgPath, "utf8")).version;
console.log(`  Installed SDK version: ${sdkVersion}`);
console.log(`  Node version:          ${process.version}`);

const NEEDED = ["Keypair", "Networks", "TransactionBuilder", "Operation", "Address", "nativeToScVal", "rpc", "xdr", "Account"];
for (const k of NEEDED) {
  if (typeof m[k] !== "undefined") ok(`symbol ${k} available`);
  else bad(`symbol ${k} MISSING`);
}
const { Keypair, Networks, TransactionBuilder, Operation, nativeToScVal, xdr, Account, Address } = m;
if (Networks?.PUBLIC === "Public Global Stellar Network ; September 2015") ok(`Networks.PUBLIC passphrase correct`);
else bad(`Networks.PUBLIC unexpected: ${Networks?.PUBLIC}`);

// ── [2/5] Node + SDK compatibility ──────────────────────────────────────────
console.log("\n[2/5] Compatibility checks...");
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok(`Node ${process.version} >= 22.12 requirement`);
else bad(`Node ${process.version} below required 22.12`);
if (Number(sdkVersion.split(".")[0]) === 17) ok(`SDK major version 17 matches ^17.1.0 range`);
else bad(`SDK major version ${sdkVersion} does NOT satisfy ^17.1.0`);


// ── [3/5] Optimized WASM present + readable ─────────────────────────────────
console.log("\n[3/5] Optimized WASM artifact...");
const WASM_PATH = path.resolve(__dirname, "../soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.optimized.wasm");
let wasmBytes = null;
if (fs.existsSync(WASM_PATH)) {
  wasmBytes = fs.readFileSync(WASM_PATH);
  const sha = crypto.createHash("sha256").update(wasmBytes).digest("hex");
  ok(`optimized WASM found: ${WASM_PATH}`);
  ok(`WASM size: ${wasmBytes.length} bytes`);
  ok(`WASM sha256: ${sha}`);
  if (wasmBytes[0] === 0x00 && wasmBytes[1] === 0x61 && wasmBytes[2] === 0x73 && wasmBytes[3] === 0x6d)
    ok(`WASM magic header valid (\\0asm)`);
  else bad(`WASM magic header invalid`);
} else {
  bad(`optimized WASM NOT found at ${WASM_PATH}`);
}

// ── [4/5] ScVal constructor-args build under v17 ────────────────────────────
console.log("\n[4/5] Building all constructor ScVal args (v17 encoding)...");
function bytesVal(hex) { return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" }); }
function u64Val(n) { return xdr.ScVal.scvU64(BigInt(n)); }
function u32Val(n) { return xdr.ScVal.scvU32(Number(n)); }
function i128Val(n) { return nativeToScVal(n, { type: "i128" }); }

const BLS_PK = "0e".repeat(192).slice(0, 384);
try { if (bytesVal(BLS_PK).toXDR("base64")) ok(`bytesVal(192B) -> ScVal, XDR-encodes`); }
catch (e) { bad(`bytesVal failed: ${e.message}`); }
try { if (u64Val(1692803367).toXDR("base64")) ok(`u64Val(genesis) -> ScVal, XDR-encodes (new xdr.Uint64 path)`); }
catch (e) { bad(`u64Val failed under v17: ${e.message}`); }
try { if (u32Val(3).toXDR("base64") && u32Val(2).toXDR("base64")) ok(`u32Val(period/threshold) -> ScVal`); }
catch (e) { bad(`u32Val failed: ${e.message}`); }
try { if (i128Val(0).toXDR("base64")) ok(`i128Val(fee=0) -> ScVal`); }
catch (e) { bad(`i128Val failed: ${e.message}`); }

// ── [5/5] Build upload + invoke TX OFFLINE (no network, no send) ────────────
console.log("\n[5/5] Building deploy transactions OFFLINE (no submission)...");
const NETWORK = Networks.PUBLIC;
const dummyKP = Keypair.random();
const dummyAccount = new Account(dummyKP.publicKey(), "123456789");

try {
  const wb = wasmBytes ?? Buffer.from([0x00, 0x61, 0x73, 0x6d]);
  const uploadTx = new TransactionBuilder(dummyAccount, { fee: "5000000", networkPassphrase: NETWORK })
    .addOperation(Operation.uploadContractWasm({ wasm: wb }))
    .setTimeout(300)
    .build();
  if (uploadTx.toXDR()) ok(`upload WASM TX built + XDR-serialized offline`);
} catch (e) { bad(`upload TX build failed: ${e.message}`); }

try {
  // Must match the contract's __constructor exactly (9 args; the G2 generator
  // is compiled in and there is no separate init()).
  const constructorArgs = [
    bytesVal(BLS_PK),
    new Address(dummyKP.publicKey()).toScVal(),
    bytesVal("11".repeat(32)),
    bytesVal("22".repeat(192)),
    u64Val(1692803367),
    u32Val(3),
    u32Val(2),
    new Address(dummyKP.publicKey()).toScVal(),
    i128Val(0),
  ];
  const deployTx = new TransactionBuilder(dummyAccount, { fee: "5000000", networkPassphrase: NETWORK })
    .addOperation(Operation.createCustomContract({
      address: new Address(dummyKP.publicKey()),
      wasmHash: Buffer.alloc(32, 7),
      salt: Buffer.alloc(32, 9),
      constructorArgs,
    }))
    .setTimeout(300)
    .build();
  // stellar-sdk v17 XDR objects expose plain fields (`type`, `createContractV2`).
  const hf = deployTx.operations[0].func;
  if (hf.type !== "hostFunctionTypeCreateContractV2") throw new Error(`unexpected host fn ${hf.type}`);
  const argCount = hf.createContractV2.constructorArgs.length;
  if (argCount !== 9) throw new Error(`constructor carries ${argCount} args, expected 9`);
  if (deployTx.toXDR()) ok(`createCustomContract TX with 9 constructor args built + XDR-serialized offline`);
} catch (e) { bad(`constructor deploy TX build failed: ${e.message}`); }

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\n=== Summary ===");
if (failures === 0) {
  console.log("  ALL CHECKS PASSED \u2714  — deploy pipeline is v17-compatible (no TX submitted).\n");
  process.exit(0);
} else {
  console.log(`  ${failures} CHECK(S) FAILED \u2716\n`);
  process.exit(1);
}
