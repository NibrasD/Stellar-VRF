# SDK Release Procedure

## Status

| SDK | Registry | Status |
|---|---|---|
| Rust — `stellar-vrf-sdk` | crates.io | ✅ **PUBLISHED v1.0.1** (2026-09-22) |
| JS — `stellar-vrf-sdk` | npm | ✅ **PUBLISHED v1.0.1** (`latest`, gitHead `e90347e`) |

> ⚠️ **Not yet released:** the 128-bit `deriveRandomInRange` / `derive_random_in_range`
> bias fix and the Rust SDK's proper StrKey address encoding are in the repo but were
> **not** part of 1.0.1 (npm 1.0.1 `gitHead` is `e90347e`; the fixes are newer than that
> commit and the crates.io 1.0.1 code-line count is identical to 1.0.0). They require a new
> release (changes random-in-range output for the same beta → treat as minor/breaking).

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

(Historical) `npm publish` for 1.0.1 was initially blocked by a staging-only token:

```
npm error 403 This token can only publish to a staging area.
npm error Run `npm stage publish` to publish this version, then approve it.
npm error (E_STAGE_REQUIRED)
```

**Action required:** publish 1.0.1 with a direct-capable token so npm users get
the working `Networks.MAINNET`:

```powershell
cd sdk/js
npm login
npm publish --otp=<6-digit-code>
```

### Rust SDK — PUBLISHED ✅

```
Uploaded stellar-vrf-sdk v1.0.0 to registry `crates-io`
Published stellar-vrf-sdk v1.0.0 at registry `crates-io`
```

Independently verified from a clean scratch project:

```bash
cargo init --bin crate_check && cargo add stellar-vrf-sdk
#     Updating crates.io index
#       Adding stellar-vrf-sdk v1.0.0 to dependencies
#      Locking 164 packages to latest Rust 1.95.0 compatible versions
```

Registry API confirms: `stellar-vrf-sdk v1.0.0`.
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

Registry API confirms `dist-tags.latest = 1.0.0`.

**See the known issue above — v1.0.1 still needs publishing.**

## Pre-flight (already verified)

| Check | Command | Result |
|---|---|---|
| JS builds against SDK v17.1.0 | `cd sdk/js && npm install && npm run build` | ✅ `tsc` clean |
| JS package contents correct | `cd sdk/js && npm publish --dry-run` | ✅ 8 files, public access |
| Rust tests pass | `cd sdk/rust && cargo test` | ✅ 11 + 1 passed |
| Rust crate packages | `cd sdk/rust && cargo publish --dry-run` | ✅ upload aborted by dry-run only |

## 1. Publish the JavaScript SDK

`stellar-vrf-sdk` is a **scoped** package, so it would default to restricted
access. `publishConfig.access = "public"` is set in `package.json` to prevent a
paid-org error. `prepublishOnly` rebuilds `dist/` so a stale build can't ship.

```bash
cd sdk/js
npm login                 # must be a member of the @stellar-vrf org/scope
npm whoami                # confirm auth (E401 means not logged in)
npm publish               # access:public comes from publishConfig
```

Verify:

```bash
npm view stellar-vrf-sdk version
cd /tmp && npm install stellar-vrf-sdk @stellar/stellar-sdk
```

> If the `@stellar-vrf` scope is not yet registered, create the org on npm first,
> or rename the package to an unscoped name you control.

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
