/**
 * v2_monitor.mjs — read-only health and governance check for a V2 deployment.
 * Run it from cron (every few minutes) on a machine that holds NO keys.
 *
 *   NETWORK=mainnet CONTRACT_ADDRESS=C… node v2_monitor.mjs
 *
 * Exit codes: 0 all clear | 2 something needs a human | 1 the check itself failed.
 * Pipe a non-zero exit into your alerting (mail, pager, chat webhook).
 *
 * What it reports:
 *   - GOVERNANCE: a pending key rotation or admin transfer. The timelocks only
 *     protect users if someone notices these. Expected ones: acknowledge with
 *     MONITOR_EXPECT=rotation,admin (comma-separated). (The contract code is
 *     immutable: there is no upgrade to watch.)
 *   - the active key epoch is not Active (revoked: no new requests);
 *   - the admin account is not a multisig with a disabled master key;
 *   - the operator's XLM balance is below MONITOR_MIN_OPERATOR_XLM (default 20);
 *   - the contract instance / active epoch entry expire within
 *     MONITOR_MIN_TTL_DAYS (default 14): run ttl_extend.mjs.
 */
import path from "path";
import { fileURLToPath } from "url";
import { Contract, Networks, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { readAccountAuth, multisigProblems } from "./v2_admin_multisig.mjs";

const NET = (process.env.NETWORK ?? "testnet").toLowerCase();
const RPC = process.env.SOROBAN_RPC_URL || (NET === "mainnet" ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
const CONTRACT = process.env.CONTRACT_ADDRESS;
const MIN_XLM = Number(process.env.MONITOR_MIN_OPERATOR_XLM ?? "20");
const MIN_TTL_DAYS = Number(process.env.MONITOR_MIN_TTL_DAYS ?? "14");
const EXPECT = new Set((process.env.MONITOR_EXPECT ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const LEDGERS_PER_DAY = 17280;
void Networks;

/** Pure: turn what was read from chain into alerts. Exported for tests. */
export function evaluate(state, opts) {
  const alerts = [];
  const info = [];
  const pend = (name, key, p, detail) => {
    if (!p) return;
    const line = `pending ${name}: ${detail(p)}; executable after ledger ${p.execute_after_ledger} (now ${state.ledger})`;
    (opts.expect.has(key) ? info : alerts).push(line);
  };
  pend("KEY ROTATION", "rotation", state.pendingRotation, (p) => `epoch ${p.new_epoch_id}, operator ${p.new_epoch.oracle_address}`);
  pend("ADMIN TRANSFER", "admin", state.pendingAdminTransfer, (p) => `to ${p.new_admin}`);
  if (state.activeEpochStatus !== "Active") alerts.push(`active epoch ${state.activeEpochId} is ${state.activeEpochStatus}: new requests are refused`);
  for (const p of state.adminProblems) alerts.push(`admin ${state.admin}: ${p}`);
  if (state.operatorXlm < opts.minXlm) alerts.push(`operator ${state.operator} balance ${state.operatorXlm.toFixed(2)} XLM is below ${opts.minXlm}`);
  for (const [name, days] of Object.entries(state.ttlDays)) {
    if (days < opts.minTtlDays) alerts.push(`${name} entry expires in ${days.toFixed(1)} days: run ttl_extend.mjs`);
  }
  info.push(`epoch ${state.activeEpochId} ${state.activeEpochStatus}; operator ${state.operator} (${state.operatorXlm.toFixed(2)} XLM); admin ${state.admin}`);
  return { alerts, info };
}

async function readState(server) {
  const ledger = (await server.getLatestLedger()).sequence;
  const instKey = new Contract(CONTRACT).getFootprint();
  const instRes = await server.getLedgerEntries(instKey);
  if (!instRes.entries.length) throw new Error("contract instance not found (archived or wrong address)");
  const inst = {};
  for (const item of instRes.entries[0].val.contractData.val.instance.storage ?? []) {
    const k = scValToNative(item.key);
    if (Array.isArray(k) && k.length === 1) inst[k[0]] = scValToNative(item.val);
  }
  const epochKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Contract(CONTRACT).address().toScAddress(),
    key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Epoch"), xdr.ScVal.scvU32(Number(inst.ActiveEpochId))]),
    durability: xdr.ContractDataDurability.persistent,
  }));
  const epRes = await server.getLedgerEntries(epochKey);
  if (!epRes.entries.length) throw new Error("active epoch entry not found (archived?)");
  const epoch = scValToNative(epRes.entries[0].val.contractData.val);
  const status = Array.isArray(epoch.status) ? epoch.status[0] : epoch.status;
  const operator = String(epoch.oracle_address);
  const admin = String(inst.Admin);
  let adminProblems;
  try {
    adminProblems = admin.startsWith("G") ? multisigProblems(await readAccountAuth(server, admin)) : [];
  } catch (e) {
    adminProblems = [`cannot read the admin account: ${e.message}`];
  }
  const bal = operator.startsWith("G") ? Number((await server.getAccountEntry(operator)).balance) / 1e7 : Infinity;
  return {
    ledger,
    admin,
    operator,
    operatorXlm: bal,
    activeEpochId: Number(inst.ActiveEpochId),
    activeEpochStatus: status,
    pendingRotation: inst.PendingRot ?? null,
    pendingAdminTransfer: inst.PendingAdminXfer ?? null,
    adminProblems,
    ttlDays: {
      instance: (instRes.entries[0].liveUntilLedgerSeq - ledger) / LEDGERS_PER_DAY,
      "active epoch": (epRes.entries[0].liveUntilLedgerSeq - ledger) / LEDGERS_PER_DAY,
    },
  };
}

async function main() {
  if (!CONTRACT) throw new Error("CONTRACT_ADDRESS is required");
  const state = await readState(new rpc.Server(RPC));
  const { alerts, info } = evaluate(state, { expect: EXPECT, minXlm: MIN_XLM, minTtlDays: MIN_TTL_DAYS });
  for (const l of info) console.log("info:  " + l);
  for (const l of alerts) console.log("ALERT: " + l);
  console.log(alerts.length ? `${alerts.length} alert(s)` : "all clear");
  process.exit(alerts.length ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("ERROR: " + (e instanceof Error ? e.message : e)); process.exit(1); });
}
