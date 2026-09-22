import * as stellarNs from "@stellar/stellar-sdk";
const stellar = stellarNs.default || stellarNs;
const { rpc, scValToNative, Networks, TransactionBuilder, Operation, nativeToScVal } = stellar;

const server = new rpc.Server("https://mainnet.sorobanrpc.com", { allowHttp: false });
const CONTRACT_ID = "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU";
const ORACLE_PUBLIC = "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P";

const health = await server.getHealth();
const start = Math.max(1, health.latestLedger - 5000);
console.log(`Scanning ledgers ${start}..${health.latestLedger} for ALL contract events\n`);

const filters = [{ type: "contract", contractIds: [CONTRACT_ID] }];
let cursor, total = 0;
const requestEvents = [];

for (let i = 0; i < 200; i++) {
  const req = cursor ? { filters, limit: 200, cursor } : { filters, limit: 200, startLedger: start };
  const resp = await server.getEvents(req);
  const evs = resp.events || [];
  for (const ev of evs) {
    total++;
    let topic0 = "?";
    try { topic0 = String(scValToNative(ev.topic[0])); } catch {}
    let val;
    try { val = scValToNative(ev.value); } catch {}
    const valStr = JSON.stringify(val, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(`L${ev.ledger} [${topic0}] ${valStr?.slice(0, 90)}`);
    if (topic0 === "request" && Array.isArray(val) && val.length >= 3) {
      requestEvents.push({ id: String(val[0]), round: String(val[2]), ledger: ev.ledger });
    }
  }
  cursor = resp.cursor;
  // IMPORTANT: keep paging on cursor even when a page is empty, until we reach head.
  if (!cursor) break;
  if (evs.length === 0 && i > 0) break;
}

console.log(`\nTotal contract events in window: ${total}`);

async function isFulfilled(id) {
  try {
    const acct = await server.getAccount(ORACLE_PUBLIC);
    const tx = new TransactionBuilder(acct, { fee: "100000", networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.invokeContractFunction({
        contract: CONTRACT_ID, function: "is_fulfilled",
        args: [nativeToScVal(BigInt(id), { type: "u64" })],
      })).setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return `sim-error`;
    return scValToNative(sim.result.retval) === true;
  } catch (e) { return `err:${e.message}`; }
}

console.log(`\nRequest events found: ${requestEvents.length}`);
for (const r of requestEvents) {
  const f = await isFulfilled(r.id);
  console.log(`  #${r.id} round=${r.round} ledger=${r.ledger} → ${f === true ? "✅ fulfilled" : f === false ? "❌ UNFULFILLED" : "⚠ " + f}`);
}
