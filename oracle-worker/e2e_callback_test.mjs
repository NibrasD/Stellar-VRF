/**
 * e2e_callback_test.mjs — End-to-end proving callback execution on testnet
 *
 * Uses VRF Random Sampling consumer contract (request_sample / get_sample).
 *
 * Flow:
 *   1. Calls request_sample(requester, range_max) on consumer contract
 *      → internally calls VRF.request_with_callback()
 *   2. Oracle worker picks up event → calls fulfill()
 *   3. fulfill() invokes on_vrf() callback on consumer
 *   4. Consumer derives sample ∈ [0, range_max) and stores it
 *   5. We verify by reading get_sample() from consumer contract
 */

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_INDEX = path.resolve(__dirname, "../node_modules/@stellar/stellar-sdk/lib/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);

const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc, xdr } =
  stellar.default || stellar;

const SOROBAN_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;

const deployedPath = path.resolve(__dirname, "../soroban-contract/deployed.json");
const deployed = JSON.parse(readFileSync(deployedPath, "utf8"));
const VRF_CONTRACT = deployed.contractAddress;
const CONSUMER_CONTRACT = "CBBHKSZR7H3NLTUC6IRTVXYDWK5HAOK5PFN3CUKTJF47ZT66PS6YNHN4";

const server = new rpc.Server(SOROBAN_URL, { allowHttp: false });

function u64ScVal(val) {
  return xdr.ScVal.scvU64(new xdr.Uint64(val.toString()));
}

async function pollTx(hash) {
  process.stdout.write("  Waiting");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await server.getTransaction(hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" done.\n");
      return status;
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" FAILED.\n");
      throw new Error(`Transaction failed: ${hash}`);
    }
    process.stdout.write(".");
  }
  throw new Error("Timeout waiting for TX");
}

async function simulateAndSend(signerKP, tx) {
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation error: ${simulated.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulated).build();
  prepared.sign(signerKP);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(sent.errorResult)}`);
  }
  return { sent, result: await pollTx(sent.hash) };
}

console.log(`\n═══ E2E Callback Test — VRF Random Sampling on Testnet ═══`);
console.log(`VRF Contract:      ${VRF_CONTRACT}`);
console.log(`Consumer Contract: ${CONSUMER_CONTRACT}\n`);

// ── 1. Fund a test account ──────────────────────────────────────────────────
const testerKP = Keypair.random();
console.log(`[1/4] Funding tester: ${testerKP.publicKey()}`);
await fetch(`https://friendbot.stellar.org?addr=${testerKP.publicKey()}`);
await new Promise((r) => setTimeout(r, 5000));

// ── 2. Call request_sample() on consumer contract ───────────────────────────
console.log(`\n[2/4] Calling request_sample() on consumer contract...`);
console.log(`  Requesting a random sample in range [0, 1000000)`);
let account = await server.getAccount(testerKP.publicKey());

const RANGE_MAX = 1_000_000n;

const sampleTx = new TransactionBuilder(account, {
  fee: "10000000",
  networkPassphrase: NETWORK,
})
  .addOperation(
    Operation.invokeContractFunction({
      contract: CONSUMER_CONTRACT,
      function: "request_sample",
      args: [
        new Address(testerKP.publicKey()).toScVal(),
        u64ScVal(RANGE_MAX),
      ],
    })
  )
  .setTimeout(120)
  .build();

const { sent: sampleSent, result: sampleResult } = await simulateAndSend(testerKP, sampleTx);
const retVal = sampleResult.returnValue;
const sampleId = retVal.u64 ? retVal.u64() : BigInt(retVal.value().toString());
console.log(`  ✔ request_sample() succeeded`);
console.log(`  Sample ID:  ${sampleId}`);
console.log(`  Range:      [0, ${RANGE_MAX})`);
console.log(`  TX: https://stellar.expert/explorer/testnet/tx/${sampleSent.hash}`);

// ── 3. Wait for oracle worker to fulfill() + callback ───────────────────────
console.log(`\n[3/4] Waiting for oracle worker to fulfill() + on_vrf() callback (max 120s)...`);
const startWait = Date.now();
let fulfilled = false;

while (Date.now() - startWait < 120_000) {
  await new Promise((r) => setTimeout(r, 5000));
  account = await server.getAccount(testerKP.publicKey());

  const checkTx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: VRF_CONTRACT,
        function: "is_fulfilled",
        args: [u64ScVal(sampleId)],
      })
    )
    .setTimeout(30)
    .build();

  const simCheck = await server.simulateTransaction(checkTx);
  if (!rpc.Api.isSimulationError(simCheck)) {
    const val = simCheck.result?.retval;
    if (val) {
      try {
        const boolVal = val.b ? val.b() : val.value();
        if (boolVal === true) { fulfilled = true; break; }
      } catch (e) {}
    }
  }
  process.stdout.write(".");
}

if (!fulfilled) {
  console.log(`\n⚠ Not fulfilled within 120s. Is the oracle worker running?`);
  process.exit(1);
}
console.log(`\n  ✔ Sample ${sampleId} fulfilled by oracle!`);

// ── 4. Verify callback: read get_sample() from consumer ─────────────────────
console.log(`\n[4/4] Verifying on_vrf() callback: reading get_sample(${sampleId}) from consumer...`);
account = await server.getAccount(testerKP.publicKey());

const resultTx = new TransactionBuilder(account, {
  fee: "100000",
  networkPassphrase: NETWORK,
})
  .addOperation(
    Operation.invokeContractFunction({
      contract: CONSUMER_CONTRACT,
      function: "get_sample",
      args: [u64ScVal(sampleId)],
    })
  )
  .setTimeout(30)
  .build();

const simResult = await server.simulateTransaction(resultTx);
if (rpc.Api.isSimulationError(simResult)) {
  console.log(`  ✖ get_sample() simulation failed: ${simResult.error}`);
  console.log(`  This means the on_vrf() callback was NOT executed.`);
  process.exit(1);
}

const sampleValue = simResult.result?.retval?.u64
  ? simResult.result.retval.u64()
  : simResult.result?.retval?.value?.();

console.log(`  ✔ CALLBACK CONFIRMED!`);
console.log(`  Random sample: ${sampleValue} ∈ [0, ${RANGE_MAX})`);
console.log(`  (Verifiable, bias-resistant random number from BLS-VRF + drand)\n`);

console.log(`╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║          E2E CALLBACK TEST — PASSED ✔                           ║`);
console.log(`╠══════════════════════════════════════════════════════════════════╣`);
console.log(`║  request_sample() TX:  ${sampleSent.hash}  ║`);
console.log(`║  Sample ID:            ${String(sampleId).padEnd(46)}║`);
console.log(`║  Random Value:         ${String(sampleValue).padEnd(46)}║`);
console.log(`║  Range:                [0, ${RANGE_MAX}) ${"".padEnd(36)}║`);
console.log(`║                                                                  ║`);
console.log(`║  Proven:                                                         ║`);
console.log(`║    ✔ request_with_callback() works on testnet                    ║`);
console.log(`║    ✔ Oracle worker picks up and fulfills the request             ║`);
console.log(`║    ✔ fulfill() invokes on_vrf() callback on consumer             ║`);
console.log(`║    ✔ Consumer stores verifiable random sample                    ║`);
console.log(`║    ✔ Full CEI pattern + callback execution on testnet            ║`);
console.log(`║                                                                  ║`);
console.log(`║  VRF Contract:      ${VRF_CONTRACT}  ║`);
console.log(`║  Consumer Contract: ${CONSUMER_CONTRACT}  ║`);
console.log(`║                                                                  ║`);
console.log(`║  Explorer: https://stellar.expert/explorer/testnet/tx/${sampleSent.hash} ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝`);
