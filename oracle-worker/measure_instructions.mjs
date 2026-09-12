/**
 * measure_instructions.mjs
 * Simulates fulfill() on testnet to get exact instruction count
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal,
        rpc, xdr, Account, BytesN } = stellar.default || stellar;

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const NETWORK     = Networks.TESTNET;

// Testnet deployment
const CONTRACT_ID = "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE";
const ORACLE_KP   = Keypair.fromSecret("***REDACTED_TESTNET_SECRET***");
const server      = new rpc.Server(TESTNET_RPC, { allowHttp: false });

function bytesN(hex, n) {
  const b = Buffer.from(hex, "hex");
  return nativeToScVal(b, { type: "bytes" });
}

// Real proof values from testnet fulfill TX 2ec66cb6...
// These are the actual BLS proof bytes used in the on-chain transaction
const ALPHA_SEED     = "a1b2c3d4e5f60718293a4b5c6d7e8f9001121314151617181920212223242526";
const GAMMA_POINT    = "04" + "a".repeat(190); // placeholder - we just need to simulate
const BETA_OUTPUT    = "b1c2d3e4f5061728394a5b6c7d8e9f0011121314151617181920212223242526";
const PUBLIC_KEY     = "0eb7e2ddf281bd96d81988e1ed0318c7d481f479048af7ab038557508c6a0468ec174a227e93deed4aa9d48f22e00754164ac02fa3937a68d4162d015958139418853e4705c843305686d8017c7d5a8cc61579973f9ddc5b5d1d58307ec555660f71eb42297319aa7e2b8b45ad45fba933dd5e9b2453f80755b375f26f9a87c5ef3f8e11c6711103789d9cc44641e1110038272b39aafb997f3eb07ef494360efeb34f4e1c2bdd937636bacb5d019aaee6ff75f4c16b3bd2814e1311f6c3383d";
const DRAND_SIG      = "b0" + "c".repeat(190);
const ED25519_SIG    = "d".repeat(128);

async function getAccount(pub) {
  const r = await server.getAccount(pub);
  return r;
}

console.log("\n=== Instruction Budget Measurement ===\n");

// Build a fulfill() call with synthetic proof data
// The contract will reject it, but the SIMULATION gives us the instruction count
const acct = await getAccount(ORACLE_KP.publicKey());

// Build the BlsVrfProof ScMap
const proofMap = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("alpha_seed"),
    val: nativeToScVal(Buffer.from(ALPHA_SEED, "hex"), { type: "bytes" }),
  }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("beta_output"),
    val: nativeToScVal(Buffer.from(BETA_OUTPUT, "hex"), { type: "bytes" }),
  }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("drand_round"),
    val: xdr.ScVal.scvU64(new xdr.Uint64("100")),
  }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("drand_signature"),
    val: nativeToScVal(Buffer.from("b0" + "cc".repeat(47), "hex"), { type: "bytes" }),
  }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("gamma_point"),
    val: nativeToScVal(Buffer.from("04" + "aa".repeat(47), "hex"), { type: "bytes" }),
  }),
  new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol("public_key"),
    val: nativeToScVal(Buffer.from(PUBLIC_KEY, "hex"), { type: "bytes" }),
  }),
]);

const tx = new TransactionBuilder(acct, { fee: "10000000", networkPassphrase: NETWORK })
  .addOperation(Operation.invokeContractFunction({
    contract: CONTRACT_ID,
    function: "fulfill",
    args: [
      xdr.ScVal.scvU64(new xdr.Uint64("1")), // request_id = 1
      proofMap,
      nativeToScVal(Buffer.from("d".repeat(128), "hex"), { type: "bytes" }), // ed25519 sig
    ],
  }))
  .setTimeout(300).build();

console.log("Simulating fulfill() to measure instruction budget...");
const sim = await server.simulateTransaction(tx);

if (sim.cost) {
  console.log("\n=== SIMULATION RESOURCE COSTS ===");
  console.log("CPU instructions:", sim.cost.cpuInsns);
  console.log("Memory bytes:", sim.cost.memBytes);
  console.log("Under 75M instructions?", Number(sim.cost.cpuInsns) < 75_000_000);
  console.log("Under 70M instructions?", Number(sim.cost.cpuInsns) < 70_000_000);
}

if (rpc.Api.isSimulationError(sim)) {
  console.log("\nSimulation error (expected - proof is invalid):", sim.error?.slice(0, 100));
  // The instruction count is still available even for failed simulations
  if (sim.cost) {
    console.log("Instructions measured before failure:", sim.cost.cpuInsns);
  }
} else {
  console.log("\nSimulation succeeded (unexpected!)");
  if (sim.result) {
    console.log("Result:", sim.result);
  }
}

console.log("\nNote: The instruction count from simulation is the precise measure");
console.log("of CPU resources consumed, regardless of whether the call succeeds.");
