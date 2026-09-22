/**
 * spend_ledger_drill.mjs — prove against a REAL Redis that the fee guard's
 * unpaid budget is shared by every instance (primary + standby) and is never
 * exceeded, even under concurrent reservations.
 *
 * Usage: REDIS_URL=redis://127.0.0.1:6399 node spend_ledger_drill.mjs
 * (requires `npm run build`; run in CI next to failover_drill.mjs)
 */
import { RedisSpendLedger } from "./dist/spendLedger.js";

const url = process.env.REDIS_URL;
if (!url) {
  console.error("REDIS_URL is required");
  process.exit(1);
}

const key = `vrf-drill:unpaid-spend:${Date.now()}`;
const COST = 1_500_000n;
const BUDGET = 10n * COST;

let failed = false;
function check(cond, msg) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed = true;
}

// Two independent clients = two worker processes on different hosts.
const primary = new RedisSpendLedger(url, key);
const standby = new RedisSpendLedger(url, key);

try {
  check((await primary.spent()) === 0n, "fresh ledger is empty");

  // 1. Sequential: primary spends 6, standby can only spend the remaining 4.
  let p = 0, s = 0;
  for (let i = 0; i < 6; i++) if (await primary.tryReserve(COST, 0, BUDGET)) p++;
  for (let i = 0; i < 10; i++) if (await standby.tryReserve(COST, 0, BUDGET)) s++;
  check(p === 6 && s === 4, `budget shared across instances (primary ${p}, standby ${s})`);
  check((await standby.spent()) === BUDGET, "standby sees primary's spend");

  // 2. Concurrent: 40 racing reservations on a second key never overshoot.
  const key2 = `${key}:race`;
  const a = new RedisSpendLedger(url, key2);
  const b = new RedisSpendLedger(url, key2);
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).tryReserve(COST, 0, BUDGET))
  );
  const granted = results.filter(Boolean).length;
  const total = await a.spent();
  check(granted === 10, `concurrent reservations granted exactly ${granted}/10`);
  check(total <= BUDGET, `concurrent total ${total} <= budget ${BUDGET}`);

  // 3. A "restarted" process (new client) inherits the spend.
  const restarted = new RedisSpendLedger(url, key);
  check((await restarted.tryReserve(COST, 0, BUDGET)) === false, "restart does not reset the budget");
  restarted.close();
  a.close();
  b.close();
} finally {
  primary.close();
  standby.close();
}

if (failed) {
  console.error("\nSpend-ledger drill FAILED");
  process.exit(1);
}
console.log("\nSpend-ledger drill passed");
