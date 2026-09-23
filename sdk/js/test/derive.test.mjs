// derive.test.mjs — the JS SDK's offline derivation must match the contract
// byte-for-byte. Run after `npm run build`:  npm test
// Vectors are shared with soroban-contract (test_derive_vectors_shared_with_sdks)
// and sdk/rust (test_derive_vectors_match_contract).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveU64FromBeta,
  deriveRangeFromBeta,
  deriveRangeForDomainFromBeta,
  reduceUniform,
  MAX_DERIVE_DOMAIN_LEN,
} from "../dist/index.js";

const beta = Uint8Array.from({ length: 32 }, (_, i) => i);
const U64_MAX = (1n << 64n) - 1n;

test("shared vectors match the contract", () => {
  assert.equal(deriveU64FromBeta(beta, 7n), 17155214937666214782n);
  assert.equal(deriveRangeFromBeta(beta, 7n, 6n), 4n);
  assert.equal(deriveRangeFromBeta(beta, 7n, 1000000n), 889164n);
  assert.equal(deriveRangeFromBeta(beta, 7n, U64_MAX), 11798261183955500607n);
  assert.equal(deriveRangeForDomainFromBeta(beta, 7n, new TextEncoder().encode("card-1"), 1000n), 595n);
});

function halves(c1, c2) {
  const h = new Uint8Array(32);
  const dv = new DataView(h.buffer);
  dv.setBigUint64(0, c1 >> 64n); dv.setBigUint64(8, c1 & U64_MAX);
  dv.setBigUint64(16, c2 >> 64n); dv.setBigUint64(24, c2 & U64_MAX);
  return h;
}
const U128_MAX = (1n << 128n) - 1n;

test("reduceUniform follows the contract's accept/reject rule", () => {
  assert.equal(reduceUniform(halves(123456789n, 42n), 1000003n), 123456789n % 1000003n);
  assert.equal(reduceUniform(halves(U128_MAX, 5n), 3n), 2n); // limit rejected, 2nd half used
  assert.throws(() => reduceUniform(halves(U128_MAX, U128_MAX), (1n << 63n) + 1n), /both candidates rejected/);
  assert.equal(reduceUniform(halves(U128_MAX, U128_MAX), 1n << 32n), (1n << 32n) - 1n);
});

test("edge cases", () => {
  assert.equal(deriveRangeFromBeta(beta, 7n, 1n), 0n);
  assert.throws(() => deriveRangeFromBeta(beta, 7n, 0n));
  assert.throws(() => deriveRangeForDomainFromBeta(beta, 7n, new Uint8Array(MAX_DERIVE_DOMAIN_LEN + 1), 10n));
  assert.ok(deriveRangeForDomainFromBeta(beta, 7n, new Uint8Array(MAX_DERIVE_DOMAIN_LEN), 10n) < 10n);
  assert.throws(() => deriveRangeFromBeta(new Uint8Array(16), 7n, 10n), /32 bytes/);
});
