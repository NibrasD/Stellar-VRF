# SDK Release Procedure

## Status

_Registry state verified against the live registries (`npm view`, crates.io API)._

| SDK | Registry | Published | `latest` |
|---|---|---|---|
| JS — `stellar-vrf-sdk` | npm | 1.0.0, 1.0.1, **2.0.0** | **2.0.0** |
| Rust — `stellar-vrf-sdk` | crates.io | 1.0.0, 1.0.1, **2.0.0** | **2.0.0** |

### Released: **2.0.0**

Both manifests are at **2.0.0** (`sdk/js/package.json`, `sdk/rust/Cargo.toml`). The
release is **major** because the derivation API follows the audit round 5 contract changes.

> **Production Compatibility:** Version 2.0.0 is fully compatible with the live contracts
> (Mainnet `CAW6KECQ…UPRX`, Testnet `CBEDNSJ6…JTBR`, WASM `6a261a26…`). Changes in 2.0.0:

- **Breaking, both SDKs:** `deriveRandomInRange` / `derive_random_in_range` no longer take a
  `context` argument. The contract dropped it because a caller could choose it after seeing
  `beta` and grind the output.
- **New, both SDKs:** `deriveRangeForDomain` / `derive_range_for_domain` (domain ≤ 64 bytes, must
  be fixed before fulfillment) and `getBeta` / `get_beta`.
- **New, both SDKs:** offline equivalents that match the contract byte-for-byte:
  `deriveU64FromBeta` / `derive_u64_from_beta`, `deriveRangeFromBeta` / `derive_range_from_beta`,
  `deriveRangeForDomainFromBeta` / `derive_range_for_domain_from_beta` and `reduceUniform` /
  `reduce_uniform`. They use **exact** rejection sampling and fail explicitly with probability
  < 2^-128. Shared vectors (beta = `00..1f`, id 7) are asserted by the contract, both SDKs and
  the consumer example.
- **Deprecated:** `deriveRandomFromBeta` / `derive_random_from_beta`.
- **Rust SDK:** new dependency `sha2 = "0.10"`. **JS SDK:** `npm test` runs the vector tests.

Earlier unreleased changes, also included in 2.0.0:

- **Both SDKs:** client-side `deriveRandomFromBeta` / `derive_random_from_beta` now use 128 bits
  of beta instead of 64, which reduces bias for very large ranges. This **changes the output**
  for the same beta, so treat it as a minor release with a changelog note.
- **Both SDKs:** `deriveRandomInRange` / `derive_random_in_range` reject `[0, 2^64 − 1]` with a
  clear error. Its span (2^64) can't be passed as the contract's exclusive u64 bound. The Rust
  SDK previously overflowed here (panic in debug, wrap-to-0 in release). The Rust
  `derive_random_from_beta` now supports the full `[0, u64::MAX]` range; it previously
  overflowed before widening.
- **Rust SDK:** event `requester` values are proper StrKey addresses. Previously they were a
  non-decodable `G<hex>` string.
- **Docs:** the legacy client-side helpers are documented as **not** the same function as the
  contract's `derive_random_in_range`. Use the new `*FromBeta` functions above instead.

Publishing needs maintainer credentials: `npm login` with a publish-capable token, and
`cargo login`. After publishing, update the table above.

### ✅ Resolved in v1.0.1 — `Networks.MAINNET` was undefined in npm v1.0.0

Post-publish verification from a clean directory (`npm install stellar-vrf-sdk`)
found that `Networks.MAINNET` — the exact expression used in the README and in
the SDK's own doc comment — evaluated to **`undefined`**:

```js
import { VrfClient, Networks } from "stellar-vrf-sdk";
// VrfClient: function          ✔
// Networks.MAINNET: undefined  ✘  → networkPassphrase would be undefined
```

Cause: v1.0.0 did `export { Networks } from "@stellar/stellar-sdk"`, and
upstream names the live network **`PUBLIC`**, not `MAINNET`
(`PUBLIC,TESTNET,FUTURENET,SANDBOX,STANDALONE`).

**Fixed in the repo** (`sdk/js/src/index.ts`): `Networks` is now re-exported with
an added `MAINNET` alias for `PUBLIC`, so both spellings work and the documented
example is correct. Version bumped to **1.0.1** and **published** to npm.

(Historical) `npm publish` for 1.0.1 was first blocked by a staging-only token
(`E_STAGE_REQUIRED`). It was later published with a publish-capable token. See the status
table above.

### Rust SDK — PUBLISHED ✅

Initial publish (1.0.0); 1.0.1 followed on 2026-09-22:

```
Uploaded stellar-vrf-sdk v1.0.0 to registry `crates-io`
Published stellar-vrf-sdk v1.0.0 at registry `crates-io`
```

1.0.0 was independently verified from a clean scratch project:

```bash
cargo init --bin crate_check && cargo add stellar-vrf-sdk
#     Updating crates.io index
#       Adding stellar-vrf-sdk v1.0.0 to dependencies
#      Locking 164 packages to latest Rust 1.95.0 compatible versions
```

The registry API now lists `1.0.1` and `1.0.0`.
URL: <https://crates.io/crates/stellar-vrf-sdk>

### JS SDK — PUBLISHED ✅

Published by the maintainer as unscoped **`stellar-vrf-sdk`** (matching the crate
name). The `@stellar-vrf` and `@nibrasd` scopes do not exist, so scoped names
returned `404 Not Found`; the unscoped name is the one that works.

URL: <https://www.npmjs.com/package/stellar-vrf-sdk>

Independently verified from a clean directory:

```bash
npm init -y && npm install stellar-vrf-sdk @stellar/stellar-sdk
# added 42 packages

node -e 'import("stellar-vrf-sdk").then(m => console.log(typeof m.VrfClient))'
# function
```

The registry API now reports `dist-tags.latest = 1.0.1`.

## Pre-flight (already verified)

| Check | Command | Result |
|---|---|---|
| JS builds against SDK v17.1.0 | `cd sdk/js && npm install && npm run build` | ✅ `tsc` clean |
| JS package contents correct | `cd sdk/js && npm publish --dry-run` | ✅ 8 files, public access |
| Rust tests pass | `cd sdk/rust && cargo test` | ✅ 11 + 1 passed |
| Rust crate packages | `cd sdk/rust && cargo publish --dry-run` | ✅ upload aborted by dry-run only |

## 1. Publish the JavaScript SDK

`stellar-vrf-sdk` is **unscoped**. `publishConfig.access = "public"` is kept in
`package.json` anyway, so it's harmless if the package is ever scoped again.
`prepublishOnly` rebuilds `dist/` so a stale build can't ship.

```bash
cd sdk/js
npm version minor --no-git-tag-version   # e.g. 1.0.1 -> 1.1.0 (also bump sdk/rust/Cargo.toml)
npm login
npm whoami                # confirm auth (E401 means not logged in)
npm publish --otp=<code>
```

Verify:

```bash
npm view stellar-vrf-sdk version
cd /tmp && npm install stellar-vrf-sdk @stellar/stellar-sdk
```

## 2. Publish the Rust SDK

```bash
cd sdk/rust
cargo login              # token from https://crates.io/settings/tokens
cargo publish --dry-run  # final check
cargo publish
```

Verify:

```bash
cargo search stellar-vrf-sdk
cargo add stellar-vrf-sdk     # in a scratch project
```

## 3. Record the evidence

After both publishes succeed, fill this in and update the README to drop the
"not yet published" notice:

| Field | Value |
|---|---|
| npm package | `stellar-vrf-sdk` |
| npm version | _TBD_ |
| npm URL | _TBD_ |
| npm publish timestamp (UTC) | _TBD_ |
| `npm install` verified from clean dir | _TBD_ |
| crates.io crate | `stellar-vrf-sdk` |
| crates.io version | _TBD_ |
| crates.io URL | _TBD_ |
| cargo publish timestamp (UTC) | _TBD_ |
| `cargo add` verified from clean project | _TBD_ |

## 4. README follow-up (required)

`README.md` currently contains an explicit **"Registry status: not yet published
to npm"** notice plus a from-repo install path. Once published, replace that block
with the plain `npm install stellar-vrf-sdk @stellar/stellar-sdk` instruction so
reviewers are never given a command that fails.
