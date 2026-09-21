# SDK Release Procedure

> **Status: NOT YET PUBLISHED.** Verified on the dates below:
> - `npm view @stellar-vrf/sdk` → registry returns **404**
> - `https://crates.io/api/v1/crates/stellar-vrf-sdk` → `crate does not exist`
>
> Both packages are **publish-ready** (dry runs pass), but publishing requires
> registry credentials and must be done by the maintainer. Until then, the
> Tranche 3 criterion *"Developer SDK released (JS and Rust)"* is **not met**, and
> the README states plainly that the package is not on npm.

## Pre-flight (already verified)

| Check | Command | Result |
|---|---|---|
| JS builds against SDK v17.1.0 | `cd sdk/js && npm install && npm run build` | ✅ `tsc` clean |
| JS package contents correct | `cd sdk/js && npm publish --dry-run` | ✅ 8 files, public access |
| Rust tests pass | `cd sdk/rust && cargo test` | ✅ 11 + 1 passed |
| Rust crate packages | `cd sdk/rust && cargo publish --dry-run` | ✅ upload aborted by dry-run only |

## 1. Publish the JavaScript SDK

`@stellar-vrf/sdk` is a **scoped** package, so it would default to restricted
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
npm view @stellar-vrf/sdk version
cd /tmp && npm install @stellar-vrf/sdk @stellar/stellar-sdk
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
| npm package | `@stellar-vrf/sdk` |
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
with the plain `npm install @stellar-vrf/sdk @stellar/stellar-sdk` instruction so
reviewers are never given a command that fails.
