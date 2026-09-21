# SDK Release Procedure

> **Status: BLOCKED ON 2FA — one command away.**
>
> The package was renamed to the **`@nibrasd`** scope (owned by the maintainer);
> the previous `@stellar-vrf` scope did not exist. A real `npm publish` was then
> attempted and got as far as the registry accepting the name and auth token,
> failing **only** on two-factor authentication:
>
> ```
> npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
> npm error code E403
> npm error 403 Forbidden - PUT https://registry.npmjs.org/@nibrasd%2fstellar-vrf-sdk
> npm error Two-factor authentication or granular access token with bypass 2fa
> npm error enabled is required to publish packages.
> ```
>
> This confirms: name available, token valid, package contents valid, public
> access configured. **The only missing input is an OTP from the maintainer's
> authenticator**, which cannot be automated.
>
> Until published, the Tranche 3 criterion *"Developer SDK released (JS and
> Rust)"* is **not met**, and the README says plainly that the package is not yet
> on npm.

## Publish it (maintainer, ~2 minutes)

```powershell
cd sdk/js
npm publish --otp=123456      # 6-digit code from your authenticator app
```

Alternatively create a **granular access token** with "bypass 2FA" at
<https://www.npmjs.com/settings/nibrasd/tokens> and then plain `npm publish` works.

```powershell
cd sdk/rust
cargo login                   # token from https://crates.io/settings/tokens
cargo publish
```

## Pre-flight (already verified)

| Check | Command | Result |
|---|---|---|
| JS builds against SDK v17.1.0 | `cd sdk/js && npm install && npm run build` | ✅ `tsc` clean |
| JS package contents correct | `cd sdk/js && npm publish --dry-run` | ✅ 8 files, public access |
| Rust tests pass | `cd sdk/rust && cargo test` | ✅ 11 + 1 passed |
| Rust crate packages | `cd sdk/rust && cargo publish --dry-run` | ✅ upload aborted by dry-run only |

## 1. Publish the JavaScript SDK

`@nibrasd/stellar-vrf-sdk` is a **scoped** package, so it would default to restricted
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
npm view @nibrasd/stellar-vrf-sdk version
cd /tmp && npm install @nibrasd/stellar-vrf-sdk @stellar/stellar-sdk
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
| npm package | `@nibrasd/stellar-vrf-sdk` |
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
with the plain `npm install @nibrasd/stellar-vrf-sdk @stellar/stellar-sdk` instruction so
reviewers are never given a command that fails.
