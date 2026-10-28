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
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal,
    Symbol, Val, Vec,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND: u32 = 518_400;
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND: u32 = 518_400;

const DRAND_DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const VRF_DST: &[u8] = b"SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_";
const POP_BLS_DST: &[u8] = b"SOROBAN_VRF_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_";
const BETA_DOMAIN: &[u8] = b"VREP_BETA_V1";
/// Domain tag for every value derived from a stored beta. `V2` because the
/// derivation input changed in this version: it is now bound to the request id
/// and (for range derivations) no longer takes a caller-chosen context.
const DERIVE_DOMAIN: &[u8] = b"VREP_DERIVE_V2";
const DERIVE_TAG_U64: u8 = 0x01;
const DERIVE_TAG_RANGE: u8 = 0x02;
const DERIVE_TAG_RANGE_DOMAIN: u8 = 0x03;
const MIN_ROUND_OFFSET: u32 = 2;
const TIMEOUT_ROUNDS: u64 = 20;
const MAX_CONTEXT_LEN: u32 = 1024;
pub const MAX_DERIVE_DOMAIN_LEN: u32 = 64;

/// Maximum number of epoch records in persistent storage at any time.
/// Prevents unbounded storage growth. Enforced at proposal time.
const MAX_RETAINED_EPOCHS: u32 = 4;

/// Minimum timelocks (compile-time floors). Constructor rejects lower values.
const MIN_ROTATION_TIMELOCK_LEDGERS: u32 = 2_880; // ~4 hours
const MIN_UPGRADE_TIMELOCK_LEDGERS: u32 = 8_640; // ~12 hours

const CONTRACT_VERSION_INIT: u32 = 2;
const STORAGE_VERSION_INIT: u32 = 1;

/// Canonical generator of the BLS12-381 G2 group, uncompressed (192 bytes).
pub const BLS12_381_G2_GENERATOR: [u8; 192] = [
    0x13, 0xe0, 0x2b, 0x60, 0x52, 0x71, 0x9f, 0x60, 0x7d, 0xac, 0xd3, 0xa0, 0x88, 0x27, 0x4f,
    0x65, 0x59, 0x6b, 0xd0, 0xd0, 0x99, 0x20, 0xb6, 0x1a, 0xb5, 0xda, 0x61, 0xbb, 0xdc, 0x7f,
    0x50, 0x49, 0x33, 0x4c, 0xf1, 0x12, 0x13, 0x94, 0x5d, 0x57, 0xe5, 0xac, 0x7d, 0x05, 0x5d,
    0x04, 0x2b, 0x7e, 0x02, 0x4a, 0xa2, 0xb2, 0xf0, 0x8f, 0x0a, 0x91, 0x26, 0x08, 0x05, 0x27,
    0x2d, 0xc5, 0x10, 0x51, 0xc6, 0xe4, 0x7a, 0xd4, 0xfa, 0x40, 0x3b, 0x02, 0xb4, 0x51, 0x0b,
    0x64, 0x7a, 0xe3, 0xd1, 0x77, 0x0b, 0xac, 0x03, 0x26, 0xa8, 0x05, 0xbb, 0xef, 0xd4, 0x80,
    0x56, 0xc8, 0xc1, 0x21, 0xbd, 0xb8, 0x06, 0x06, 0xc4, 0xa0, 0x2e, 0xa7, 0x34, 0xcc, 0x32,
    0xac, 0xd2, 0xb0, 0x2b, 0xc2, 0x8b, 0x99, 0xcb, 0x3e, 0x28, 0x7e, 0x85, 0xa7, 0x63, 0xaf,
    0x26, 0x74, 0x92, 0xab, 0x57, 0x2e, 0x99, 0xab, 0x3f, 0x37, 0x0d, 0x27, 0x5c, 0xec, 0x1d,
    0xa1, 0xaa, 0xa9, 0x07, 0x5f, 0xf0, 0x5f, 0x79, 0xbe, 0x0c, 0xe5, 0xd5, 0x27, 0x72, 0x7d,
    0x6e, 0x11, 0x8c, 0xc9, 0xcd, 0xc6, 0xda, 0x2e, 0x35, 0x1a, 0xad, 0xfd, 0x9b, 0xaa, 0x8c,
    0xbd, 0xd3, 0xa7, 0x6d, 0x42, 0x9a, 0x69, 0x51, 0x60, 0xd1, 0x2c, 0x92, 0x3a, 0xc9, 0xcc,
    0x3b, 0xac, 0xa2, 0x89, 0xe1, 0x93, 0x54, 0x86, 0x08, 0xb8, 0x28, 0x01,
];

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum EpochStatus {
    Active,
    Superseded,
    Revoked,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EpochData {
    pub oracle_bls_pk: BytesN<192>,
    pub oracle_ed25519_pk: BytesN<32>,
    pub oracle_address: Address,
    pub drand_pk: BytesN<192>,
    pub status: EpochStatus,
    pub pending_count: u32,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingRotation {
    pub new_epoch: EpochData,
    pub new_epoch_id: u32,
    pub source_epoch_id: u32,
    pub proposed_ledger: u32,
    pub execute_after_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub proposed_ledger: u32,
    pub execute_after_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingAdminTransfer {
    pub new_admin: Address,
    pub proposed_ledger: u32,
    pub execute_after_ledger: u32,
}

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
    // ── Instance Storage ─────────────────────────────────────
    Admin,
    DrandGenesis,
    DrandPeriod,
    RoundOffset,
    Counter,
    FeeToken,
    FeeAmount,
    EpochCounter,
    ActiveEpochId,
    RetainedEpochCount,
    ContractVersion,
    StorageVersion,
    RotTimelockLedgers,
    UpgTimelockLedgers,
    PendingRot,
    PendingUpg,
    PendingAdminXfer,

    // ── Persistent Storage (per-epoch) ───────────────────────
    Epoch(u32),

    // ── Persistent Storage (per-request) ─────────────────────
    RequestEpoch(u64),
    RequestContext(u64),
    Requester(u64),
    RequestRound(u64),
    Fulfilled(u64),
    Refunded(u64),
    Fulfilling(u64),
    Proof(u64),
    Beta(u64),
    CallbackContract(u64),
    CallbackFn(u64),
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT
// ═══════════════════════════════════════════════════════════════════════════════

#[contract]
pub struct VRFOracleContract;

#[contractimpl]
impl VRFOracleContract {
    // ─────────────────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────────────

    /// Atomic constructor (Soroban Protocol 22+). Runs exactly once.
    ///
    /// # Enforced invariants
    /// - `admin != oracle_address` (role separation)
    /// - `rotation_timelock_ledgers >= MIN_ROTATION_TIMELOCK_LEDGERS`
    /// - `upgrade_timelock_ledgers >= MIN_UPGRADE_TIMELOCK_LEDGERS`
    /// - All key validations (G2 subgroup, not infinity, not generator, etc.)
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        oracle_pk: BytesN<192>,
        oracle_address: Address,
        oracle_ed25519_pk: BytesN<32>,
        drand_pk: BytesN<192>,
        drand_genesis_time: u64,
        drand_period: u32,
        round_offset: u32,
        fee_token: Address,
        fee_amount: i128,
        rotation_timelock_ledgers: u32,
        upgrade_timelock_ledgers: u32,
    ) {
        // ── Role separation ──
        if admin == oracle_address {
            panic!("admin must differ from oracle operator");
        }

        // ── Timelock floors ──
        if rotation_timelock_ledgers < MIN_ROTATION_TIMELOCK_LEDGERS {
            panic!("rotation timelock below minimum");
        }
        if upgrade_timelock_ledgers < MIN_UPGRADE_TIMELOCK_LEDGERS {
            panic!("upgrade timelock below minimum");
        }

        // ── Parameter validation (same as V1) ──
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

        // ── Authorization ──
        admin.require_auth();
        oracle_address.require_auth();

        // ── Create Epoch 1 ──
        let epoch = EpochData {
            oracle_bls_pk: oracle_pk.clone(),
            oracle_ed25519_pk: oracle_ed25519_pk.clone(),
            oracle_address: oracle_address.clone(),
            drand_pk: drand_pk.clone(),
            status: EpochStatus::Active,
            pending_count: 0,
            created_ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&DataKey::Epoch(1), &epoch);
        env.storage().persistent().extend_ttl(
            &DataKey::Epoch(1),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // ── Instance storage ──
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::DrandGenesis, &drand_genesis_time);
        env.storage()
            .instance()
            .set(&DataKey::DrandPeriod, &drand_period);
        env.storage()
            .instance()
            .set(&DataKey::RoundOffset, &round_offset);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage().instance().set(&DataKey::FeeToken, &fee_token);
        env.storage()
            .instance()
            .set(&DataKey::FeeAmount, &fee_amount);
        env.storage().instance().set(&DataKey::EpochCounter, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::ActiveEpochId, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::RetainedEpochCount, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &CONTRACT_VERSION_INIT);
        env.storage()
            .instance()
            .set(&DataKey::StorageVersion, &STORAGE_VERSION_INIT);
        env.storage()
            .instance()
            .set(&DataKey::RotTimelockLedgers, &rotation_timelock_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::UpgTimelockLedgers, &upgrade_timelock_ledgers);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events()
            .publish((symbol_short!("init"),), (oracle_pk, admin));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REQUEST
    // ─────────────────────────────────────────────────────────────────────────

    pub fn request(env: Env, context: Bytes, requester: Address) -> u64 {
        request_internal(&env, context, requester, None, None)
    }

    pub fn request_with_callback(
        env: Env,
        context: Bytes,
        requester: Address,
        callback_contract: Address,
        callback_fn: Symbol,
    ) -> u64 {
        if callback_fn != Symbol::new(&env, "on_vrf") {
            panic!("callback_fn must be 'on_vrf'");
        }
        if callback_contract != requester {
            panic!("callback_contract must be the requester");
        }
        // requester.require_auth() is enforced in request_internal
        request_internal(
            &env,
            context,
            requester,
            Some(callback_contract),
            Some(callback_fn),
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FULFILL
    // ─────────────────────────────────────────────────────────────────────────

    /// Fulfill a VRF request. Verifies against the epoch keys bound at request
    /// time, NOT the currently active epoch.
    ///
    /// # Checks-Effects-Interactions (CEI) pattern preserved from V1.
    /// # Re-entrancy protection preserved from V1.
    pub fn fulfill(env: Env, request_id: u64, proof: BlsVrfProof, signature: BytesN<64>) {
        // ── CHECKS ──────────────────────────────────────────────────────────

        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("request refunded");
        }

        let fulfilling: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilling(request_id))
            .unwrap_or(false);
        if fulfilling {
            panic!("fulfill already in progress");
        }

        // ── Load request's epoch (NOT the active epoch) ──
        let epoch_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestEpoch(request_id))
            .unwrap_or_else(|| panic!("request epoch missing"));
        let epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| panic!("epoch data missing"));

        // ── Revoked epochs permanently reject fulfillment (S16) ──
        if epoch.status == EpochStatus::Revoked {
            panic!("epoch revoked");
        }

        // ── Auth: operator of the request's epoch ──
        epoch.oracle_address.require_auth();

        if !env
            .storage()
            .persistent()
            .has(&DataKey::RequestContext(request_id))
        {
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

        // ── Verify oracle BLS key against EPOCH keys (S1) ──
        if proof.public_key != epoch.oracle_bls_pk {
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

        // ── Ed25519 signature against EPOCH key ──
        let mut message = Bytes::new(&env);
        message.append(&u64_be_bytes(&env, request_id));
        message.append(&Bytes::from_slice(&env, &proof.alpha_seed.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.gamma_point.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        message.append(&u64_be_bytes(&env, proof.drand_round));
        message.append(&Bytes::from_slice(&env, &proof.drand_signature.to_array()));
        env.crypto()
            .ed25519_verify(&epoch.oracle_ed25519_pk, &message, &signature);

        // ── drand signature against EPOCH drand key ──
        if !verify_drand_signature_with_pk(&env, &proof, &epoch.drand_pk) {
            panic!("drand signature verification failed");
        }

        // ── Alpha derivation with epoch_id domain separation ──
        let expected_alpha =
            derive_expected_alpha(&env, request_id, proof.drand_round, &proof.drand_signature, epoch_id);
        if expected_alpha != proof.alpha_seed {
            panic!("alpha seed mismatch");
        }

        // ── BLS-VRF pairing check (unchanged from V1) ──
        if !verify_bls_vrf_proof(&env, &proof) {
            panic!("bls vrf verification failed");
        }

        let expected_beta = derive_beta_output(&env, &proof.gamma_point);
        if expected_beta != proof.beta_output {
            panic!("beta output mismatch");
        }

        // ── EFFECTS ─────────────────────────────────────────────────────────

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

        // ── Decrement epoch pending_count (S7) ──
        let mut epoch_mut = epoch;
        epoch_mut.pending_count = epoch_mut.pending_count.saturating_sub(1);
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(epoch_id), &epoch_mut);

        // ── Release escrowed fee to epoch's oracle ──
        let fee_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeAmount)
            .unwrap_or(0);
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
            args.push_back(epoch_mut.oracle_address.clone().into_val(&env));
            args.push_back(fee_amount.into_val(&env));
            env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
        }

        // ── INTERACTIONS ────────────────────────────────────────────────────

        env.storage()
            .persistent()
            .set(&DataKey::Fulfilling(request_id), &true);

        invoke_callback_if_configured(&env, request_id, &proof);

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
            .publish((symbol_short!("fulfill"),), (request_id, proof.beta_output, epoch_id));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REFUNDS
    // ─────────────────────────────────────────────────────────────────────────

    pub fn timeout_refund(env: Env, request_id: u64) {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Requester(request_id))
        {
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

        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("already refunded");
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

        env.storage()
            .persistent()
            .set(&DataKey::Refunded(request_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Refunded(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // ── Decrement epoch pending_count ──
        let epoch_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestEpoch(request_id))
            .unwrap_or_else(|| panic!("request epoch missing"));
        let mut epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| panic!("epoch data missing"));
        epoch.pending_count = epoch.pending_count.saturating_sub(1);
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(epoch_id), &epoch);

        // ── Clean up transient storage (NOT RequestEpoch) ──
        remove_if_exists(&env, &DataKey::RequestContext(request_id));
        remove_if_exists(&env, &DataKey::CallbackContract(request_id));
        remove_if_exists(&env, &DataKey::CallbackFn(request_id));

        // ── Refund escrowed fee ──
        let fee_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeAmount)
            .unwrap_or(0);
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

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events()
            .publish((symbol_short!("timeout"),), (request_id, requester));
    }

    /// Immediate refund for requests bound to a revoked epoch.
    /// Anyone can call — the refund goes to the original requester.
    pub fn emergency_refund(env: Env, request_id: u64) {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Requester(request_id))
        {
            panic!("request not found");
        }

        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if fulfilled {
            panic!("already fulfilled");
        }

        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("already refunded");
        }

        let epoch_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestEpoch(request_id))
            .unwrap_or_else(|| panic!("request epoch missing"));
        let mut epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| panic!("epoch data missing"));

        if epoch.status != EpochStatus::Revoked {
            panic!("emergency refund only for revoked epochs");
        }

        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("requester not found"));

        env.storage()
            .persistent()
            .set(&DataKey::Refunded(request_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Refunded(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        epoch.pending_count = epoch.pending_count.saturating_sub(1);
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(epoch_id), &epoch);

        // Clean up transient storage (NOT RequestEpoch)
        remove_if_exists(&env, &DataKey::RequestContext(request_id));
        remove_if_exists(&env, &DataKey::CallbackContract(request_id));
        remove_if_exists(&env, &DataKey::CallbackFn(request_id));

        // Refund fee
        let fee_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeAmount)
            .unwrap_or(0);
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

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (Symbol::new(&env, "emrg_refund"),),
            (request_id, epoch_id, requester),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: KEY ROTATION
    // ─────────────────────────────────────────────────────────────────────────

    /// Propose a key rotation. Requires admin auth, PoP for new keys,
    /// admin ≠ new operator, and room under MAX_RETAINED_EPOCHS.
    #[allow(clippy::too_many_arguments)]
    pub fn propose_key_rotation(
        env: Env,
        admin: Address,
        new_oracle_pk: BytesN<192>,
        new_oracle_address: Address,
        new_oracle_ed25519_pk: BytesN<32>,
        new_drand_pk: BytesN<192>,
        bls_pop_signature: BytesN<96>,
        ed25519_pop_signature: BytesN<64>,
    ) {
        require_admin(&env, &admin);

        // No concurrent proposal (S5)
        if env
            .storage()
            .instance()
            .has(&DataKey::PendingRot)
        {
            let existing: Option<PendingRotation> =
                env.storage().instance().get(&DataKey::PendingRot);
            if existing.is_some() {
                panic!("pending rotation already exists");
            }
        }

        // MAX_RETAINED_EPOCHS (S6)
        let retained: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RetainedEpochCount)
            .unwrap_or(1);
        if retained >= MAX_RETAINED_EPOCHS {
            panic!("max retained epochs reached");
        }

        // Admin ≠ Operator (S17)
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("admin missing"));
        if new_oracle_address == stored_admin {
            panic!("new operator must differ from admin");
        }

        // Validate keys
        validate_g2_public_key(&env, &new_oracle_pk, "new oracle pk");
        validate_g2_public_key(&env, &new_drand_pk, "new drand pk");
        if new_oracle_pk == new_drand_pk {
            panic!("oracle pk must differ from drand pk");
        }
        validate_ed25519_key(&new_oracle_ed25519_pk);
        new_oracle_address.require_auth();

        // Assign epoch ID
        let epoch_counter: u32 = env
            .storage()
            .instance()
            .get(&DataKey::EpochCounter)
            .unwrap_or(1);
        let new_epoch_id = epoch_counter
            .checked_add(1)
            .unwrap_or_else(|| panic!("epoch counter overflow"));
        env.storage()
            .instance()
            .set(&DataKey::EpochCounter, &new_epoch_id);

        // ── Proof of Possession: BLS ──
        // Challenge = SHA256(epoch_id ‖ "BLS_POP_V2"). The epoch_id is
        // monotonically unique within this contract instance, and the PoP
        // verifies against a specific public key, so cross-contract replay
        // is not a concern (the admin controls which keys are accepted).
        let mut pop_input = Bytes::new(&env);
        pop_input.append(&u32_be_bytes(&env, new_epoch_id));
        pop_input.append(&Bytes::from_slice(&env, b"BLS_POP_V2"));
        let pop_challenge_hash = env.crypto().sha256(&pop_input);
        let pop_challenge_bytes =
            Bytes::from_slice(&env, &pop_challenge_hash.to_array());

        let bls = env.crypto().bls12_381();
        let pop_dst = Bytes::from_slice(&env, POP_BLS_DST);
        let h_pop = bls.hash_to_g1(&pop_challenge_bytes, &pop_dst);
        let pop_sig = Bls12381G1Affine::from_bytes(bls_pop_signature);
        let pk_point = Bls12381G2Affine::from_bytes(new_oracle_pk.clone());

        let mut g1_vec = Vec::<Bls12381G1Affine>::new(&env);
        g1_vec.push_back(pop_sig);
        g1_vec.push_back(-h_pop);
        let mut g2_vec = Vec::<Bls12381G2Affine>::new(&env);
        g2_vec.push_back(g2_generator(&env));
        g2_vec.push_back(pk_point);
        if !bls.pairing_check(g1_vec, g2_vec) {
            panic!("BLS proof of possession failed");
        }

        // ── Proof of Possession: Ed25519 ──
        let mut ed_pop_msg = Bytes::new(&env);
        ed_pop_msg.append(&u32_be_bytes(&env, new_epoch_id));
        ed_pop_msg.append(&Bytes::from_slice(&env, b"ED25519_POP_V2"));
        env.crypto()
            .ed25519_verify(&new_oracle_ed25519_pk, &ed_pop_msg, &ed25519_pop_signature);

        // Create pending rotation
        let current_ledger = env.ledger().sequence();
        let timelock: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RotTimelockLedgers)
            .unwrap_or(MIN_ROTATION_TIMELOCK_LEDGERS);
        let execute_after = current_ledger
            .checked_add(timelock)
            .unwrap_or_else(|| panic!("timelock overflow"));

        let active_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveEpochId)
            .unwrap_or(1);

        let pending = PendingRotation {
            new_epoch: EpochData {
                oracle_bls_pk: new_oracle_pk.clone(),
                oracle_ed25519_pk: new_oracle_ed25519_pk,
                oracle_address: new_oracle_address,
                drand_pk: new_drand_pk,
                status: EpochStatus::Active,
                pending_count: 0,
                created_ledger: current_ledger,
            },
            new_epoch_id,
            source_epoch_id: active_id,
            proposed_ledger: current_ledger,
            execute_after_ledger: execute_after,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingRot, &Some(pending.clone()));

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (Symbol::new(&env, "propose_rot"),),
            (new_epoch_id, new_oracle_pk, execute_after, active_id),
        );
    }

    /// Execute a pending key rotation after the timelock has elapsed.
    /// Revoked epochs are NEVER overwritten to Superseded (S16).
    pub fn execute_key_rotation(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: Option<PendingRotation> = env
            .storage()
            .instance()
            .get(&DataKey::PendingRot)
            .unwrap_or(None);
        let pending = pending.unwrap_or_else(|| panic!("no pending rotation"));

        let current_ledger = env.ledger().sequence();
        if current_ledger < pending.execute_after_ledger {
            panic!("rotation timelock not elapsed");
        }

        // ── Supersede old epoch, BUT NEVER OVERRIDE REVOKED (S16) ──
        let old_epoch_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveEpochId)
            .unwrap_or(1);
        let mut old_epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(old_epoch_id))
            .unwrap_or_else(|| panic!("old epoch missing"));

        if old_epoch.status != EpochStatus::Revoked {
            old_epoch.status = EpochStatus::Superseded;
        }
        // If already Revoked: stays Revoked permanently.
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(old_epoch_id), &old_epoch);

        // ── Activate new epoch ──
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(pending.new_epoch_id), &pending.new_epoch);
        env.storage().persistent().extend_ttl(
            &DataKey::Epoch(pending.new_epoch_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage()
            .instance()
            .set(&DataKey::ActiveEpochId, &pending.new_epoch_id);

        // ── Update retained count ──
        let retained: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RetainedEpochCount)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&DataKey::RetainedEpochCount, &(retained + 1));

        // Clear proposal
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot, &None);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (Symbol::new(&env, "exec_rot"),),
            (old_epoch_id, pending.new_epoch_id),
        );
    }

    pub fn cancel_key_rotation(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: Option<PendingRotation> = env
            .storage()
            .instance()
            .get(&DataKey::PendingRot)
            .unwrap_or(None);
        let pending = pending.unwrap_or_else(|| panic!("no pending rotation"));

        env.storage()
            .instance()
            .set::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot, &None);

        env.events().publish(
            (Symbol::new(&env, "cancel_rot"),),
            pending.new_epoch_id,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: EMERGENCY
    // ─────────────────────────────────────────────────────────────────────────

    /// Revoke an epoch permanently. If the revoked epoch is the source of a
    /// pending rotation, auto-cancel that rotation (S20).
    pub fn revoke_epoch(env: Env, admin: Address, epoch_id: u32) {
        require_admin(&env, &admin);

        let mut epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| panic!("epoch not found"));

        if epoch.status == EpochStatus::Revoked {
            panic!("epoch already revoked");
        }

        epoch.status = EpochStatus::Revoked;
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(epoch_id), &epoch);

        // ── Auto-cancel pending rotation if source is revoked (S20) ──
        let pending: Option<PendingRotation> = env
            .storage()
            .instance()
            .get(&DataKey::PendingRot)
            .unwrap_or(None);
        if let Some(p) = pending {
            if p.source_epoch_id == epoch_id {
                env.storage()
                    .instance()
                    .set::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot, &None);
                env.events().publish(
                    (Symbol::new(&env, "cancel_rot"),),
                    (p.new_epoch_id, Symbol::new(&env, "src_revoked")),
                );
            }
        }

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (Symbol::new(&env, "epoch_revkd"),),
            (epoch_id, epoch.pending_count),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: UPGRADE
    // ─────────────────────────────────────────────────────────────────────────

    pub fn propose_upgrade(env: Env, admin: Address, wasm_hash: BytesN<32>) {
        require_admin(&env, &admin);

        let existing: Option<PendingUpgrade> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpg)
            .unwrap_or(None);
        if existing.is_some() {
            panic!("pending upgrade already exists");
        }

        let current_ledger = env.ledger().sequence();
        let timelock: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgTimelockLedgers)
            .unwrap_or(MIN_UPGRADE_TIMELOCK_LEDGERS);
        let execute_after = current_ledger
            .checked_add(timelock)
            .unwrap_or_else(|| panic!("timelock overflow"));

        let pending = PendingUpgrade {
            wasm_hash: wasm_hash.clone(),
            proposed_ledger: current_ledger,
            execute_after_ledger: execute_after,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingUpg, &Some(pending));

        env.events().publish(
            (Symbol::new(&env, "propose_upg"),),
            (wasm_hash, execute_after),
        );
    }

    pub fn execute_upgrade(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: Option<PendingUpgrade> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpg)
            .unwrap_or(None);
        let pending = pending.unwrap_or_else(|| panic!("no pending upgrade"));

        if env.ledger().sequence() < pending.execute_after_ledger {
            panic!("upgrade timelock not elapsed");
        }

        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .unwrap_or(CONTRACT_VERSION_INIT);
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &(version + 1));
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingUpgrade>>(&DataKey::PendingUpg, &None);

        env.events().publish(
            (Symbol::new(&env, "upgraded"),),
            (pending.wasm_hash.clone(), version + 1),
        );

        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash);
    }

    pub fn cancel_upgrade(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: Option<PendingUpgrade> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpg)
            .unwrap_or(None);
        let pending = pending.unwrap_or_else(|| panic!("no pending upgrade"));

        env.storage()
            .instance()
            .set::<DataKey, Option<PendingUpgrade>>(&DataKey::PendingUpg, &None);

        env.events().publish(
            (Symbol::new(&env, "cancel_upg"),),
            pending.wasm_hash,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: ADMIN TRANSFER
    // ─────────────────────────────────────────────────────────────────────────

    pub fn propose_admin_transfer(env: Env, admin: Address, new_admin: Address) {
        require_admin(&env, &admin);

        let existing: Option<PendingAdminTransfer> = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdminXfer)
            .unwrap_or(None);
        if existing.is_some() {
            panic!("pending admin transfer already exists");
        }

        // New admin must differ from current active operator
        let active_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveEpochId)
            .unwrap_or(1);
        let active_epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(active_id))
            .unwrap_or_else(|| panic!("active epoch missing"));
        if new_admin == active_epoch.oracle_address {
            panic!("new admin must differ from operator");
        }

        new_admin.require_auth();

        let current_ledger = env.ledger().sequence();
        let timelock: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgTimelockLedgers)
            .unwrap_or(MIN_UPGRADE_TIMELOCK_LEDGERS);
        let execute_after = current_ledger
            .checked_add(timelock)
            .unwrap_or_else(|| panic!("timelock overflow"));

        let pending = PendingAdminTransfer {
            new_admin: new_admin.clone(),
            proposed_ledger: current_ledger,
            execute_after_ledger: execute_after,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingAdminXfer, &Some(pending));

        env.events().publish(
            (Symbol::new(&env, "propose_adm"),),
            (new_admin, execute_after),
        );
    }

    pub fn execute_admin_transfer(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: Option<PendingAdminTransfer> = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdminXfer)
            .unwrap_or(None);
        let pending = pending.unwrap_or_else(|| panic!("no pending admin transfer"));

        if env.ledger().sequence() < pending.execute_after_ledger {
            panic!("admin transfer timelock not elapsed");
        }

        let old_admin = admin.clone();
        env.storage()
            .instance()
            .set(&DataKey::Admin, &pending.new_admin);
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingAdminTransfer>>(&DataKey::PendingAdminXfer, &None);

        env.events().publish(
            (Symbol::new(&env, "admin_xfer"),),
            (old_admin, pending.new_admin),
        );
    }

    pub fn cancel_admin_transfer(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: Option<PendingAdminTransfer> = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdminXfer)
            .unwrap_or(None);
        let pending = pending.unwrap_or_else(|| panic!("no pending admin transfer"));

        env.storage()
            .instance()
            .set::<DataKey, Option<PendingAdminTransfer>>(&DataKey::PendingAdminXfer, &None);

        env.events().publish(
            (Symbol::new(&env, "cancel_adm"),),
            pending.new_admin,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EPOCH LIFECYCLE
    // ─────────────────────────────────────────────────────────────────────────

    /// Anyone can call. Removes storage for an epoch that has no pending
    /// requests and is not the active epoch.
    pub fn retire_epoch(env: Env, epoch_id: u32) {
        let epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| panic!("epoch not found"));

        let active_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveEpochId)
            .unwrap_or(1);
        if epoch_id == active_id {
            panic!("cannot retire active epoch");
        }

        if epoch.pending_count > 0 {
            panic!("epoch still has pending requests");
        }

        // Not the target of a pending rotation
        let pending: Option<PendingRotation> = env
            .storage()
            .instance()
            .get(&DataKey::PendingRot)
            .unwrap_or(None);
        if let Some(p) = pending {
            if epoch_id == p.new_epoch_id {
                panic!("epoch is target of pending rotation");
            }
        }

        env.storage()
            .persistent()
            .remove(&DataKey::Epoch(epoch_id));

        let retained: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RetainedEpochCount)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&DataKey::RetainedEpochCount, &retained.saturating_sub(1));

        env.events()
            .publish((Symbol::new(&env, "epoch_ret"),), epoch_id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GETTERS
    // ─────────────────────────────────────────────────────────────────────────

    pub fn oracle_pk(env: Env) -> BytesN<192> {
        let epoch = load_active_epoch(&env);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        epoch.oracle_bls_pk
    }

    pub fn oracle_address(env: Env) -> Address {
        let epoch = load_active_epoch(&env);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        epoch.oracle_address
    }

    pub fn drand_pk(env: Env) -> BytesN<192> {
        let epoch = load_active_epoch(&env);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        epoch.drand_pk
    }

    pub fn drand_genesis_time(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::DrandGenesis)
            .unwrap_or_else(|| panic!("genesis missing"))
    }

    pub fn drand_period(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DrandPeriod)
            .unwrap_or_else(|| panic!("period missing"))
    }

    pub fn current_epoch_id(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ActiveEpochId)
            .unwrap_or(1)
    }

    pub fn retained_epoch_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RetainedEpochCount)
            .unwrap_or(1)
    }

    pub fn epoch_data(env: Env, epoch_id: u32) -> EpochData {
        let epoch: EpochData = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(epoch_id))
            .unwrap_or_else(|| panic!("epoch not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::Epoch(epoch_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        epoch
    }

    pub fn epoch_status(env: Env, epoch_id: u32) -> EpochStatus {
        Self::epoch_data(env, epoch_id).status
    }

    pub fn request_epoch(env: Env, request_id: u64) -> u32 {
        let eid: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestEpoch(request_id))
            .unwrap_or_else(|| panic!("request epoch missing"));
        env.storage().persistent().extend_ttl(
            &DataKey::RequestEpoch(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        eid
    }

    pub fn pending_rotation(env: Env) -> Option<PendingRotation> {
        env.storage()
            .instance()
            .get(&DataKey::PendingRot)
            .unwrap_or(None)
    }

    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage()
            .instance()
            .get(&DataKey::PendingUpg)
            .unwrap_or(None)
    }

    pub fn pending_admin_transfer(env: Env) -> Option<PendingAdminTransfer> {
        env.storage()
            .instance()
            .get(&DataKey::PendingAdminXfer)
            .unwrap_or(None)
    }

    pub fn contract_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .unwrap_or(CONTRACT_VERSION_INIT)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("admin missing"))
    }

    pub fn timeout_rounds(_env: Env) -> u64 {
        TIMEOUT_ROUNDS
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

    pub fn is_refunded(env: Env, request_id: u64) -> bool {
        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Refunded(request_id))
        {
            env.storage().persistent().extend_ttl(
                &DataKey::Refunded(request_id),
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }
        refunded
    }

    pub fn callback_of(env: Env, request_id: u64) -> Option<(Address, Symbol)> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::CallbackContract(request_id))
        {
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
        proof
    }

    pub fn get_beta(env: Env, request_id: u64) -> BytesN<32> {
        read_beta(&env, request_id)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DERIVATION FUNCTIONS (preserved from V1)
    // ─────────────────────────────────────────────────────────────────────────

    pub fn derive_random(env: Env, request_id: u64) -> u64 {
        let beta = read_beta(&env, request_id);
        let mut input = derive_prefix(&env, DERIVE_TAG_U64, request_id);
        input.append(&Bytes::from_slice(&env, &beta.to_array()));
        let hash_arr = env.crypto().sha256(&input).to_array();
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&hash_arr[0..8]);
        u64::from_be_bytes(buf)
    }

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

    // ─────────────────────────────────────────────────────────────────────────
    // CLEANUP
    // ─────────────────────────────────────────────────────────────────────────

    /// Remove bulky proof data for a fulfilled request. Keeps: Fulfilled, Beta,
    /// Requester, RequestRound, RequestEpoch, Refunded.
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

        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("requester not found"));
        let active_epoch = load_active_epoch(&env);

        if caller != requester && caller != active_epoch.oracle_address {
            panic!("only requester or oracle can cleanup");
        }

        remove_if_exists(&env, &DataKey::Proof(request_id));
        remove_if_exists(&env, &DataKey::RequestContext(request_id));
        remove_if_exists(&env, &DataKey::CallbackContract(request_id));
        remove_if_exists(&env, &DataKey::CallbackFn(request_id));
        // RequestEpoch is NEVER deleted

        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        env.events()
            .publish((symbol_short!("cleanup"),), request_id);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

fn require_admin(env: &Env, admin: &Address) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic!("admin missing"));
    if *admin != stored_admin {
        panic!("unauthorized: not admin");
    }
    admin.require_auth();
}

fn load_active_epoch(env: &Env) -> EpochData {
    let active_id: u32 = env
        .storage()
        .instance()
        .get(&DataKey::ActiveEpochId)
        .unwrap_or(1);
    env.storage()
        .persistent()
        .get(&DataKey::Epoch(active_id))
        .unwrap_or_else(|| panic!("active epoch missing"))
}

fn remove_if_exists(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage().persistent().remove(key);
    }
}

fn compute_required_round(now_ts: u64, genesis: u64, period: u32, offset: u32) -> u64 {
    compute_current_round(now_ts, genesis, period).saturating_add(offset as u64)
}

fn compute_current_round(now_ts: u64, genesis: u64, period: u32) -> u64 {
    if now_ts < genesis || period == 0 {
        return 0;
    }
    (now_ts - genesis) / (period as u64) + 1
}

fn u64_be_bytes(env: &Env, value: u64) -> Bytes {
    Bytes::from_slice(env, &value.to_be_bytes())
}

fn u32_be_bytes(env: &Env, value: u32) -> Bytes {
    Bytes::from_slice(env, &value.to_be_bytes())
}

fn g2_generator(env: &Env) -> Bls12381G2Affine {
    Bls12381G2Affine::from_bytes(BytesN::from_array(env, &BLS12_381_G2_GENERATOR))
}

fn is_g2_infinity_encoding(key: &BytesN<192>) -> bool {
    let bytes = key.to_array();
    bytes[0] == 0x40 && bytes[1..].iter().all(|b| *b == 0)
}

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

fn validate_ed25519_key(key: &BytesN<32>) {
    if key.to_array().iter().all(|b| *b == 0) {
        panic!("oracle ed25519 key must not be all zero");
    }
}

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

fn derive_prefix(env: &Env, tag: u8, request_id: u64) -> Bytes {
    let mut input = Bytes::from_slice(env, DERIVE_DOMAIN);
    input.push_back(tag);
    input.append(&u64_be_bytes(env, request_id));
    input
}

/// Exact-uniform reduction of a 32-byte hash into `[0, max)` by rejection
/// sampling over its two 128-bit halves. Preserved from V1.
pub(crate) fn reduce_uniform(hash: &[u8; 32], max: u64) -> u64 {
    let max128 = max as u128;
    let rem = (u128::MAX - max128 + 1) % max128;
    let mut c = [0u8; 16];
    for half in 0..2 {
        c.copy_from_slice(&hash[half * 16..half * 16 + 16]);
        let candidate = u128::from_be_bytes(c);
        if rem == 0 || candidate <= u128::MAX - rem {
            return (candidate % max128) as u64;
        }
    }
    panic!("range derivation failed: both candidates rejected");
}

/// V2 alpha derivation: includes `epoch_id` for cross-epoch domain separation.
fn derive_expected_alpha(
    env: &Env,
    request_id: u64,
    drand_round: u64,
    drand_signature: &BytesN<96>,
    epoch_id: u32,
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

    // V2: epoch_id domain separation
    input.append(&u32_be_bytes(env, epoch_id));

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

/// V2: drand signature verification with explicit drand_pk parameter
/// (not read from instance storage).
fn verify_drand_signature_with_pk(
    env: &Env,
    proof: &BlsVrfProof,
    drand_pk: &BytesN<192>,
) -> bool {
    let bls = env.crypto().bls12_381();
    let drand_sig = Bls12381G1Affine::from_bytes(proof.drand_signature.clone());
    let drand_pk_point = Bls12381G2Affine::from_bytes(drand_pk.clone());

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
    g2_vec.push_back(drand_pk_point);

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

    // ── Verify active epoch is not revoked ──
    let active_epoch_id: u32 = env
        .storage()
        .instance()
        .get(&DataKey::ActiveEpochId)
        .unwrap_or(1);
    let mut active_epoch: EpochData = env
        .storage()
        .persistent()
        .get(&DataKey::Epoch(active_epoch_id))
        .unwrap_or_else(|| panic!("active epoch missing"));

    if active_epoch.status != EpochStatus::Active {
        panic!("active epoch not accepting requests");
    }

    // ── Charge fee ──
    let fee_amount: i128 = env
        .storage()
        .instance()
        .get(&DataKey::FeeAmount)
        .unwrap_or(0);
    if fee_amount > 0 {
        let fee_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::FeeToken)
            .unwrap_or_else(|| panic!("fee token missing"));
        let contract_addr = env.current_contract_address();
        let transfer_fn = Symbol::new(env, "transfer");
        let mut args = Vec::<Val>::new(env);
        args.push_back(requester.clone().into_val(env));
        args.push_back(contract_addr.into_val(env));
        args.push_back(fee_amount.into_val(env));
        env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
    }

    let counter: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
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
    let required_round = compute_required_round(env.ledger().timestamp(), genesis, period, offset);

    // ── Store request data with epoch binding ──
    env.storage()
        .persistent()
        .set(&DataKey::RequestEpoch(id), &active_epoch_id);
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
        let cb_fn = callback_fn.unwrap_or_else(|| panic!("callback_fn required"));
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

    // Extend TTLs for all per-request entries
    for key in &[
        DataKey::RequestEpoch(id),
        DataKey::RequestContext(id),
        DataKey::Requester(id),
        DataKey::RequestRound(id),
        DataKey::Fulfilled(id),
        DataKey::Refunded(id),
    ] {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    // ── Increment epoch pending_count (S7) ──
    active_epoch.pending_count = active_epoch
        .pending_count
        .checked_add(1)
        .unwrap_or_else(|| panic!("pending count overflow"));
    env.storage()
        .persistent()
        .set(&DataKey::Epoch(active_epoch_id), &active_epoch);

    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

    env.events().publish(
        (symbol_short!("request"),),
        (id, requester, active_epoch_id, required_round),
    );

    id
}

/// Invoke the consumer callback if one was registered with `request_with_callback`.
/// Failure is isolated: callback panics don't revert fulfillment.
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

    let result =
        env.try_invoke_contract::<Val, soroban_sdk::Error>(&callback_contract, &callback_fn, args);
    if result.is_err() {
        env.events().publish(
            (symbol_short!("cb_failed"),),
            (request_id, callback_contract),
        );
    }
}
