/**
 * mainnet_proof_of_operation.mjs
 * Sends first request() on mainnet as proof of operation.
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc, xdr, Account } =
  stellar.default || stellar;

const MAINNET_RPC   = "https://mainnet.sorobanrpc.com";
const NETWORK       = Networks.PUBLIC;
const CONTRACT_ID   = "CCN75KEGLETGRTVJJDMXB2ZRQD6PC2S56VUOEKVLQPVEIJYGSOV55G57";
const ORACLE_SECRET = process.env.ORACLE_SECRET;
if (!ORACLE_SECRET) { console.error("ERROR: ORACLE_SECRET env var is required"); process.exit(1); }
const ORACLE_KP     = Keypair.fromSecret(ORACLE_SECRET);
const ORACLE_PUBLIC = ORACLE_KP.publicKey();

const server = new rpc.Server(MAINNET_RPC, { allowHttp: false });

async function getAccount() {
  const resp = await fetch(`https://horizon.stellar.org/accounts/${ORACLE_PUBLIC}`);
  if (!resp.ok) throw new Error("Account not found");
  const data = await resp.json();
  return new Account(ORACLE_PUBLIC, data.sequence);
}

async function pollTx(hash) {
  process.stdout.write("  Confirming");
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await server.getTransaction(hash);
    if (s.status === rpc.Api.GetTransactionStatus.SUCCESS) { process.stdout.write(" ✔\n"); return s; }
    if (s.status === rpc.Api.GetTransactionStatus.FAILED)  { process.stdout.write(" ✖\n"); throw new Error("TX FAILED"); }
    process.stdout.write(".");
  }
  throw new Error("Timeout");
}

console.log("\n=== Stellar VRF Mainnet — Proof of Operation ===\n");

// Context: "Stellar VRF Oracle - Proof of Operation - Mainnet Launch"
const context = Buffer.from("Stellar VRF Oracle - Proof of Operation - Mainnet Launch 2026", "utf-8");
const contextPadded = Buffer.alloc(32);
context.copy(contextPadded, 0, 0, Math.min(32, context.length));

const acct = await getAccount();
const tx = new TransactionBuilder(acct, { fee: "500000", networkPassphrase: NETWORK })
  .addOperation(Operation.invokeContractFunction({
    contract: CONTRACT_ID,
    function: "request",
    args: [
      nativeToScVal(contextPadded, { type: "bytes" }),
      new Address(ORACLE_PUBLIC).toScVal(),
    ],
  }))
  .setTimeout(300).build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) throw new Error("Sim: " + JSON.stringify(sim.error));

const prep = rpc.assembleTransaction(tx, sim).build();
prep.sign(ORACLE_KP);
const sent = await server.sendTransaction(prep);
if (sent.status === "ERROR") throw new Error("Send: " + JSON.stringify(sent.errorResult));

console.log(`TX: https://stellar.expert/explorer/public/tx/${sent.hash}`);
await pollTx(sent.hash);

console.log("\n✅ First VRF request submitted on mainnet!");
console.log(`Contract: ${CONTRACT_ID}`);
console.log(`TX Hash:  ${sent.hash}`);
console.log(`Explorer: https://stellar.expert/explorer/public/tx/${sent.hash}`);
