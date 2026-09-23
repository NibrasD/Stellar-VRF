#![no_std]
#![allow(unknown_lints)]
#![allow(deprecated)]
#![allow(dos_unexpected_revert_with_storage)]

#[cfg(test)]
mod test;
#[cfg(any(test, feature = "testutils"))]
pub mod testkeys;

use soroban_sdk::crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND: u32 = 518_400;
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND: u32 = 518_400;

const DRAND_DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const VRF_DST: &[u8] = b"SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_";
const BETA_DOMAIN: &[u8] = b"VREP_BETA_V1";
/// Domain tag for every value derived from a stored beta. `V2` because the
/// derivation input changed in this version: it is now bound to the request id
/// and (for range derivations) no longer takes a caller-chosen context.
const DERIVE_DOMAIN: &[u8] = b"VREP_DERIVE_V2";
/// Sub-domains inside `DERIVE_DOMAIN`, so a `u64` draw and a range draw of the
/// same request never share hash input.
const DERIVE_TAG_U64: u8 = 0x01;
const DERIVE_TAG_RANGE: u8 = 0x02;
const DERIVE_TAG_RANGE_DOMAIN: u8 = 0x03;
const MIN_ROUND_OFFSET: u32 = 2;
const TIMEOUT_ROUNDS: u64 = 20;
const MAX_CONTEXT_LEN: u32 = 1024;
/// Maximum length of the optional domain separator accepted by
/// `derive_range_for_domain()`.
pub const MAX_DERIVE_DOMAIN_LEN: u32 = 64;

/// Canonical generator of the BLS12-381 G2 group, uncompressed
/// (`X.c1 ‖ X.c0 ‖ Y.c1 ‖ Y.c0`, big-endian, 192 bytes).
///
/// This is a fixed parameter of the curve, not per-deployment configuration.
/// Earlier versions took it as an `init()` argument and stored it, so a typo at
/// deployment produced a contract that could never verify a proof. It is now
/// compiled in. The value matches `G2.ProjectivePoint.BASE` in `@noble/curves`
/// and the generator in the IETF BLS signature draft.
pub const BLS12_381_G2_GENERATOR: [u8; 192] = [
    0x13, 0xe0, 0x2b, 0x60, 0x52, 0x71, 0x9f, 0x60, 0x7d, 0xac, 0xd3, 0xa0, 0x88, 0x27, 0x4f, 0x65,
    0x59, 0x6b, 0xd0, 0xd0, 0x99, 0x20, 0xb6, 0x1a, 0xb5, 0xda, 0x61, 0xbb, 0xdc, 0x7f, 0x50, 0x49,
    0x33, 0x4c, 0xf1, 0x12, 0x13, 0x94, 0x5d, 0x57, 0xe5, 0xac, 0x7d, 0x05, 0x5d, 0x04, 0x2b, 0x7e,
    0x02, 0x4a, 0xa2, 0xb2, 0xf0, 0x8f, 0x0a, 0x91, 0x26, 0x08, 0x05, 0x27, 0x2d, 0xc5, 0x10, 0x51,
    0xc6, 0xe4, 0x7a, 0xd4, 0xfa, 0x40, 0x3b, 0x02, 0xb4, 0x51, 0x0b, 0x64, 0x7a, 0xe3, 0xd1, 0x77,
    0x0b, 0xac, 0x03, 0x26, 0xa8, 0x05, 0xbb, 0xef, 0xd4, 0x80, 0x56, 0xc8, 0xc1, 0x21, 0xbd, 0xb8,
    0x06, 0x06, 0xc4, 0xa0, 0x2e, 0xa7, 0x34, 0xcc, 0x32, 0xac, 0xd2, 0xb0, 0x2b, 0xc2, 0x8b, 0x99,
    0xcb, 0x3e, 0x28, 0x7e, 0x85, 0xa7, 0x63, 0xaf, 0x26, 0x74, 0x92, 0xab, 0x57, 0x2e, 0x99, 0xab,
    0x3f, 0x37, 0x0d, 0x27, 0x5c, 0xec, 0x1d, 0xa1, 0xaa, 0xa9, 0x07, 0x5f, 0xf0, 0x5f, 0x79, 0xbe,
    0x0c, 0xe5, 0xd5, 0x27, 0x72, 0x7d, 0x6e, 0x11, 0x8c, 0xc9, 0xcd, 0xc6, 0xda, 0x2e, 0x35, 0x1a,
    0xad, 0xfd, 0x9b, 0xaa, 0x8c, 0xbd, 0xd3, 0xa7, 0x6d, 0x42, 0x9a, 0x69, 0x51, 0x60, 0xd1, 0x2c,
    0x92, 0x3a, 0xc9, 0xcc, 0x3b, 0xac, 0xa2, 0x89, 0xe1, 0x93, 0x54, 0x86, 0x08, 0xb8, 0x28, 0x01,
];

#[contracttype]
#[derive(Clone)]
pub struct BlsVrfProof {
    pub alpha_seed: BytesN<32>,
    pub gamma_point: BytesN<96>,
    pub beta_output: BytesN<32>,
    pub public_key: BytesN<192>,
    pub drand_round: u64,
    pub drand_signature: BytesN<96>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    OraclePK,
    OracleAddr,
    OracleEd25519,
    DrandPK,
    DrandGenesis,
    DrandPeriod,
    RoundOffset,
    Counter,
    RequestContext(u64),
    Requester(u64),
    RequestRound(u64),
    Refunded(u64),
    CallbackContract(u64),
    CallbackFn(u64),
    /// Full proof (~450 bytes). Removable with `cleanup_proof()`.
    Proof(u64),
    /// Verified 32-byte VRF output. Written at fulfillment and **kept** by
    /// `cleanup_proof()`, so `get_beta()` / `derive_*()` keep working after the
    /// bulky proof is gone. Subject to normal persistent-storage TTL.
    Beta(u64),
    Fulfilled(u64),
    /// Transient re-entrancy guard: set true while callback is in-flight.
    /// Prevents a malicious callback from re-entering fulfill().
    Fulfilling(u64),
    /// SAC token address used for per-request fees.
    FeeToken,
    /// Fee amount (i128) charged per VRF request.
    FeeAmount,
}


#[contract]
pub struct VRFOracleContract;

#[contractimpl]
impl VRFOracleContract {
    /// Atomic constructor (Soroban Protocol 22+). Runs exactly once, inside the
    /// same host call that creates the contract instance.
    ///
    /// # Why a constructor instead of `init()`
    /// Earlier versions had a public `init()` guarded only by
    /// "already initialized". Deploy and init were two transactions, so anyone
    /// watching the deploy could call `init()` first with an oracle address they
    /// controlled (front-running). There is now **no** initialization
    /// entrypoint: configuration can only be supplied by whoever creates the
    /// instance (`createCustomContract` with constructor args, or
    /// `env.register(.., args)` in tests), and the host refuses to run a
    /// constructor twice.
    ///
    /// `oracle_address.require_auth()` is kept so the oracle account must also
    /// sign the deployment: nobody can deploy an instance that names someone
    /// else's account as its oracle.
    ///
    /// # Validation (fail closed)
    /// Every key is checked before anything is stored, so a misconfiguration
    /// aborts the deployment instead of producing a contract whose every
    /// `fulfill()` fails. See `validate_g2_public_key()` / `validate_ed25519_key()`.
    ///
    /// # Parameters
    /// - `fee_token`: SAC token address used to charge per-request fees.
    /// - `fee_amount`: Amount of `fee_token` charged per VRF request (escrowed from
    ///   the requester, released to the oracle on fulfillment). 0 = fee-free.
    ///
    /// The BLS12-381 G2 generator is **not** a parameter: it is the compiled-in
    /// constant [`BLS12_381_G2_GENERATOR`].
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        oracle_pk: BytesN<192>,
        oracle_address: Address,
        oracle_ed25519_pk: BytesN<32>,
        drand_pk: BytesN<192>,
        drand_genesis_time: u64,
        drand_period: u32,
        round_offset: u32,
        fee_token: Address,
        fee_amount: i128,
    ) {
        if drand_period == 0 {
            panic!("drand period must be > 0");
        }
        if round_offset < MIN_ROUND_OFFSET {
            panic!("round_offset must be >= 2");
        }
        if fee_amount < 0 {
            panic!("fee_amount must be >= 0");
        }
        validate_g2_public_key(&env, &oracle_pk, "oracle pk");
        validate_g2_public_key(&env, &drand_pk, "drand pk");
        if oracle_pk == drand_pk {
            panic!("oracle pk must differ from drand pk");
        }
        validate_ed25519_key(&oracle_ed25519_pk);

        oracle_address.require_auth();
        env.storage().instance().set(&DataKey::OraclePK, &oracle_pk);
        env.storage().instance().set(&DataKey::OracleAddr, &oracle_address);
        env.storage().instance().set(&DataKey::OracleEd25519, &oracle_ed25519_pk);
        env.storage().instance().set(&DataKey::DrandPK, &drand_pk);
        env.storage().instance().set(&DataKey::DrandGenesis, &drand_genesis_time);
        env.storage().instance().set(&DataKey::DrandPeriod, &drand_period);
        env.storage().instance().set(&DataKey::RoundOffset, &round_offset);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage().instance().set(&DataKey::FeeToken, &fee_token);
        env.storage().instance().set(&DataKey::FeeAmount, &fee_amount);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish((symbol_short!("init"),), oracle_pk);
    }

    /// Rotate the oracle's BLS public key, Stellar address, and Ed25519 signing key.
    ///
    /// # Authorization model
    /// The **current** oracle address must authorize this call. This prevents an
    /// attacker who obtains a new keypair from hijacking the oracle role.
    ///
    /// # Security note
    /// Pending requests are **not** locked to the oracle key that was active at
    /// request time. At fulfillment, `fulfill()` checks the **currently configured**
    /// oracle key in instance storage. This means:
    /// - The **new** oracle can fulfill requests created before rotation.
    /// - The **old** oracle (or an attacker with old keys) cannot fulfill after rotation.
    /// - Consequently, whoever controls the **current** oracle account can rotate
    ///   to a key chosen after a request's drand round is public and bias that
    ///   request's output. The oracle account is trusted for bias resistance;
    ///   protect it with multisig / a hardware signer and monitor `rotate_ok`.
    ///
    /// Best practice: rotate keys only after the new oracle node is running and
    /// ready to fulfill requests, to avoid a gap where no oracle is active.
    pub fn rotate_oracle_keys(
        env: Env,
        new_oracle_pk: BytesN<192>,
        new_oracle_address: Address,
        new_oracle_ed25519_pk: BytesN<32>,
    ) {
        // Current oracle must authorize the rotation.
        let current_oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("not initialized"));
        current_oracle.require_auth();

        // Fail closed: a structurally valid but unusable key would make every
        // later fulfill() fail and strand pending requests until timeout.
        validate_g2_public_key(&env, &new_oracle_pk, "oracle pk");
        let drand_pk: BytesN<192> = env
            .storage()
            .instance()
            .get(&DataKey::DrandPK)
            .unwrap_or_else(|| panic!("drand pk missing"));
        if new_oracle_pk == drand_pk {
            panic!("oracle pk must differ from drand pk");
        }
        validate_ed25519_key(&new_oracle_ed25519_pk);

        env.storage().instance().set(&DataKey::OraclePK, &new_oracle_pk);
        env.storage().instance().set(&DataKey::OracleAddr, &new_oracle_address);
        env.storage().instance().set(&DataKey::OracleEd25519, &new_oracle_ed25519_pk);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (symbol_short!("rotate_ok"),),
            (new_oracle_pk, new_oracle_address),
        );
    }

    /// Rotate the drand public key used to verify BLS beacon signatures.
    ///
    /// Use this when the configured drand chain rotates its group key. It is
    /// **not** a chain migration: `DrandGenesis`, `DrandPeriod` and the signature
    /// DST (quicknet, G1, unchained) are fixed at construction or compiled in, and the
    /// contract has no upgrade entrypoint. Moving to a different drand chain
    /// requires deploying a new contract instance.
    ///
    /// # Authorization model
    /// The current oracle must authorize this call.
    ///
    /// # Security note
    /// This key is what makes alpha unpredictable to the oracle. A holder of the
    /// oracle account who installs a key it controls can sign any "beacon" and
    /// therefore choose outputs, including for pending requests. Treat every
    /// `rotate_dk` event as security-relevant.
    pub fn rotate_drand_pk(env: Env, new_drand_pk: BytesN<192>) {
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("not initialized"));
        oracle_addr.require_auth();

        validate_g2_public_key(&env, &new_drand_pk, "drand pk");
        let oracle_pk: BytesN<192> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap_or_else(|| panic!("oracle pk missing"));
        if new_drand_pk == oracle_pk {
            panic!("oracle pk must differ from drand pk");
        }

        env.storage().instance().set(&DataKey::DrandPK, &new_drand_pk);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish((symbol_short!("rotate_dk"),), new_drand_pk);
    }

    pub fn request(env: Env, context: Bytes, requester: Address) -> u64 {
        request_internal(&env, context, requester, None, None)
    }

    /// Request verifiable randomness with an on-chain callback.
    ///
    /// # Confused-Deputy Security Model
    /// - `callback_contract` must equal `requester`: only contracts requesting
    ///   randomness for themselves may receive callbacks.
    /// - `callback_contract.require_auth()` is enforced to ensure authorization.
    /// - `callback_fn` is restricted to `on_vrf` to prevent arbitrary dispatch.
    pub fn request_with_callback(
        env: Env,
        context: Bytes,
        requester: Address,
        callback_contract: Address,
        callback_fn: Symbol,
    ) -> u64 {
        if requester != callback_contract {
            panic!("callback_contract must match requester");
        }
        if callback_fn != Symbol::new(&env, "on_vrf") {
            panic!("callback_fn must be on_vrf");
        }

        request_internal(
            &env,
            context,
            requester,
            Some(callback_contract),
            Some(callback_fn),
        )
    }

    pub fn timeout_refund(env: Env, request_id: u64) {
        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("already refunded");
        }

        if !env.storage().persistent().has(&DataKey::Requester(request_id)) {
            panic!("request not found");
        }

        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("requester not found"));
        requester.require_auth();

        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if fulfilled {
            panic!("already fulfilled");
        }

        let required_round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request round missing"));
        let genesis: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DrandGenesis)
            .unwrap_or_else(|| panic!("genesis missing"));
        let period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DrandPeriod)
            .unwrap_or_else(|| panic!("period missing"));
        let current_round = compute_current_round(env.ledger().timestamp(), genesis, period);
        if current_round <= required_round.saturating_add(TIMEOUT_ROUNDS) {
            panic!("timeout window not reached");
        }

        env.storage().persistent().set(&DataKey::Refunded(request_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Refunded(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Delete obsolete transient request storage to immediately reclaim storage rent.
        if env
            .storage()
            .persistent()
            .has(&DataKey::RequestContext(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::RequestContext(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackContract(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::CallbackContract(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackFn(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::CallbackFn(request_id));
        }

        // Refund escrowed fee back to requester.
        let fee_amount: i128 = env.storage().instance().get(&DataKey::FeeAmount).unwrap_or(0);
        if fee_amount > 0 {
            let fee_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeToken)
                .unwrap_or_else(|| panic!("fee token missing"));
            let contract_addr = env.current_contract_address();
            let transfer_fn = Symbol::new(&env, "transfer");
            let mut args = Vec::<Val>::new(&env);
            args.push_back(contract_addr.into_val(&env));
            args.push_back(requester.clone().into_val(&env));
            args.push_back(fee_amount.into_val(&env));
            env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
        }

        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish((symbol_short!("timeout"),), (request_id, requester));
    }

    pub fn timeout_rounds(_env: Env) -> u64 {
        TIMEOUT_ROUNDS
    }

    pub fn requester_of(env: Env, request_id: u64) -> Address {
        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::Requester(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        requester
    }

    pub fn is_refunded(env: Env, request_id: u64) -> bool {
        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if env.storage().persistent().has(&DataKey::Refunded(request_id)) {
            env.storage().persistent().extend_ttl(
                &DataKey::Refunded(request_id),
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }
        refunded
    }

    pub fn callback_of(env: Env, request_id: u64) -> Option<(Address, Symbol)> {
        if !env.storage().persistent().has(&DataKey::CallbackContract(request_id)) {
            return None;
        }
        let cb_contract: Address = env
            .storage()
            .persistent()
            .get(&DataKey::CallbackContract(request_id))
            .unwrap_or_else(|| panic!("callback contract missing"));
        let cb_fn: Symbol = env
            .storage()
            .persistent()
            .get(&DataKey::CallbackFn(request_id))
            .unwrap_or_else(|| panic!("callback fn missing"));
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackContract(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackFn(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        Some((cb_contract, cb_fn))
    }

    /// Fulfill a VRF request with a BLS proof and oracle Ed25519 signature.
    ///
    /// # Checks-Effects-Interactions (CEI) pattern
    /// 1. **Checks**: validate oracle identity, proof, alpha seed, BLS signatures.
    /// 2. **Effects**: write `Fulfilled = true` and store proof BEFORE any external call.
    /// 3. **Interactions**: invoke consumer callback (if registered) only AFTER state
    ///    is fully committed, with a re-entrancy guard to block nested `fulfill()` calls.
    ///
    /// # Re-entrancy protection
    /// `DataKey::Fulfilling(request_id)` is set to `true` before callback invocation
    /// and cleared after. Any re-entrant call to `fulfill()` for the same request_id
    /// will see `Fulfilling = true` and panic with "fulfill already in progress".
    /// This provides defense-in-depth alongside the `Fulfilled = true` check.
    ///
    /// # Resource budget
    /// The **VRF core** (checks + effects + fee transfer, i.e. everything except
    /// the consumer callback) targets ≤ 75M CPU instructions (measured ~58M on
    /// Mainnet). That target **excludes** the callback. The callback runs in the
    /// same transaction and adds its own cost to the same transaction-wide limit.
    pub fn fulfill(env: Env, request_id: u64, proof: BlsVrfProof, signature: BytesN<64>) {
        // ── CHECKS ────────────────────────────────────────────────────────────────

        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("request refunded");
        }

        // Re-entrancy guard: reject if a callback is currently in-flight for this request.
        let fulfilling: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilling(request_id))
            .unwrap_or(false);
        if fulfilling {
            panic!("fulfill already in progress");
        }

        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("oracle address missing"));
        oracle_addr.require_auth();

        if !env.storage().persistent().has(&DataKey::RequestContext(request_id)) {
            panic!("request not found");
        }

        let already: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if already {
            panic!("already fulfilled");
        }

        let stored_pk: BytesN<192> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap_or_else(|| panic!("oracle pk missing"));
        if proof.public_key != stored_pk {
            panic!("oracle key mismatch");
        }

        let required_round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request round missing"));
        if proof.drand_round != required_round {
            panic!("drand round mismatch");
        }

        // Oracle identity binding: signature covers request_id and proof payload.
        let oracle_ed25519: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OracleEd25519)
            .unwrap_or_else(|| panic!("oracle ed25519 missing"));
        let mut message = Bytes::new(&env);
        message.append(&u64_be_bytes(&env, request_id));
        message.append(&Bytes::from_slice(&env, &proof.alpha_seed.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.gamma_point.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        message.append(&u64_be_bytes(&env, proof.drand_round));
        message.append(&Bytes::from_slice(&env, &proof.drand_signature.to_array()));
        env.crypto().ed25519_verify(&oracle_ed25519, &message, &signature);

        // Verify drand BLS signature.
        if !verify_drand_signature(&env, &proof) {
            panic!("drand signature verification failed");
        }

        // Alpha must be deterministic from request context + round + drand randomness.
        let expected_alpha =
            derive_expected_alpha(&env, request_id, proof.drand_round, &proof.drand_signature);
        if expected_alpha != proof.alpha_seed {
            panic!("alpha seed mismatch");
        }

        // Verify BLS-VRF proof: e(gamma, G2) == e(H(alpha), PK).
        if !verify_bls_vrf_proof(&env, &proof) {
            panic!("bls vrf verification failed");
        }

        // Domain-separated output derivation.
        let expected_beta = derive_beta_output(&env, &proof.gamma_point);
        if expected_beta != proof.beta_output {
            panic!("beta output mismatch");
        }

        // ── EFFECTS ───────────────────────────────────────────────────────────────
        // Commit state BEFORE any cross-contract interaction (CEI pattern).

        env.storage()
            .persistent()
            .set(&DataKey::Proof(request_id), &proof.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Beta(request_id), &proof.beta_output);
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(request_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Proof(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Beta(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        // Release escrowed fee to oracle upon successful fulfillment.
        let fee_amount: i128 = env.storage().instance().get(&DataKey::FeeAmount).unwrap_or(0);
        if fee_amount > 0 {
            let fee_token: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeToken)
                .unwrap_or_else(|| panic!("fee token missing"));
            let contract_addr = env.current_contract_address();
            let transfer_fn = Symbol::new(&env, "transfer");
            let mut args = Vec::<Val>::new(&env);
            args.push_back(contract_addr.into_val(&env));
            args.push_back(oracle_addr.clone().into_val(&env));
            args.push_back(fee_amount.into_val(&env));
            env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
        }

        // ── INTERACTIONS ──────────────────────────────────────────────────────────
        // Re-entrancy guard: set Fulfilling flag before callback, clear after.
        // A re-entrant fulfill() call will be rejected by the "already fulfilled" check above.

        env.storage()
            .persistent()
            .set(&DataKey::Fulfilling(request_id), &true);

        invoke_callback_if_configured(&env, request_id, &proof);

        // Clear re-entrancy guard.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Fulfilling(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::Fulfilling(request_id));
        }

        env.events()
            .publish((symbol_short!("fulfill"),), (request_id, proof.beta_output));
    }

    pub fn get_proof(env: Env, request_id: u64) -> BlsVrfProof {
        let proof: BlsVrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"));

        env.storage().persistent().extend_ttl(
            &DataKey::Proof(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        proof
    }

    pub fn oracle_pk(env: Env) -> BytesN<192> {
        let pk: BytesN<192> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap_or_else(|| panic!("oracle pk missing"));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        pk
    }

    pub fn oracle_address(env: Env) -> Address {
        let addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("oracle address missing"));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        addr
    }

    pub fn request_round(env: Env, request_id: u64) -> u64 {
        let round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::RequestRound(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        round
    }

    pub fn get_context(env: Env, request_id: u64) -> Bytes {
        let context: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::RequestContext(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::RequestContext(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        context
    }

    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Fulfilled(request_id))
        {
            env.storage().persistent().extend_ttl(
                &DataKey::Fulfilled(request_id),
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }
        fulfilled
    }

    /// The verified 32-byte VRF output (`beta`) of a fulfilled request.
    ///
    /// Stored separately from the full proof and **retained** by
    /// `cleanup_proof()`, so this keeps working after cleanup (until the entry's
    /// storage TTL lapses; reads extend it).
    pub fn get_beta(env: Env, request_id: u64) -> BytesN<32> {
        read_beta(&env, request_id)
    }

    /// A uniformly random `u64` derived from the request's verified output.
    ///
    /// `sha256("VREP_DERIVE_V2" ‖ 0x01 ‖ request_id_be ‖ beta)[0..8]`.
    ///
    /// # No caller-chosen input
    /// The only inputs are fixed before the result is known: the request id and
    /// the verified beta. Earlier versions also took a `context: Bytes` argument
    /// here. Because the caller picked it **after** seeing beta, it let anyone
    /// grind over contexts until they liked the output. Bind application data
    /// to the request via the `context` given to `request()` instead: that
    /// value is committed before the drand round is public and already feeds
    /// alpha (and so beta).
    pub fn derive_random(env: Env, request_id: u64) -> u64 {
        let beta = read_beta(&env, request_id);
        let mut input = derive_prefix(&env, DERIVE_TAG_U64, request_id);
        input.append(&Bytes::from_slice(&env, &beta.to_array()));
        let hash_arr = env.crypto().sha256(&input).to_array();

        let mut buf = [0u8; 8];
        buf.copy_from_slice(&hash_arr[0..8]);
        u64::from_be_bytes(buf)
    }

    /// An **exactly uniform** value in `[0, max)` derived from the request's
    /// verified output.
    ///
    /// # Method: bounded rejection sampling over two 128-bit candidates
    /// `h = sha256("VREP_DERIVE_V2" ‖ 0x02 ‖ request_id_be ‖ max_be ‖ beta)`,
    /// `c1 = h[0..16]`, `c2 = h[16..32]` (big-endian `u128`),
    /// `limit = 2^128 − (2^128 mod max)` (the largest multiple of `max` ≤ 2^128).
    ///
    /// - if `c1 < limit` → `c1 mod max`
    /// - else if `c2 < limit` → `c2 mod max`
    /// - else → panic `"range derivation failed: both candidates rejected"`
    ///
    /// Conditioned on returning, `c mod max` is **exactly** uniform: `[0, limit)`
    /// splits into `limit / max` complete residue cycles, so there is no modulo
    /// bias at all (the previous 128-bit version had bias ≤ 2^-64, small but
    /// not zero). There is no biased fallback. When both candidates are
    /// rejected the call fails explicitly, with probability
    /// `((2^128 mod max) / 2^128)^2 < (max / 2^128)^2 ≤ 2^-128` for any
    /// `max < 2^64`. Cost is constant: one sha256, no loop.
    ///
    /// # No caller-chosen input
    /// Inputs are the request id, `max` and the verified beta only. See
    /// [`Self::derive_random`] for why the old `context` argument was removed.
    /// `max` is bound into the hash so different ranges draw independent
    /// candidates.
    pub fn derive_random_in_range(env: Env, request_id: u64, max: u64) -> u64 {
        if max == 0 {
            panic!("max must be > 0");
        }
        let beta = read_beta(&env, request_id);
        if max == 1 {
            return 0;
        }
        let mut input = derive_prefix(&env, DERIVE_TAG_RANGE, request_id);
        input.append(&u64_be_bytes(&env, max));
        input.append(&Bytes::from_slice(&env, &beta.to_array()));
        reduce_uniform(&env.crypto().sha256(&input).to_array(), max)
    }

    /// Like [`Self::derive_random_in_range`], plus a short **domain separator**
    /// so one request can feed several independent draws (for example
    /// `b"card-1"`, `b"card-2"`).
    ///
    /// # ⚠ The domain MUST be fixed before fulfillment
    /// The output is a deterministic function of `(request, domain, max)`. If a
    /// party can pick `domain` **after** the randomness is revealed, it can try
    /// `A`, `B`, `C`, … and keep whichever result suits it, which is grinding
    /// over derived outputs. Only use constants from your contract's code, or
    /// values your contract stored before calling `request()`. Never forward a
    /// user-supplied value here. The contract cannot enforce this: it has no
    /// way to know when your domain was chosen.
    ///
    /// The domain is length-prefixed in the hash input (no ambiguity between,
    /// for example, `("ab", max)` and `("a", ...)`), and is capped at
    /// [`MAX_DERIVE_DOMAIN_LEN`] bytes.
    pub fn derive_range_for_domain(env: Env, request_id: u64, domain: Bytes, max: u64) -> u64 {
        if max == 0 {
            panic!("max must be > 0");
        }
        if domain.len() > MAX_DERIVE_DOMAIN_LEN {
            panic!("domain exceeds maximum length");
        }
        let beta = read_beta(&env, request_id);
        if max == 1 {
            return 0;
        }
        let mut input = derive_prefix(&env, DERIVE_TAG_RANGE_DOMAIN, request_id);
        input.append(&Bytes::from_slice(&env, &domain.len().to_be_bytes()));
        input.append(&domain);
        input.append(&u64_be_bytes(&env, max));
        input.append(&Bytes::from_slice(&env, &beta.to_array()));
        reduce_uniform(&env.crypto().sha256(&input).to_array(), max)
    }

    /// Lets the requester (or oracle) remove bulky data for a fulfilled request
    /// to reclaim storage rent.
    ///
    /// Removed: `Proof` (~450 bytes), `RequestContext`, callback metadata.
    /// **Kept:** `Fulfilled` and the 32-byte `Beta`, so `is_fulfilled()`,
    /// `get_beta()`, `derive_random()`, `derive_random_in_range()` and
    /// `derive_range_for_domain()` keep working. Only `get_proof()` (the full
    /// proof, needed for independent re-verification) fails after cleanup.
    /// Re-verifiers should fetch the proof from the `fulfill` transaction or
    /// call `get_proof()` before cleanup. All entries remain subject to
    /// Soroban storage TTL.
    pub fn cleanup_proof(env: Env, request_id: u64, caller: Address) {
        caller.require_auth();

        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if !fulfilled {
            panic!("request not yet fulfilled");
        }

        // Only requester or oracle can clean up
        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("requester not found"));
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("oracle address missing"));

        if caller != requester && caller != oracle_addr {
            panic!("only requester or oracle can cleanup");
        }

        // Remove bulky proof data; preserve Fulfilled flag for auditability.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Proof(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::Proof(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::RequestContext(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::RequestContext(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackContract(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::CallbackContract(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackFn(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::CallbackFn(request_id));
        }

        // Extend Fulfilled flag TTL so is_fulfilled() remains queryable.
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        env.events()
            .publish((symbol_short!("cleanup"),), request_id);
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Round a new request is bound to: `current_round + offset`.
///
/// With drand's numbering (see [`compute_current_round`]) the current round
/// `c` is already published at `now_ts`, and round `c + offset` is published
/// at `genesis + (c + offset - 1) * period`. For `offset = 2` the beacon
/// therefore appears between `period` (exclusive) and `2 * period`
/// (inclusive) seconds after the request ledger's close time: 3–6 s on
/// quicknet.
fn compute_required_round(now_ts: u64, genesis: u64, period: u32, offset: u32) -> u64 {
    compute_current_round(now_ts, genesis, period).saturating_add(offset as u64)
}

/// The drand round that is current (the latest one due) at `now_ts`.
///
/// Matches drand's own definition (`common/time.go`, `CurrentRound`):
/// round **1** is emitted at `genesis`, round `r` at
/// `genesis + (r - 1) * period`, so
/// `current = floor((now - genesis) / period) + 1`. Before genesis no round
/// exists and this returns 0.
///
/// Earlier versions omitted the `+ 1` and so were one round behind drand.
/// The "future" round a request was bound to was then only
/// `offset - 1` rounds ahead of the published one: 0–3 s of lead time
/// instead of 3–6 s.
fn compute_current_round(now_ts: u64, genesis: u64, period: u32) -> u64 {
    if now_ts < genesis || period == 0 {
        return 0;
    }
    (now_ts - genesis) / (period as u64) + 1
}

fn u64_be_bytes(env: &Env, value: u64) -> Bytes {
    Bytes::from_slice(env, &value.to_be_bytes())
}

/// The canonical BLS12-381 G2 generator as a host point.
fn g2_generator(env: &Env) -> Bls12381G2Affine {
    Bls12381G2Affine::from_bytes(BytesN::from_array(env, &BLS12_381_G2_GENERATOR))
}

/// Uncompressed encoding of the point at infinity: only the infinity flag
/// (bit 1 of byte 0) set, every other bit zero.
fn is_g2_infinity_encoding(key: &BytesN<192>) -> bool {
    let bytes = key.to_array();
    bytes[0] == 0x40 && bytes[1..].iter().all(|b| *b == 0)
}

/// Fail-closed validation of a BLS12-381 G2 public key before it is stored.
///
/// Rejects, with a readable message, keys that would otherwise pass storage
/// and then make every `fulfill()` fail (or, worse, verify trivially):
/// - **point at infinity**: the identity element. Pairings with it are always
///   1, so a pairing check against it says nothing about the signer.
/// - **not on the curve / not in the prime-order subgroup**: checked with the
///   host's `g2_is_in_subgroup`, which deserializes the point and checks the
///   field encoding, the on-curve equation and subgroup membership. A malformed
///   encoding traps in the host, which also aborts the call.
/// - **the generator itself**: that is the public key of secret key `1`, so
///   anyone can sign for it. This almost always means the generator was pasted
///   where the key belonged.
fn validate_g2_public_key(env: &Env, key: &BytesN<192>, what: &str) {
    if is_g2_infinity_encoding(key) {
        panic!("{} is the point at infinity", what);
    }
    if key.to_array() == BLS12_381_G2_GENERATOR {
        panic!("{} must not be the G2 generator", what);
    }
    let point = Bls12381G2Affine::from_bytes(key.clone());
    if !env.crypto().bls12_381().g2_is_in_subgroup(&point) {
        panic!("{} is not in the G2 subgroup", what);
    }
}

/// Ed25519 keys are always 32 bytes (`BytesN<32>` enforces that). An all-zero
/// key is not a usable verifying key, and it is the typical result of an unset
/// or mis-copied value. Point validity is also re-checked by the host on every
/// `ed25519_verify`.
fn validate_ed25519_key(key: &BytesN<32>) {
    if key.to_array().iter().all(|b| *b == 0) {
        panic!("oracle ed25519 key must not be all zero");
    }
}

/// Read the verified beta of a fulfilled request (and keep it alive).
fn read_beta(env: &Env, request_id: u64) -> BytesN<32> {
    let fulfilled: bool = env
        .storage()
        .persistent()
        .get(&DataKey::Fulfilled(request_id))
        .unwrap_or(false);
    if !fulfilled {
        panic!("request not yet fulfilled");
    }
    let beta: BytesN<32> = env
        .storage()
        .persistent()
        .get(&DataKey::Beta(request_id))
        .unwrap_or_else(|| panic!("beta missing"));
    env.storage().persistent().extend_ttl(
        &DataKey::Beta(request_id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Fulfilled(request_id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    beta
}

/// `DERIVE_DOMAIN ‖ tag ‖ request_id_be`: common prefix of every derivation.
fn derive_prefix(env: &Env, tag: u8, request_id: u64) -> Bytes {
    let mut input = Bytes::from_slice(env, DERIVE_DOMAIN);
    input.push_back(tag);
    input.append(&u64_be_bytes(env, request_id));
    input
}

/// Exact-uniform reduction of a 32-byte hash into `[0, max)` by rejection
/// sampling over its two 128-bit halves. See `derive_random_in_range()`.
///
/// Requires `max >= 2`.
pub(crate) fn reduce_uniform(hash: &[u8; 32], max: u64) -> u64 {
    let max128 = max as u128;
    // 2^128 mod max == (2^128 - max) mod max == (u128::MAX - max + 1) % max.
    // Values at or above `limit` belong to an incomplete final cycle.
    let rem = (u128::MAX - max128 + 1) % max128;
    let mut c = [0u8; 16];
    for half in 0..2 {
        c.copy_from_slice(&hash[half * 16..half * 16 + 16]);
        let candidate = u128::from_be_bytes(c);
        // candidate < limit  <=>  candidate <= u128::MAX - rem
        // (limit = 2^128 - rem cannot be represented when rem == 0.)
        if rem == 0 || candidate <= u128::MAX - rem {
            return (candidate % max128) as u64;
        }
    }
    panic!("range derivation failed: both candidates rejected");
}

fn derive_expected_alpha(
    env: &Env,
    request_id: u64,
    drand_round: u64,
    drand_signature: &BytesN<96>,
) -> BytesN<32> {
    let context: Bytes = env
        .storage()
        .persistent()
        .get(&DataKey::RequestContext(request_id))
        .unwrap_or_else(|| panic!("context missing"));
    let mut input = Bytes::new(env);
    input.append(&u64_be_bytes(env, request_id));
    input.append(&context);
    input.append(&u64_be_bytes(env, drand_round));

    let drand_sig_bytes = Bytes::from_slice(env, &drand_signature.to_array());
    let drand_randomness = env.crypto().sha256(&drand_sig_bytes);
    input.append(&Bytes::from_slice(env, &drand_randomness.to_array()));

    env.crypto().sha256(&input).into()
}

fn derive_beta_output(env: &Env, gamma_point: &BytesN<96>) -> BytesN<32> {
    let mut beta_input = Bytes::new(env);
    beta_input.append(&Bytes::from_slice(env, BETA_DOMAIN));
    beta_input.append(&Bytes::from_slice(env, &gamma_point.to_array()));
    env.crypto().sha256(&beta_input).into()
}

fn verify_bls_vrf_proof(env: &Env, proof: &BlsVrfProof) -> bool {
    let bls = env.crypto().bls12_381();

    let alpha_bytes = Bytes::from_slice(env, &proof.alpha_seed.to_array());
    let dst = Bytes::from_slice(env, VRF_DST);
    let h = bls.hash_to_g1(&alpha_bytes, &dst);
    let gamma = Bls12381G1Affine::from_bytes(proof.gamma_point.clone());

    let pk = Bls12381G2Affine::from_bytes(proof.public_key.clone());

    let mut g1_vec = Vec::<Bls12381G1Affine>::new(env);
    g1_vec.push_back(gamma);
    g1_vec.push_back(-h);

    let mut g2_vec = Vec::<Bls12381G2Affine>::new(env);
    g2_vec.push_back(g2_generator(env));
    g2_vec.push_back(pk);

    bls.pairing_check(g1_vec, g2_vec)
}

fn verify_drand_signature(env: &Env, proof: &BlsVrfProof) -> bool {
    let bls = env.crypto().bls12_381();

    let drand_sig = Bls12381G1Affine::from_bytes(proof.drand_signature.clone());
    let drand_pk_bytes: BytesN<192> = env
        .storage()
        .instance()
        .get(&DataKey::DrandPK)
        .unwrap_or_else(|| panic!("drand pk missing"));
    let drand_pk = Bls12381G2Affine::from_bytes(drand_pk_bytes);

    let round_be = u64_be_bytes(env, proof.drand_round);
    let round_hash = env.crypto().sha256(&round_be);
    let round_hash_bytes = Bytes::from_slice(env, &round_hash.to_array());
    let drand_dst = Bytes::from_slice(env, DRAND_DST);
    let h_msg = bls.hash_to_g1(&round_hash_bytes, &drand_dst);

    let mut g1_vec = Vec::<Bls12381G1Affine>::new(env);
    g1_vec.push_back(drand_sig);
    g1_vec.push_back(-h_msg);

    let mut g2_vec = Vec::<Bls12381G2Affine>::new(env);
    g2_vec.push_back(g2_generator(env));
    g2_vec.push_back(drand_pk);

    bls.pairing_check(g1_vec, g2_vec)
}

fn request_internal(
    env: &Env,
    context: Bytes,
    requester: Address,
    callback_contract: Option<Address>,
    callback_fn: Option<Symbol>,
) -> u64 {
    requester.require_auth();

    if context.len() > MAX_CONTEXT_LEN {
        panic!("context exceeds maximum length");
    }

    // Charge per-request fee via SAC token transfer (requester → contract escrow).
    // Fee is held in escrow until fulfill() (released to oracle) or timeout_refund() (returned to requester).
    let fee_amount: i128 = env.storage().instance().get(&DataKey::FeeAmount).unwrap_or(0);
    if fee_amount > 0 {
        let fee_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::FeeToken)
            .unwrap_or_else(|| panic!("fee token missing"));
        let contract_addr = env.current_contract_address();
        // SAC token transfer: requester → VRF contract (escrow).
        let transfer_fn = Symbol::new(env, "transfer");
        let mut args = Vec::<Val>::new(env);
        args.push_back(requester.clone().into_val(env));
        args.push_back(contract_addr.into_val(env));
        args.push_back(fee_amount.into_val(env));
        env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
    }

    let counter: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Counter)
        .unwrap_or(0);
    let id = counter
        .checked_add(1)
        .unwrap_or_else(|| panic!("counter overflow"));
    env.storage().instance().set(&DataKey::Counter, &id);

    let genesis: u64 = env
        .storage()
        .instance()
        .get(&DataKey::DrandGenesis)
        .unwrap_or_else(|| panic!("genesis missing"));
    let period: u32 = env
        .storage()
        .instance()
        .get(&DataKey::DrandPeriod)
        .unwrap_or_else(|| panic!("period missing"));
    let offset: u32 = env
        .storage()
        .instance()
        .get(&DataKey::RoundOffset)
        .unwrap_or_else(|| panic!("round offset missing"));
    let required_round =
        compute_required_round(env.ledger().timestamp(), genesis, period, offset);

    env.storage()
        .persistent()
        .set(&DataKey::RequestContext(id), &context);
    env.storage()
        .persistent()
        .set(&DataKey::Requester(id), &requester);
    env.storage()
        .persistent()
        .set(&DataKey::RequestRound(id), &required_round);
    env.storage()
        .persistent()
        .set(&DataKey::Fulfilled(id), &false);
    env.storage()
        .persistent()
        .set(&DataKey::Refunded(id), &false);

    if let Some(cb_contract) = callback_contract {
        let cb_fn = callback_fn.unwrap_or_else(|| panic!("callback function missing"));
        env.storage()
            .persistent()
            .set(&DataKey::CallbackContract(id), &cb_contract);
        env.storage()
            .persistent()
            .set(&DataKey::CallbackFn(id), &cb_fn);
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackContract(id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackFn(id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
    }

    env.storage().persistent().extend_ttl(
        &DataKey::RequestContext(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Requester(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::RequestRound(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Fulfilled(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Refunded(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

    env.events()
        .publish((symbol_short!("request"),), (id, requester, required_round));
    id
}

/// Invoke the consumer callback if one was registered with `request_with_callback`.
///
/// # Authorization model
/// The VRF contract itself is the caller of the consumer callback — NOT the original
/// requester. Consumer contracts must NOT require the original requester's auth inside
/// their callback function; they should trust the VRF contract address instead.
///
/// # Arguments passed to callback
/// - `request_id: u64` — the VRF request identifier
/// - `beta_output: BytesN<32>` — the verifiable random output
/// - `alpha_seed: BytesN<32>` — the deterministic input seed (for auditability)
///
/// # Failure isolation
/// The callback is invoked with `try_invoke_contract`. If the consumer's
/// `on_vrf()` panics, traps, returns an error, or is missing, the host rolls back
/// only the *callback's* own state changes and this function emits a
/// `cb_failed` event of `(request_id, callback_contract)`. `fulfill()` then carries
/// on: `Fulfilled`, the stored proof and the oracle fee transfer stay committed.
/// Without this, a consumer could force every `fulfill()` to revert, making
/// the oracle pay network fees indefinitely (callback-griefing DoS).
///
/// Consumers therefore MUST NOT rely on the callback always succeeding;
/// the canonical output is always readable via `get_beta(request_id)`.
///
/// # What is NOT isolated: resource exhaustion
/// Only ordinary errors and panics are isolated. Soroban meters the **whole
/// invocation tree under one transaction-wide budget** (currently 400M CPU
/// instructions and 40 MiB of memory per transaction on Mainnet). There is no
/// separate sub-budget for the callback. A callback that exhausts CPU or
/// memory therefore aborts the **entire** `fulfill()` transaction, and nothing
/// above is committed. Mitigations are off-chain: the worker simulates first,
/// refuses to submit transactions above its configured instruction/memory
/// ceilings (`resourceGuard.ts`), treats resource-limit failures as terminal
/// instead of retrying them, and caps sends per request.
pub(crate) fn invoke_callback_if_configured(env: &Env, request_id: u64, proof: &BlsVrfProof) {
    if !env
        .storage()
        .persistent()
        .has(&DataKey::CallbackContract(request_id))
    {
        return;
    }

    let callback_contract: Address = env
        .storage()
        .persistent()
        .get(&DataKey::CallbackContract(request_id))
        .unwrap_or_else(|| panic!("callback contract missing"));
    let callback_fn: Symbol = env
        .storage()
        .persistent()
        .get(&DataKey::CallbackFn(request_id))
        .unwrap_or_else(|| panic!("callback fn missing"));

    let mut args = Vec::<Val>::new(env);
    args.push_back(request_id.into_val(env));
    args.push_back(proof.beta_output.clone().into_val(env));
    args.push_back(proof.alpha_seed.clone().into_val(env));

    let result = env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &callback_contract,
        &callback_fn,
        args,
    );
    if result.is_err() {
        env.events().publish(
            (symbol_short!("cb_failed"),),
            (request_id, callback_contract),
        );
    }
}
