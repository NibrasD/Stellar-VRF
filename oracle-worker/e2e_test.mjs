/**
 * e2e_test.mjs — End-to-end test script for the VRF oracle
 *
 * Sends a request to the deployed VRF contract and then checks
 * if the oracle worker fulfills it. Also measures the CPU budget.
 *
 * Usage: node oracle-worker/e2e_test.mjs
 */

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SDK_INDEX = path.resolve(
  __dirname,
  "../node_modules/@stellar/stellar-sdk/lib/index.js"
);
const stellar = await import(pathToFileURL(SDK_INDEX).href);

const {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  rpc,
} = stellar.default || stellar;

// ─── Config ──────────────────────────────────────────────────────────────────

const SOROBAN_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const FRIENDBOT = "https://friendbot.stellar.org";

// Load contract address from deployed.json
const deployedPath = path.resolve(__dirname, "../soroban-contract/deployed.json");
const deployed = JSON.parse(readFileSync(deployedPath, "utf8"));
const CONTRACT_ADDRESS = deployed.contractAddress;

console.log(`\n═══ Soroban VRF Oracle — E2E Test ═══`);
console.log(`Contract: ${CONTRACT_ADDRESS}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fundAccount(pk) {
  const res = await fetch(`${FRIENDBOT}?addr=${pk}`);
  if (!res.ok) {
    const body = await res.text();
    if (!body.includes("createAccountAlreadyExist") && !body.includes("already funded")) {
      throw new Error(`Friendbot error: ${body.slice(0, 200)}`);
    }
  }
}

async function pollTx(server, hash) {
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
  throw new Error("Timeout waiting for transaction");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const server = new rpc.Server(SOROBAN_URL, { allowHttp: false });

  // 1. Generate a test requester
  const requesterKP = Keypair.random();
  console.log(`\n[1/5] Creating test requester: ${requesterKP.publicKey()}`);
  await fundAccount(requesterKP.publicKey());
  await new Promise((r) => setTimeout(r, 5000));

  // 2. Send a VRF request
  console.log(`\n[2/5] Sending VRF request…`);
  const context = Buffer.from("e2e_test_" + Date.now());
  let account = await server.getAccount(requesterKP.publicKey());

  const requestTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ADDRESS,
        function: "request",
        args: [
          nativeToScVal(context, { type: "bytes" }),
          new Address(requesterKP.publicKey()).toScVal(),
        ],
      })
    )
    .setTimeout(120)
    .build();

  const simReq = await server.simulateTransaction(requestTx);
  if (rpc.Api.isSimulationError(simReq)) {
    throw new Error(`Request simulation error: ${simReq.error}`);
  }
  const preparedReq = rpc.assembleTransaction(requestTx, simReq).build();
  preparedReq.sign(requesterKP);
  const sentReq = await server.sendTransaction(preparedReq);
  if (sentReq.status === "ERROR") {
    throw new Error(`Request send error: ${JSON.stringify(sentReq.errorResult)}`);
  }
  const reqResult = await pollTx(server, sentReq.hash);

  // Extract request ID from return value
  const requestId = reqResult.returnValue.u64().low;
  console.log(`  Request ID: ${requestId}`);
  console.log(`  TX hash: ${sentReq.hash}`);

  // 3. Get the required round
  console.log(`\n[3/5] Checking request round…`);
  account = await server.getAccount(requesterKP.publicKey());
  const roundTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ADDRESS,
        function: "request_round",
        args: [nativeToScVal(requestId, { type: "u64" })],
      })
    )
    .setTimeout(30)
    .build();

  const simRound = await server.simulateTransaction(roundTx);
  if (rpc.Api.isSimulationError(simRound)) {
    throw new Error(`Round query error: ${simRound.error}`);
  }
  const roundResult = simRound.result?.retval;
  console.log(`  Required drand round: ${roundResult}`);

  // 4. Wait for oracle worker to fulfill
  console.log(`\n[4/5] Waiting for oracle worker to fulfill (max 120s)…`);
  console.log(`  ⚡ Make sure the oracle worker is running: cd oracle-worker && npm run dev`);

  const startWait = Date.now();
  let fulfilled = false;
  while (Date.now() - startWait < 120_000) {
    await new Promise((r) => setTimeout(r, 5000));

    // Check fulfillment
    account = await server.getAccount(requesterKP.publicKey());
    const checkTx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: CONTRACT_ADDRESS,
          function: "is_fulfilled",
          args: [nativeToScVal(requestId, { type: "u64" })],
        })
      )
      .setTimeout(30)
      .build();

    const simCheck = await server.simulateTransaction(checkTx);
    if (!rpc.Api.isSimulationError(simCheck) && simCheck.result?.retval) {
      const val = simCheck.result.retval;
      if (val.value() === true) {
        fulfilled = true;
        break;
      }
    }
    process.stdout.write(".");
  }

  if (!fulfilled) {
    console.log(`\n  ⚠  Request not fulfilled within 120s.`);
    console.log(`  Make sure the oracle worker is running and configured correctly.`);
    process.exit(1);
  }

  console.log(`\n  ✔  Request ${requestId} has been fulfilled!`);

  // 5. Derive random number
  console.log(`\n[5/5] Deriving random number…`);
  account = await server.getAccount(requesterKP.publicKey());
  const deriveTx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ADDRESS,
        function: "derive_random",
        args: [
          nativeToScVal(requestId, { type: "u64" }),
          nativeToScVal(Buffer.from("game_seed"), { type: "bytes" }),
        ],
      })
    )
    .setTimeout(30)
    .build();

  const simDerive = await server.simulateTransaction(deriveTx);
  if (rpc.Api.isSimulationError(simDerive)) {
    throw new Error(`Derive error: ${simDerive.error}`);
  }

  const derivedValue = simDerive.result?.retval;
  const cost = simDerive.cost;

  console.log(`  Derived random value: ${derivedValue}`);
  if (cost) {
    console.log(`  CPU instructions: ${cost.cpuInsns}`);
    console.log(`  Memory bytes: ${cost.memBytes}`);
  }

  console.log(`\n═══ E2E Test PASSED ═══`);
  console.log(`  ✔ request() — submitted and confirmed`);
  console.log(`  ✔ fulfill() — oracle worker fulfilled the request`);
  console.log(`  ✔ derive_random() — random value derived successfully`);
  console.log(`  ✔ Full pipeline: request → fulfill → derive VALIDATED\n`);
}

main().catch((e) => {
  console.error(`\n✖ E2E test failed: ${e.message || e}`);
  process.exit(1);
});
