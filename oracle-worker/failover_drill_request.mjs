/**
 * failover_drill_request.mjs — create ONE new request() on the contract the
 * worker is actually configured for (CONTRACT_ADDRESS in .env), print the
 * request id, TX hash, ledger and the contract the transaction targets.
 *
 * Used by the two-host failover drill (docs/HA_FAILOVER_EVIDENCE.md, Part C).
 * Unlike mainnet_proof_of_operation.mjs it has NO hardcoded contract id, so the
 * drill can never silently target a legacy instance.
 *
 *   cd oracle-worker && node failover_drill_request.mjs
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });
const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/esm/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, TransactionBuilder, Operation, Address, nativeToScVal, scValToNative, rpc } =
  stellar.default || stellar;

const RPC_URL = process.env.SOROBAN_RPC_URL;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE;
const CONTRACT_ID = process.env.CONTRACT_ADDRESS;
const SECRET = process.env.ORACLE_STELLAR_SECRET;
if (!RPC_URL || !PASSPHRASE || !CONTRACT_ID || !SECRET) {
  console.error("ERROR: SOROBAN_RPC_URL, NETWORK_PASSPHRASE, CONTRACT_ADDRESS and ORACLE_STELLAR_SECRET are required");
  process.exit(1);
}

const kp = Keypair.fromSecret(SECRET);
const server = new rpc.Server(RPC_URL, { allowHttp: false });
const explorer = PASSPHRASE.startsWith("Public") ? "public" : "testnet";

const context = Buffer.alloc(32);
Buffer.from(`failover-drill ${new Date().toISOString()}`, "utf8").copy(context, 0, 0, 32);

console.log(`Contract: ${CONTRACT_ID}`);
console.log(`Requester: ${kp.publicKey()}`);
const account = await server.getAccount(kp.publicKey());
const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: PASSPHRASE })
  .addOperation(
    Operation.invokeContractFunction({
      contract: CONTRACT_ID,
      function: "request",
      args: [nativeToScVal(context, { type: "bytes" }), new Address(kp.publicKey()).toScVal()],
    })
  )
  .setTimeout(300)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) throw new Error("Simulation failed: " + sim.error);
const prepared = rpc.assembleTransaction(tx, sim).build();
prepared.sign(kp);
const sent = await server.sendTransaction(prepared);
if (sent.status === "ERROR") throw new Error("Send failed: " + JSON.stringify(sent.errorResult));
console.log(`REQUEST_TX=${sent.hash}`);

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const r = await server.getTransaction(sent.hash);
  if (r.status === "SUCCESS") {
    const id = r.returnValue ? scValToNative(r.returnValue) : null;
    console.log(`REQUEST_ID=${id}`);
    console.log(`REQUEST_LEDGER=${r.ledger}`);
    console.log(`REQUEST_STATUS=SUCCESS`);
    console.log(`EXPLORER=https://stellar.expert/explorer/${explorer}/tx/${sent.hash}`);
    process.exit(0);
  }
  if (r.status === "FAILED") throw new Error("Request TX FAILED: " + sent.hash);
}
throw new Error("Timed out waiting for request TX " + sent.hash);
