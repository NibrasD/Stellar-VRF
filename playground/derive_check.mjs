// derive_check.mjs — proves the playground's browser-side derivation equals the
// contract's derive_random_in_range().
//
//   node playground/derive_check.mjs                 # offline: shared vectors
//   LIVE=1 node playground/derive_check.mjs [ids…]   # + compare with Mainnet
//   NETWORK=testnet LIVE=1 node playground/derive_check.mjs 1 2
//
// The derivation code is extracted verbatim from playground/index.html (not
// re-implemented), so this tests exactly what the deployed page runs. The live
// part reads get_beta / derive_random_in_range through simulateTransaction from
// an unfunded throwaway account, the same keyless path the page uses.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");

const start = html.indexOf("const U64_MAX = (1n << 64n) - 1n;");
const endMarker = "window.deriveRangeFromBeta = deriveRangeFromBeta;";
const end = html.indexOf(endMarker);
assert.ok(start > 0 && end > start, "derivation block not found in index.html");
const code = html.slice(start, end + endMarker.length);

const sandbox = { window: {}, crypto: globalThis.crypto, TextEncoder, Uint8Array, DataView, BigInt, Array, Error, parseInt };
sandbox.window.crypto = globalThis.crypto;
vm.createContext(sandbox);
vm.runInContext(code + "\n;globalThis.__d = { deriveRangeFromBeta, reduceUniform };", sandbox);
const { deriveRangeFromBeta } = sandbox.__d;

// ── Offline: vectors shared with soroban-contract and both SDKs ─────────────
const beta = Uint8Array.from({ length: 32 }, (_, i) => i);
const U64_MAX = (1n << 64n) - 1n;
assert.equal(await deriveRangeFromBeta(beta, 7n, 6n), 4n);
assert.equal(await deriveRangeFromBeta(beta, 7n, 1_000_000n), 889164n);
assert.equal(await deriveRangeFromBeta(beta, 7n, U64_MAX), 11798261183955500607n);
assert.equal(await deriveRangeFromBeta(beta, 7n, 1n), 0n);
await assert.rejects(deriveRangeFromBeta(beta, 7n, 0n));
await assert.rejects(deriveRangeFromBeta(new Uint8Array(16), 7n, 10n), /32 bytes/);
console.log("PASS offline: playground derivation matches the shared contract/SDK vectors");

// Cross-check against the SDK implementation over many inputs.
const sdkPath = path.join(here, "..", "sdk", "js", "dist", "index.js");
if (fs.existsSync(sdkPath)) {
  const sdk = await import("file://" + sdkPath.replace(/\\/g, "/"));
  const { randomBytes } = await import("node:crypto");
  let n = 0;
  for (let i = 0; i < 500; i++) {
    const b = new Uint8Array(randomBytes(32));
    const id = BigInt(i * 7919);
    for (const max of [2n, 3n, 6n, 100n, 1000n, (1n << 63n) + 1n, U64_MAX]) {
      assert.equal(await deriveRangeFromBeta(b, id, max), sdk.deriveRangeFromBeta(b, id, max));
      n++;
    }
  }
  console.log(`PASS offline: ${n} random cases identical to sdk/js deriveRangeFromBeta`);
}

// ── Live: browser result vs on-chain derive_random_in_range ─────────────────
if (process.env.LIVE) {
  const require = createRequire(import.meta.url);
  const roots = [path.join(here, "..", "sdk", "js"), path.join(here, "..", "oracle-worker"), path.join(here, "..")];
  let SDK;
  for (const r of roots) {
    try { SDK = require(require.resolve("@stellar/stellar-sdk", { paths: [r] })); break; } catch {}
  }
  assert.ok(SDK, "@stellar/stellar-sdk not found");
  const { Keypair, Account, TransactionBuilder, Operation, nativeToScVal, scValToNative, rpc } = SDK;

  const NETS = {
    mainnet: ["CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX", "https://mainnet.sorobanrpc.com", "Public Global Stellar Network ; September 2015"],
    testnet: ["CBEDNSJ63LANUSJHRZSNQUV22X6JYU6E7PTUDIGQDOHNH7VIT4CAJTBR", "https://soroban-testnet.stellar.org", "Test SDF Network ; September 2015"],
  };
  const [contract, url, passphrase] = NETS[process.env.NETWORK || "mainnet"];
  const server = new rpc.Server(url, { allowHttp: false });
  const source = Keypair.random().publicKey(); // never funded

  const simulate = async (fn, args) => {
    const tx = new TransactionBuilder(new Account(source, "0"), { fee: "1000000", networkPassphrase: passphrase })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
      .setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    return sim.result?.retval ? scValToNative(sim.result.retval) : null;
  };

  const ids = process.argv.slice(2).map(BigInt);
  if (ids.length === 0) ids.push(1n, 2n, 3n);
  console.log(`\nLIVE ${process.env.NETWORK || "mainnet"} ${contract}`);
  let fail = 0;
  for (const id of ids) {
    const u64 = { type: "u64" };
    if (!(await simulate("is_fulfilled", [nativeToScVal(id, u64)]))) { console.log(`#${id}: not fulfilled, skipped`); continue; }
    const betaOnChain = new Uint8Array(await simulate("get_beta", [nativeToScVal(id, u64)]));
    const betaHex = Buffer.from(betaOnChain).toString("hex");
    for (const span of [6n, 100n, 1000n, 1_000_000n, U64_MAX]) {
      const browser = await deriveRangeFromBeta(betaOnChain, id, span);
      const chain = BigInt(await simulate("derive_random_in_range", [nativeToScVal(id, u64), nativeToScVal(span, u64)]));
      const naive = BigInt("0x" + betaHex.slice(0, 16)) % span; // the OLD playground formula
      const ok = browser === chain;
      if (!ok) fail++;
      console.log(`#${id} max=${span}: browser=${browser} on-chain=${chain} ${ok ? "MATCH" : "MISMATCH"}  (old modulo formula gave ${naive}${naive === chain ? "" : " ≠ on-chain"})`);
    }
  }
  if (fail) { console.error(`${fail} MISMATCH(ES)`); process.exit(1); }
  console.log("PASS live: browser derivation == on-chain derive_random_in_range()");
}
