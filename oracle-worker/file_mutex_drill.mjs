/**
 * file_mutex_drill.mjs — the single-host fallbacks (file leader lock, file
 * spend ledger) must be race-free between real OS processes.
 *
 *   1. 4 processes × 25 read-modify-write increments under withFileMutex:
 *      the counter must end at exactly 100 (no lost updates).
 *   2. 6 processes race FileSpendLedger.tryReserve(COST, limit = 10×COST),
 *      5 reservations each: exactly 10 are granted, the total never exceeds
 *      the limit.
 *
 * Usage: npm run build && node file_mutex_drill.mjs   (exit 0 = pass)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mutexUrl = pathToFileURL(path.join(here, "dist", "fileMutex.js")).href;
const ledgerUrl = pathToFileURL(path.join(here, "dist", "spendLedger.js")).href;

let failed = false;
function check(ok, msg) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) failed = true;
}

function run(code) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (c) => resolve({ code: c ?? 1, out }));
  });
}

const tmp = (n) => path.join(os.tmpdir(), `vrf-drill-${n}-${process.pid}-${Date.now()}`);

// 1. Lost-update test.
{
  const counter = tmp("counter");
  fs.writeFileSync(counter, "0");
  const child = `
    const { withFileMutex } = await import(${JSON.stringify(mutexUrl)});
    const fs = await import("fs");
    const f = ${JSON.stringify(counter)};
    for (let i = 0; i < 25; i++) {
      withFileMutex(f, () => {
        const v = Number(fs.readFileSync(f, "utf8"));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); // widen the race
        fs.writeFileSync(f, String(v + 1));
      }, { timeoutMs: 30000 });
    }
  `;
  const res = await Promise.all(Array.from({ length: 4 }, () => run(child)));
  check(res.every((r) => r.code === 0), "all incrementing processes exited cleanly");
  check(Number(fs.readFileSync(counter, "utf8")) === 100, `counter is exactly 100 (got ${fs.readFileSync(counter, "utf8")})`);
  fs.rmSync(counter, { force: true });
}

// 2. Spend-ledger race.
{
  const file = tmp("ledger") + ".json";
  const COST = 1_000_000n;
  const LIMIT = 10n * COST;
  const child = `
    const { FileSpendLedger } = await import(${JSON.stringify(ledgerUrl)});
    const l = new FileSpendLedger(${JSON.stringify(file)});
    let granted = 0;
    for (let i = 0; i < 5; i++) {
      if (await l.tryReserve(${COST}n, Date.now(), ${LIMIT}n)) granted++;
    }
    process.stdout.write(String(granted));
  `;
  const res = await Promise.all(Array.from({ length: 6 }, () => run(child)));
  const granted = res.reduce((a, r) => a + Number(r.out || "0"), 0);
  check(res.every((r) => r.code === 0), "all reserving processes exited cleanly");
  check(granted === 10, `exactly 10 of 30 concurrent reservations granted (got ${granted})`);
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  const total = entries.reduce((a, e) => a + BigInt(e.amount), 0n);
  check(total <= LIMIT, `ledger total ${total} <= limit ${LIMIT}`);
  fs.rmSync(file, { force: true });
}

process.exit(failed ? 1 : 0);
