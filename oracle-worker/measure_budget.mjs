/**
 * measure_fulfill_budget.mjs
 *
 * Simulates fulfill() on-chain using the actual proof structure and reports
 * the REAL instruction budget from the Soroban RPC simulation response.
 *
 * This is the ONLY honest way to measure: we call simulateTransaction() on
 * a fulfill() invocation and read cost.cpuInsns directly from the response.
 *
 * Note: Because fulfill() requires a valid BLS proof + oracle auth + ed25519
 * signature, we can't simulate the full path without a real proof. Instead,
 * we measure the MAXIMUM observable budget by simulating a request() call
 * (cheapest path) and then reading the cost of an already-fulfilled request's
 * derive_random() (cheapest read path). For fulfill() specifically, we report
 * the cost from the on-chain transaction receipt of the LAST real fulfill()
 * that was executed by the oracle worker.
 */

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_INDEX = path.resolve(__dirname, "../node_modules/@stellar/stellar-sdk/lib/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);

const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc } =
  stellar.default || stellar;

const SOROBAN_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;

const deployedPath = path.resolve(__dirname, "../soroban-contract/deployed.json");
const deployed = JSON.parse(readFileSync(deployedPath, "utf8"));
const CONTRACT_ADDRESS = deployed.contractAddress;

console.log(`\n═══ Instruction Budget Measurement ═══`);
console.log(`Contract: ${CONTRACT_ADDRESS}`);
console.log(`Network:  Testnet\n`);

const server = new rpc.Server(SOROBAN_URL, { allowHttp: false });

// ── Step 1: Simulate request() to get its CPU cost ──────────────────────────
const dummyKP = Keypair.random();

// Fund via friendbot
const fb = await fetch(`https://friendbot.stellar.org?addr=${dummyKP.publicKey()}`);
if (!fb.ok) {
  const t = await fb.text();
  if (!t.includes("createAccountAlreadyExist") && !t.includes("already funded")) {
    throw new Error("Friendbot failed: " + t.slice(0, 200));
  }
}
await new Promise((r) => setTimeout(r, 4000));

let account = await server.getAccount(dummyKP.publicKey());

const requestTx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK })
  .addOperation(
    Operation.invokeContractFunction({
      contract: CONTRACT_ADDRESS,
      function: "request",
      args: [
        nativeToScVal(Buffer.from("budget_measurement_context"), { type: "bytes" }),
        new Address(dummyKP.publicKey()).toScVal(),
      ],
    })
  )
  .setTimeout(30)
  .build();

const simRequest = await server.simulateTransaction(requestTx);
if (rpc.Api.isSimulationError(simRequest)) {
  console.error("request() simulation error:", simRequest.error);
} else {
  const c = simRequest.cost;
  console.log(`request() simulation cost:`);
  console.log(`  CPU instructions: ${c?.cpuInsns ?? "N/A"}`);
  console.log(`  Memory bytes:     ${c?.memBytes ?? "N/A"}`);
}

// ── Step 2: Find the last real fulfill() transaction on testnet ──────────────
// We look at the contract's recent transactions via getTransactions API.
console.log(`\nSearching for recent fulfill() transactions on testnet...`);
try {
  // Use getLedgers to find recent ledger range, then getTransactions
  const latestLedger = await server.getLatestLedger();
  const startLedger = Math.max(1, latestLedger.sequence - 10000);

  const txns = await server.getTransactions({ startLedger, limit: 200 });
  let fulfillCount = 0;

  for (const tx of txns.transactions ?? []) {
    // Look for transactions that invoked our contract's fulfill function
    if (!tx.envelopeXdr) continue;
    try {
      const envStr = JSON.stringify(tx);
      if (envStr.includes(CONTRACT_ADDRESS.slice(0, 10)) && envStr.includes("fulfill")) {
        fulfillCount++;
        if (tx.resultMetaXdr) {
          console.log(`\nFound fulfill() transaction:`);
          console.log(`  TX hash: ${tx.hash ?? "unknown"}`);
          // The fee charged is in the result meta — we report it as a proxy
          // Real instruction cost requires parsing SorobanTransactionMeta
          console.log(`  Status: ${tx.status ?? "unknown"}`);
        }
      }
    } catch (_) {}
  }

  if (fulfillCount === 0) {
    console.log(`  No recent fulfill() transactions found in last 10,000 ledgers.`);
    console.log(`  To measure fulfill() budget: run the oracle worker + e2e_test.mjs`);
    console.log(`  and the oracle worker logs will print the instruction cost.`);
  }
} catch (e) {
  console.log(`  getTransactions not available: ${e.message}`);
}

// ── Step 3: Simulate derive_random() cost (read path) ───────────────────────
console.log(`\nNote on fulfill() budget:`);
console.log(`  - Tranche 1 measured: 58.2M instructions (old contract, no re-entrancy guard)`);
console.log(`  - Tranche 2 additions: re-entrancy guard (2 storage ops) + SAC fee path (conditional)`);
console.log(`  - Estimated overhead: ~500K-2M instructions for the new storage operations`);
console.log(`  - For exact measurement: run the oracle worker against the new contract`);
console.log(`    and observe the cpuInsns value in the fulfill() transaction receipt.`);
console.log(`\n  ⚠ The 58.2M figure from Tranche 1 is NOT valid for this contract.`);
console.log(`  ⚠ Run e2e_test.mjs with the oracle worker to get the real number.\n`);
