/**
 * ttl_extend.mjs — keep the VRF contract's INSTANCE and WASM CODE entries alive.
 *
 * Soroban archives a contract whose instance or code entry runs out of TTL, and
 * every call then fails until it is restored. The contract extends its own TTL only
 * inside real transactions (request/fulfill) and only when under ~1 day remains;
 * simulated reads extend nothing and the worker has no periodic job, so a contract
 * with no traffic expires. This script is that periodic job: a single
 * ExtendFootprintTtl operation covering BOTH entries.
 *
 * ── Keeper account ──────────────────────────────────────────────────────────
 * The transaction is signed by a dedicated, separately funded "keeper" account.
 * The oracle key is NEVER read or used here:
 *   - the keeper secret comes only from KEEPER_SECRET (env, or a file given by
 *     KEEPER_ENV_FILE / --env-file). The default `.env` is never loaded;
 *   - the script refuses to run if any ORACLE_* secret is present in its
 *     environment or in the keeper file;
 *   - it refuses if the keeper address equals the contract's oracle_address(),
 *     or a known oracle account.
 * Fund the keeper with a small amount only: one extension costs a fraction of 1 XLM.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node ttl_extend.mjs --check                 read-only; no key needed
 *   node ttl_extend.mjs                         extend if needed (Testnet)
 *   node ttl_extend.mjs --mainnet               same on Mainnet (explicit opt-in)
 *   node ttl_extend.mjs --keygen --keeper-file F   create a keeper key file (no tx)
 *
 * Options:
 *   --contract <C…>    contract id (default: CONTRACT_ADDRESS from the keeper file / env,
 *                      else the repo's deployed*.json when present)
 *   --keeper-file <path>  keeper env file (or KEEPER_ENV_FILE)
 *   --force            send even if the TTL is already high
 *   --friendbot        with --keygen, Testnet only: fund the new account (Friendbot gives
 *                      10,000 test XLM; there is no way to ask for less)
 *
 * Environment (all optional):
 *   MIN_DAYS=14              alert threshold: exit 2 if the remaining TTL is below this
 *   EXTEND_TO_DAYS=60        target TTL for an extension
 *   EXTEND_IF_BELOW_DAYS=45  skip sending while both entries are above this (saves fees)
 *   MAX_FEE_STROOPS          abort rather than pay more than this for one extension
 *                            (default: 30 XLM on Mainnet, 500 XLM on Testnet)
 *   KEEPER_RPC_URL           override the RPC endpoint
 *
 * Cost: this is NOT a few cents. Rent for the ~44 KB WASM dominates. Simulated on
 * 2026-10-17: Mainnet ~0.44 XLM per extra day of TTL (e.g. 14 -> 60 days ~ 20 XLM);
 * Testnet ~3.5 XLM per extra day (6.8 -> 60 days ~ 187 XLM, free from Friendbot).
 * The script prints the simulated maximum fee and the keeper balance before sending.
 *
 * Exit codes:  0 ok | 1 error | 2 remaining TTL below MIN_DAYS | 3 an entry is archived
 *              (needs RestoreFootprint, which this script deliberately does not do).
 *
 * Days are estimated at 5 s per ledger (Stellar's target), so they are approximate.
 * Only public values (addresses, tx hash, ledger numbers) are ever printed.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Contract,
  Account,
  SorobanDataBuilder,
  BASE_FEE,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_LOW = 2;
const EXIT_ARCHIVED = 3;

const SECONDS_PER_LEDGER = 5;
const LEDGERS_PER_DAY = 86400 / SECONDS_PER_LEDGER;

// Accounts that must never act as keeper. The contract's own oracle_address() is
// checked as well; this list is the second line of defence.
const KNOWN_ORACLES = new Set([
  "GA6HYAVWPVOVB4XJHGUZSDHRVYOKLPU4JAHYPXZRSJWO2PM4HSCNKP5P", // Mainnet oracle
  "GA2WKWFHOGUCBX573A26NQAF44UFPUCB3ZS23ROKBXOUQLU7D5V62VET", // Testnet oracle
]);
const ORACLE_ENV_KEYS = ["ORACLE_STELLAR_SECRET", "ORACLE_SECRET", "ORACLE_BLS_SECRET_KEY"];

const NETWORKS = {
  testnet: {
    name: "testnet",
    rpc: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET,
    explorer: "https://stellar.expert/explorer/testnet",
    deployed: path.resolve(__dirname, "deployed.testnet.json"),
    // Testnet rent is far higher than Mainnet's, but Testnet XLM is free (Friendbot).
    defaultMaxFeeStroops: 5_000_000_000, // 500 XLM
  },
  mainnet: {
    name: "mainnet",
    rpc: "https://mainnet.sorobanrpc.com",
    passphrase: Networks.PUBLIC,
    explorer: "https://stellar.expert/explorer/public",
    deployed: path.resolve(__dirname, "../soroban-contract/deployed.json"),
    // Real money. Rent for the ~44 KB WASM entry dominates: ~0.44 XLM per extra day on
    // Mainnet (measured by simulation), so 14 -> 60 days costs ~20 XLM.
    defaultMaxFeeStroops: 300_000_000, // 30 XLM
  },
};

class Fail extends Error {
  constructor(message, code = EXIT_ERROR) {
    super(message);
    this.code = code;
  }
}

// ── args / config ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { check: false, mainnet: false, keygen: false, force: false, friendbot: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Fail(`${t} needs a value`);
      return v;
    };
    if (t === "--check") a.check = true;
    else if (t === "--mainnet") a.mainnet = true;
    else if (t === "--keygen") a.keygen = true;
    else if (t === "--force") a.force = true;
    else if (t === "--friendbot") a.friendbot = true;
    else if (t === "--contract") a.contract = val();
    else if (t === "--keeper-file") a.envFile = val();
    else throw new Fail(`unknown argument: ${t}`);
  }
  return a;
}

function numEnv(name, fallback, { min = 0, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Fail(`${name} must be ${integer ? "an integer" : "a number"} >= ${min} (got "${raw}")`);
  }
  return n;
}

/** Accessor that works for both property-style and method-style XDR objects. */
const f = (o, k) => (o != null && typeof o[k] === "function" ? o[k]() : o?.[k]);

const days = (ledgers) => ledgers / LEDGERS_PER_DAY;
const fmtDays = (ledgers) => days(ledgers).toFixed(1);

// ── keeper env ──────────────────────────────────────────────────────────────

/**
 * Reads ONLY the keeper file (never the default .env) without touching process.env.
 * On POSIX the file must not be readable by group/others.
 */
function loadKeeperEnv(file) {
  if (!file) return {};
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Fail(`keeper env file not found: ${abs}`);
  if (process.platform !== "win32") {
    const mode = fs.statSync(abs).mode & 0o777;
    if (mode & 0o077) {
      throw new Fail(`keeper env file ${abs} is accessible by group/others (mode ${mode.toString(8)}); run: chmod 600 ${abs}`);
    }
  }
  const parsed = dotenv.parse(fs.readFileSync(abs));
  for (const k of ORACLE_ENV_KEYS) {
    if (parsed[k]) throw new Fail(`keeper env file contains ${k}. The keeper file must never hold an oracle secret.`);
  }
  return parsed;
}

function assertNoOracleSecretsInProcess() {
  for (const k of ORACLE_ENV_KEYS) {
    if (process.env[k]) {
      throw new Fail(`${k} is set in this process's environment. ttl_extend never uses the oracle key; unset it (or run with a clean environment).`);
    }
  }
}

function resolveContractId(args, net, keeperEnv) {
  const given = args.contract || keeperEnv.CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS;
  if (given) return given.trim();
  try {
    const j = JSON.parse(fs.readFileSync(net.deployed, "utf8"));
    if (j.contractAddress) return j.contractAddress;
  } catch {
    /* not present on a server that only has the release package */
  }
  throw new Fail("no contract id: pass --contract C..., or set CONTRACT_ADDRESS in the keeper env file");
}

// ── keygen (offline: creates a key file, sends no transaction) ──────────────

async function keygen(args) {
  const out = args.envFile || process.env.KEEPER_ENV_FILE;
  if (!out) throw new Fail("--keygen needs --keeper-file <path> (or KEEPER_ENV_FILE)");
  const abs = path.resolve(out);
  if (fs.existsSync(abs)) throw new Fail(`REFUSING to overwrite existing ${abs}`);
  const net = args.mainnet ? NETWORKS.mainnet : NETWORKS.testnet;
  if (args.friendbot && net.name !== "testnet") throw new Fail("--friendbot only exists on Testnet");

  const kp = Keypair.random();
  if (KNOWN_ORACLES.has(kp.publicKey())) throw new Fail("impossible: generated an oracle address");
  const body =
    `# Stellar VRF TTL keeper (${net.name}). Created ${new Date().toISOString()}.\n` +
    `# Holds ONLY the keeper key. Never put an oracle key in this file.\n` +
    `KEEPER_SECRET=${kp.secret()}\n` +
    `# CONTRACT_ADDRESS=\n`;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, { mode: 0o600, flag: "wx" });
  console.log(`Keeper key written to: ${abs}`);
  console.log(`  Keeper address: ${kp.publicKey()}`);
  if (args.friendbot) {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    console.log(`  Friendbot     : HTTP ${r.status}${r.ok ? " (funded with test XLM)" : " (FAILED - fund manually)"}`);
  } else {
    console.log("  Fund this address before the first extension. Rent is NOT cheap: the script prints the");
    console.log("  simulated cost and refuses to send if the balance is lower (Mainnet ~0.44 XLM per extra day).");
  }
  return EXIT_OK;
}

// ── chain reads ─────────────────────────────────────────────────────────────

function wasmHashOf(instanceEntry) {
  const cd = f(instanceEntry.val, "contractData");
  const inst = f(f(cd, "val"), "instance");
  const exec = f(inst, "executable");
  const t = f(exec, "type");
  const tn = typeof t === "string" ? t : t?.name;
  const h = f(exec, "wasmHash");
  if (!h || !/wasm/i.test(String(tn))) {
    throw new Fail("the contract instance has no WASM executable (is this a Stellar Asset Contract?)");
  }
  return Buffer.isBuffer(h) ? h : Buffer.from(h.toXDR("raw"));
}

/**
 * Returns { ledger, instance, wasm, wasmHash, instanceKey, codeKey }. instance/wasm
 * are { liveUntil, remaining } or null when the entry is archived or missing.
 */
async function readState(server, contractId) {
  const ledger = (await server.getLatestLedger()).sequence;
  const instanceKey = new Contract(contractId).getFootprint();
  const r1 = await server.getLedgerEntries(instanceKey);
  if (!r1.entries.length) {
    return { ledger, instance: null, wasm: null, wasmHash: null, instanceKey, codeKey: null };
  }
  const e = r1.entries[0];
  const instance = { liveUntil: e.liveUntilLedgerSeq, remaining: e.liveUntilLedgerSeq - ledger };
  const wasmHash = wasmHashOf(e);
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  const r2 = await server.getLedgerEntries(codeKey);
  const wasm = r2.entries.length
    ? { liveUntil: r2.entries[0].liveUntilLedgerSeq, remaining: r2.entries[0].liveUntilLedgerSeq - ledger }
    : null;
  return { ledger, instance, wasm, wasmHash, instanceKey, codeKey };
}

async function readMaxEntryTtl(server) {
  try {
    const key = xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival })
    );
    const r = await server.getLedgerEntries(key);
    const sa = f(f(r.entries[0].val, "configSetting"), "stateArchivalSettings");
    const max = Number(f(sa, "maxEntryTtl"));
    if (Number.isFinite(max) && max > 0) return max;
  } catch {
    /* fall through */
  }
  console.warn("WARN: could not read maxEntryTtl from the network; assuming 3,110,400 ledgers.");
  return 3_110_400;
}

async function readOracleAddress(server, contractId, passphrase) {
  const throwaway = Keypair.random().publicKey(); // unfunded: simulation only
  const tx = new TransactionBuilder(new Account(throwaway, "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call("oracle_address"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Fail(`oracle_address() simulation failed: ${sim.error}`);
  return String(scValToNative(sim.result.retval));
}

const xlm = (stroops) => (Number(stroops) / 1e7).toFixed(4);

/** Native balance in stroops, or null if it cannot be read. */
async function readBalance(server, publicKey) {
  try {
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(publicKey).xdrAccountId() }));
    const r = await server.getLedgerEntries(key);
    if (!r.entries.length) return null;
    return BigInt(String(f(f(r.entries[0].val, "account"), "balance")));
  } catch {
    return null;
  }
}

function report(label, s, minDays) {
  const line = (name, e) =>
    e
      ? `  ${name.padEnd(9)} live until ledger ${e.liveUntil}  remaining ${e.remaining} ledgers  ~ ${fmtDays(e.remaining)} days${days(e.remaining) < minDays ? "  !! BELOW MIN_DAYS" : ""}`
      : `  ${name.padEnd(9)} NOT FOUND (archived or expired)`;
  console.log(`${label} (current ledger ${s.ledger}, ~${SECONDS_PER_LEDGER}s/ledger):`);
  console.log(line("INSTANCE", s.instance));
  console.log(line("WASM", s.wasm));
}

function minRemainingDays(s) {
  return Math.min(days(s.instance.remaining), days(s.wasm.remaining));
}

// ── send ────────────────────────────────────────────────────────────────────

async function pollTx(server, hash) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let t;
    try {
      t = await server.getTransaction(hash);
    } catch {
      continue; // gateways occasionally answer 502/503 for a tx that is fine
    }
    if (t.status === rpc.Api.GetTransactionStatus.SUCCESS) return t;
    if (t.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Fail(`extension transaction FAILED: ${hash}`);
    }
  }
  throw new Fail(`timed out waiting for ${hash}`);
}

async function extend(server, net, s, keeperKp, extendToLedgers, maxFee) {
  let account;
  try {
    account = await server.getAccount(keeperKp.publicKey());
  } catch {
    throw new Fail(`keeper account ${keeperKp.publicKey()} does not exist on ${net.name}. Fund it with a small amount of XLM first.`);
  }
  const data = new SorobanDataBuilder().setReadOnly([s.instanceKey, s.codeKey]).build();
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.passphrase,
    sorobanData: data,
  })
    .addOperation(Operation.extendFootprintTtl({ extendTo: extendToLedgers }))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) throw new Fail(`simulation failed: ${sim.error}`);
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new Fail("simulation says an entry needs a RestoreFootprint first", EXIT_ARCHIVED);
  }
  const tx = rpc.assembleTransaction(raw, sim).build();
  if (BigInt(tx.fee) > BigInt(maxFee)) {
    throw new Fail(`extension fee ${tx.fee} stroops exceeds MAX_FEE_STROOPS=${maxFee}; not sending`);
  }
  const balance = await readBalance(server, keeperKp.publicKey());
  console.log(`Estimated max cost ${xlm(BigInt(tx.fee))} XLM; keeper balance ${balance === null ? "unknown" : xlm(balance) + " XLM"}`);
  if (balance !== null && balance < BigInt(tx.fee)) {
    throw new Fail(`keeper balance ${xlm(balance)} XLM is below the estimated cost ${xlm(BigInt(tx.fee))} XLM; fund ${keeperKp.publicKey()} first`);
  }
  tx.sign(keeperKp);
  console.log(`Submitting ExtendFootprintTtl (extendTo ${extendToLedgers} ledgers ~ ${fmtDays(extendToLedgers)} days)...`);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new Fail(`sendTransaction rejected: ${sent.status}`);
  }
  await pollTx(server, sent.hash);
  console.log(`  TX ${sent.hash}`);
  console.log(`  ${net.explorer}/tx/${sent.hash}`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.keygen) return keygen(args);

  const net = args.mainnet ? NETWORKS.mainnet : NETWORKS.testnet;
  const minDays = numEnv("MIN_DAYS", 14, { min: 0 });
  const extendToDays = numEnv("EXTEND_TO_DAYS", 60, { min: 1 });
  const belowDays = numEnv("EXTEND_IF_BELOW_DAYS", 45, { min: 0 });
  const maxFee = numEnv("MAX_FEE_STROOPS", net.defaultMaxFeeStroops, { min: 1, integer: true });
  // --check only compares the current TTL with MIN_DAYS, so the extension settings
  // are validated only when an extension can actually happen.
  if (!args.check) {
    if (extendToDays <= minDays) throw new Fail(`EXTEND_TO_DAYS (${extendToDays}) must be greater than MIN_DAYS (${minDays})`);
    if (belowDays < minDays) throw new Fail(`EXTEND_IF_BELOW_DAYS (${belowDays}) must not be below MIN_DAYS (${minDays})`);
  }

  assertNoOracleSecretsInProcess();
  const keeperEnv = loadKeeperEnv(args.envFile || process.env.KEEPER_ENV_FILE);
  const contractId = resolveContractId(args, net, keeperEnv);
  const server = new rpc.Server(process.env.KEEPER_RPC_URL || net.rpc, { allowHttp: false });

  console.log(`Network ${net.name} | contract ${contractId}${args.check ? " | CHECK (read-only)" : ""}`);
  const before = await readState(server, contractId);
  if (!before.instance || !before.wasm) {
    report("State", before, minDays);
    console.error("An entry is archived or missing: it needs RestoreFootprint (e.g. `stellar contract restore`), then re-run.");
    return EXIT_ARCHIVED;
  }
  report("Before", before, minDays);
  const lowBefore = minRemainingDays(before) < minDays;

  if (args.check) {
    if (lowBefore) console.error(`FAIL: remaining TTL is below ${minDays} days.`);
    return lowBefore ? EXIT_LOW : EXIT_OK;
  }

  if (!args.force && minRemainingDays(before) >= belowDays) {
    console.log(`Nothing to do: both entries are above EXTEND_IF_BELOW_DAYS=${belowDays}. (--force to extend anyway)`);
    return EXIT_OK;
  }

  // From here on a key is needed.
  const secret = keeperEnv.KEEPER_SECRET || process.env.KEEPER_SECRET;
  if (!secret) throw new Fail("KEEPER_SECRET is not set (use --keeper-file / KEEPER_ENV_FILE, or create one with --keygen)");
  let keeperKp;
  try {
    keeperKp = Keypair.fromSecret(secret.trim());
  } catch {
    throw new Fail("KEEPER_SECRET is not a valid Stellar secret key");
  }
  const keeper = keeperKp.publicKey();
  if (KNOWN_ORACLES.has(keeper)) throw new Fail(`REFUSING: ${keeper} is an oracle account. Use a separate keeper.`);
  const oracle = await readOracleAddress(server, contractId, net.passphrase);
  if (oracle === keeper) throw new Fail(`REFUSING: the keeper ${keeper} is this contract's oracle account. Use a separate keeper.`);
  console.log(`Keeper ${keeper} (oracle account ${oracle} is not used)`);

  const maxTtl = await readMaxEntryTtl(server);
  const extendToLedgers = Math.ceil(extendToDays * LEDGERS_PER_DAY);
  if (extendToLedgers >= maxTtl) {
    throw new Fail(`EXTEND_TO_DAYS=${extendToDays} exceeds the network maximum (${maxTtl} ledgers ~ ${fmtDays(maxTtl)} days)`);
  }

  await extend(server, net, before, keeperKp, extendToLedgers, maxFee);

  const after = await readState(server, contractId);
  if (!after.instance || !after.wasm) {
    report("After", after, minDays);
    return EXIT_ARCHIVED;
  }
  report("After", after, minDays);
  if (minRemainingDays(after) < minDays) {
    console.error(`FAIL: remaining TTL is still below ${minDays} days after the extension.`);
    return EXIT_LOW;
  }
  return EXIT_OK;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Print only the message: no stack traces that could echo environment values.
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof Fail ? err.code : EXIT_ERROR);
  }
);
