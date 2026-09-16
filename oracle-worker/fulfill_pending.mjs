/**
 * fulfill_pending.mjs — One-shot backfill of pending VRF requests.
 *
 * The live listener only picks up requests created AFTER it starts, so any
 * requests that piled up while the oracle was down are never fulfilled by the
 * loop. This script fulfills a given list of request IDs immediately, reusing
 * the worker's own compiled logic (drand → BLS-VRF proof → fulfill()).
 *
 * Prerequisites (run from oracle-worker/, ON THE SERVER):
 *   1. `.env` present and configured (same one pm2 uses)
 *   2. `npx tsc --outDir dist` already run (this imports from dist/)
 *
 * Usage:
 *   node fulfill_pending.mjs                 # auto-detects unfulfilled from events
 *   node fulfill_pending.mjs 8 9 10 11 12 13 # explicit IDs
 */
import { createServer, fetchRequestContext, isRequestFulfilled } from "./dist/listener.js";
import { waitAndFetchBeacon } from "./dist/drand.js";
import { generateVrfProof } from "./dist/vrf.js";
import { submitFulfillment } from "./dist/fulfiller.js";
import { CONTRACT_ADDRESS, NETWORK_PASSPHRASE, ORACLE_PUBLIC_KEY } from "./dist/config.js";
import * as stellarNs from "@stellar/stellar-sdk";

const stellar = stellarNs.default || stellarNs;
const { rpc, xdr, scValToNative, TransactionBuilder, Operation, nativeToScVal } = stellar;

const server = createServer();

/** Read the required drand round for a request straight from the contract. */
async function requestRound(requestId) {
  const account = await server.getAccount(ORACLE_PUBLIC_KEY);
  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({
      contract: CONTRACT_ADDRESS,
      function: "request_round",
      args: [nativeToScVal(BigInt(requestId), { type: "u64" })],
    }))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`request_round sim: ${sim.error}`);
  return BigInt(scValToNative(sim.result.retval));
}

/** Discover unfulfilled request IDs from recent contract events. */
async function discoverPending() {
  const health = await server.getHealth();
  const start = health.latestLedger - 100000; // scan back inside retention
  const filters = [{ type: "contract", contractIds: [CONTRACT_ADDRESS], topics: [[xdr.ScVal.scvSymbol("request").toXDR("base64")]] }];
  const ids = [];
  let cursor;
  for (let i = 0; i < 200; i++) {
    const req = cursor ? { filters, limit: 200, cursor } : { filters, limit: 200, startLedger: Math.max(start, health.oldestLedger + 1) };
    const resp = await server.getEvents(req);
    for (const ev of resp.events || []) {
      try { const v = scValToNative(ev.value); if (Array.isArray(v)) ids.push(String(v[0])); } catch {}
    }
    cursor = resp.cursor;
    if (!cursor || (resp.events || []).length === 0) break;
  }
  return [...new Set(ids)];
}

async function fulfillOne(id) {
  const rid = BigInt(id);
  if (await isRequestFulfilled(server, rid)) {
    console.log(`  #${id} already fulfilled — skip.`);
    return "skip";
  }
  const round = await requestRound(rid);
  console.log(`  #${id} required round ${round} — fetching drand beacon…`);
  const beacon = await waitAndFetchBeacon(Number(round));
  const context = await fetchRequestContext(server, rid);
  const proof = generateVrfProof(rid, context, beacon);
  const hash = await submitFulfillment(server, rid, proof);
  console.log(`  #${id} ✔ fulfilled — TX ${hash}`);
  return hash;
}

const argIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const ids = argIds.length ? argIds : await discoverPending();

console.log(`\n=== Backfill fulfillment for: ${ids.join(", ") || "(none found)"} ===\n`);

let ok = 0, skip = 0, fail = 0;
for (const id of ids) {
  try {
    const r = await fulfillOne(id);
    if (r === "skip") skip++; else ok++;
  } catch (e) {
    fail++;
    console.error(`  #${id} ✖ FAILED: ${e.message}`);
  }
}

console.log(`\nDone. fulfilled=${ok} skipped=${skip} failed=${fail}`);
process.exit(fail > 0 ? 1 : 0);
