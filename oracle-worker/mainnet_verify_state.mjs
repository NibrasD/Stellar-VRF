/**
 * mainnet_verify_state.mjs
 * Queries on-chain getters for Mainnet Request #1
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  scValToNative,
  rpc,
  Account,
} from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const NETWORK = Networks.PUBLIC;
const CONTRACT_ID = "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX";
const ORACLE_PUBLIC = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";

const server = new rpc.Server(MAINNET_RPC, { allowHttp: false });

async function getAccount(publicKey) {
  const resp = await fetch(`https://horizon.stellar.org/accounts/${publicKey}`);
  if (!resp.ok) throw new Error("Account not found");
  const data = await resp.json();
  return new Account(publicKey, data.sequence);
}

async function simCall(fn, args) {
  const acct = await getAccount(ORACLE_PUBLIC);
  const tx = new TransactionBuilder(acct, { fee: "1000", networkPassphrase: NETWORK })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT_ID, function: fn, args }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simCall error (${fn}): ${JSON.stringify(sim.error)}`);
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function main() {
  const requestId = 1n;
  console.log("=== Stellar VRF Mainnet State Verification ===");
  console.log("Contract ID:", CONTRACT_ID);
  console.log("Request ID: ", requestId);

  const isFulfilled = await simCall("is_fulfilled", [nativeToScVal(requestId, { type: "u64" })]);
  console.log("is_fulfilled:", isFulfilled);

  const beta = await simCall("get_beta", [nativeToScVal(requestId, { type: "u64" })]);
  const betaHex = Buffer.from(beta).toString("hex");
  console.log("beta output:", betaHex);

  const u64Val = await simCall("derive_random", [nativeToScVal(requestId, { type: "u64" })]);
  console.log("derive_random:", u64Val);

  const range100 = await simCall("derive_random_in_range", [
    nativeToScVal(requestId, { type: "u64" }),
    nativeToScVal(100n, { type: "u64" }),
  ]);
  console.log("derive_random_in_range(100):", range100);

  const range6 = await simCall("derive_random_in_range", [
    nativeToScVal(requestId, { type: "u64" }),
    nativeToScVal(6n, { type: "u64" }),
  ]);
  console.log("derive_random_in_range(6) (dice 0-5):", range6);

  // Check horizon tx details for fulfill tx
  const fulfillTxHash = "e0cc4b6089b98300a7dfd230320fe5f37917a1dfd6ee034e762ccdf91d3a960b";
  const rpcTx = await server.getTransaction(fulfillTxHash);
  console.log("Fulfill Status:", rpcTx.status);
  console.log("Fee Charged:", rpcTx.feeCharged, "stroops");
  console.log("Ledger:", rpcTx.ledger);
}

main().catch(console.error);
