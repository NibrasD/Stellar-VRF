# SDK Release Procedure

## Status

| SDK | Registry | Status |
|---|---|---|
| Rust — `stellar-vrf-sdk` | crates.io | ✅ **PUBLISHED v1.0.0** |
| JS — `stellar-vrf-sdk` | npm | ❌ **blocked: token is staging-only** |

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

### JS SDK — NOT PUBLISHED ❌

Name settled as unscoped **`stellar-vrf-sdk`** (matching the crate name). The
`@stellar-vrf` scope never existed, and `@nibrasd` is not a registered scope
either — both returned `404 Not Found` on publish.

`npm whoami` with the supplied token resolves to **`nibrasd`**, so auth works,
but the token is **restricted to a staging area** and cannot create a brand-new
package:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/stellar-vrf-sdk
npm error Cannot publish "stellar-vrf-sdk": this token can only publish to a
npm error staging area, and "stellar-vrf-sdk" does not exist yet. Create it
npm error first with a direct-capable token, then use `npm stage publish`.
npm error (E_STAGE_REQUIRED)
```

(`npm stage` is not a command in npm 11.12.1, so that hint is a dead end here.)

**What is needed:** a *direct-capable* npm token — i.e. either
1. an **Automation** token (created at
   <https://www.npmjs.com/settings/nibrasd/tokens>, type "Automation", which
   bypasses 2FA), or
2. an interactive `npm login` followed by `npm publish --otp=<6-digit-code>`.

Then, from the repo:

```powershell
cd sdk/js
npm publish            # with an Automation token in ~/.npmrc
# ── or ──
npm login
npm publish --otp=123456
```

Everything else is already verified green: `npm run build` (tsc clean),
`npm publish --dry-run` (8 files, **public access**), correct `files` allowlist,
`prepublishOnly` rebuild guard.

Until this succeeds, the Tranche 3 criterion *"Developer SDK released (JS and
Rust)"* is only **half met**, and the README continues to say plainly that the
npm package is not yet published.

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
