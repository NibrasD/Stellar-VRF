#![no_std]
#![allow(unknown_lints)]
#![allow(deprecated)]
#![allow(dos_unexpected_revert_with_storage)]

//! Stellar-VRF V2 oracle contract.
//!
//! # Trust model
//! - **Operator** (hot key, runs the worker): can only *fulfill* requests. Each
//!   request is bound at `request()` time to the key epoch that was active then,
//!   and `fulfill()` verifies against that epoch's BLS key and the immutable drand
//!   key. BLS signatures are unique, so with the keys fixed before the drand round
//!   is public the operator has exactly one valid output per request: it can
//!   delay or withhold, it cannot choose.
//! - **Admin** (cold key / multisig): key rotation, epoch revocation, contract
//!   upgrade and admin transfer, all behind timelocks except revocation. The admin
//!   is trusted for upgrades: new code can do anything. New requests are refused
//!   while an upgrade is pending so no request is created under code that is about
//!   to be replaced.
//! - **drand**: the drand public key is fixed at construction. drand keeps the
//!   group key across reshares; a new key means a new chain, which this contract
//!   cannot follow anyway (genesis and period are fixed).

#[cfg(test)]
mod test;
#[cfg(any(test, feature = "testutils"))]
pub mod testkeys;

use soroban_sdk::crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine};
use soroban_sdk::xdr::ToXdr;
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
/// Prefix of the proof-of-possession message. See [`pop_message`].
pub const POP_DOMAIN: &[u8] = b"STELLAR_VRF_BLS_POP_V2";
const BETA_DOMAIN: &[u8] = b"VREP_BETA_V1";
/// Domain tag for every value derived from a stored beta.
const DERIVE_DOMAIN: &[u8] = b"VREP_DERIVE_V2";
const DERIVE_TAG_U64: u8 = 0x01;
const DERIVE_TAG_RANGE: u8 = 0x02;
const DERIVE_TAG_RANGE_DOMAIN: u8 = 0x03;

/// Minimum number of drand rounds between the request ledger and the bound
/// round. With quicknet (3 s) and offset 4 the beacon is published 9–12 s after
/// the request ledger's close time, which leaves room for close-time drift.
pub const MIN_ROUND_OFFSET: u32 = 4;
/// After this many rounds past the bound round the **requester** may refund.
pub const TIMEOUT_ROUNDS: u64 = 20;
/// After this many rounds past the bound round **anyone** may trigger the
/// refund (the fee always goes back to the requester). 28 800 rounds = 24 h on
/// quicknet. This guarantees every unfulfilled request can be closed out even
/// if its requester never acts.
pub const EXPIRY_ROUNDS: u64 = 28_800;
const MAX_CONTEXT_LEN: u32 = 1024;
pub const MAX_DERIVE_DOMAIN_LEN: u32 = 64;

/// Minimum timelocks (compile-time floors). Constructor rejects lower values.
pub const MIN_ROTATION_TIMELOCK_LEDGERS: u32 = 2_880; // ~4 hours
pub const MIN_UPGRADE_TIMELOCK_LEDGERS: u32 = 8_640; // ~12 hours

const CONTRACT_VERSION_INIT: u32 = 2;
const STORAGE_VERSION_INIT: u32 = 1;

/// Canonical generator of the BLS12-381 G2 group, uncompressed (192 bytes).
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

/// An immutable key set (only `status` ever changes). Epoch records are never
/// deleted: deleting a persistent entry refunds no rent on Soroban, and keeping
/// them means a pending request can always find its keys.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EpochData {
    pub oracle_bls_pk: BytesN<192>,
    pub oracle_address: Address,
    pub status: EpochStatus,
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

/// The oracle's proof. The BLS public key is not part of it: it is read from the
/// request's epoch.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BlsVrfProof {
    pub alpha_seed: BytesN<32>,
    pub gamma_point: BytesN<96>,
    pub beta_output: BytesN<32>,
    pub drand_round: u64,
    pub drand_signature: BytesN<96>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // ── Instance Storage ─────────────────────────────────────
    Admin,
    DrandPK,
    DrandGenesis,
    DrandPeriod,
    RoundOffset,
    Counter,
    FeeToken,
    FeeAmount,
    EpochCounter,
    ActiveEpochId,
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
    /// Present (true) only once fulfilled. Absent means "not fulfilled".
    Fulfilled(u64),
    /// Present (true) only once refunded. Absent means "not refunded".
    Refunded(u64),
    Proof(u64),
    Beta(u64),
    /// Present while a callback is registered and not yet delivered.
    CallbackContract(u64),
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
    /// - `round_offset >= MIN_ROUND_OFFSET`
    /// - timelocks at or above their compile-time floors
    /// - BLS keys are valid G2 subgroup points, not infinity, not the generator,
    ///   and the oracle key differs from the drand key
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        oracle_pk: BytesN<192>,
        oracle_address: Address,
        drand_pk: BytesN<192>,
        drand_genesis_time: u64,
        drand_period: u32,
        round_offset: u32,
        fee_token: Address,
        fee_amount: i128,
        rotation_timelock_ledgers: u32,
        upgrade_timelock_ledgers: u32,
    ) {
        if admin == oracle_address {
            panic!("admin must differ from oracle operator");
        }
        if rotation_timelock_ledgers < MIN_ROTATION_TIMELOCK_LEDGERS {
            panic!("rotation timelock below minimum");
        }
        if upgrade_timelock_ledgers < MIN_UPGRADE_TIMELOCK_LEDGERS {
            panic!("upgrade timelock below minimum");
        }
        if drand_period == 0 {
            panic!("drand period must be > 0");
        }
        if round_offset < MIN_ROUND_OFFSET {
            panic!("round_offset below minimum");
        }
        if fee_amount < 0 {
            panic!("fee_amount must be >= 0");
        }
        validate_g2_public_key(&env, &oracle_pk, "oracle pk");
        validate_g2_public_key(&env, &drand_pk, "drand pk");
        if oracle_pk == drand_pk {
            panic!("oracle pk must differ from drand pk");
        }

        admin.require_auth();
        oracle_address.require_auth();

        let epoch = EpochData {
            oracle_bls_pk: oracle_pk.clone(),
            oracle_address,
            status: EpochStatus::Active,
            created_ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&DataKey::Epoch(1), &epoch);
        bump_persistent(&env, &DataKey::Epoch(1));

        let inst = env.storage().instance();
        inst.set(&DataKey::Admin, &admin);
        inst.set(&DataKey::DrandPK, &drand_pk);
        inst.set(&DataKey::DrandGenesis, &drand_genesis_time);
        inst.set(&DataKey::DrandPeriod, &drand_period);
        inst.set(&DataKey::RoundOffset, &round_offset);
        inst.set(&DataKey::Counter, &0u64);
        inst.set(&DataKey::FeeToken, &fee_token);
        inst.set(&DataKey::FeeAmount, &fee_amount);
        inst.set(&DataKey::EpochCounter, &1u32);
        inst.set(&DataKey::ActiveEpochId, &1u32);
        inst.set(&DataKey::ContractVersion, &CONTRACT_VERSION_INIT);
        inst.set(&DataKey::StorageVersion, &STORAGE_VERSION_INIT);
        inst.set(&DataKey::RotTimelockLedgers, &rotation_timelock_ledgers);
        inst.set(&DataKey::UpgTimelockLedgers, &upgrade_timelock_ledgers);
        bump_instance(&env);

        env.events()
            .publish((symbol_short!("init"),), (oracle_pk, admin));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REQUEST
    // ─────────────────────────────────────────────────────────────────────────

    pub fn request(env: Env, context: Bytes, requester: Address) -> u64 {
        request_internal(&env, context, requester, false)
    }

    /// Request randomness and have `on_vrf(request_id, beta, alpha)` called on
    /// the requester through [`Self::deliver`] after fulfillment.
    ///
    /// `callback_contract` must equal `requester` and `callback_fn` must be
    /// `on_vrf` (confused-deputy protection).
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
        request_internal(&env, context, requester, true)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FULFILL
    // ─────────────────────────────────────────────────────────────────────────

    /// Fulfill a VRF request. Verifies against the BLS key of the epoch bound at
    /// request time and the immutable drand key.
    ///
    /// No consumer code runs here: the cost of `fulfill()` is fixed and cannot be
    /// influenced by anyone after the output is known. A registered callback is
    /// run separately by [`Self::deliver`], so a failing or expensive callback can
    /// never undo or block the result.
    ///
    /// Authorization of the epoch's operator covers every argument, including
    /// the proof, so no extra signature is needed.
    pub fn fulfill(env: Env, request_id: u64, proof: BlsVrfProof) {
        // ── CHECKS ──────────────────────────────────────────────────────────
        if flag(&env, &DataKey::Refunded(request_id)) {
            panic!("request refunded");
        }
        if !env
            .storage()
            .persistent()
            .has(&DataKey::RequestContext(request_id))
        {
            panic!("request not found");
        }
        if flag(&env, &DataKey::Fulfilled(request_id)) {
            panic!("already fulfilled");
        }

        let epoch_id = request_epoch_id(&env, request_id);
        let epoch = load_epoch(&env, epoch_id);
        if epoch.status == EpochStatus::Revoked {
            panic!("epoch revoked");
        }
        epoch.oracle_address.require_auth();

        let required_round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request round missing"));
        if proof.drand_round != required_round {
            panic!("drand round mismatch");
        }

        let drand_pk: BytesN<192> = inst_get(&env, &DataKey::DrandPK, "drand pk missing");
        if !verify_drand_signature(&env, &proof, &drand_pk) {
            panic!("drand signature verification failed");
        }

        let expected_alpha = derive_expected_alpha(
            &env,
            request_id,
            proof.drand_round,
            &proof.drand_signature,
            epoch_id,
        );
        if expected_alpha != proof.alpha_seed {
            panic!("alpha seed mismatch");
        }

        if !verify_bls_vrf_proof(&env, &proof, &epoch.oracle_bls_pk) {
            panic!("bls vrf verification failed");
        }
        if derive_beta_output(&env, &proof.gamma_point) != proof.beta_output {
            panic!("beta output mismatch");
        }

        // ── EFFECTS ─────────────────────────────────────────────────────────
        let ps = env.storage().persistent();
        ps.set(&DataKey::Proof(request_id), &proof);
        ps.set(&DataKey::Beta(request_id), &proof.beta_output);
        ps.set(&DataKey::Fulfilled(request_id), &true);
        bump_persistent(&env, &DataKey::Proof(request_id));
        bump_persistent(&env, &DataKey::Beta(request_id));
        bump_persistent(&env, &DataKey::Fulfilled(request_id));
        bump_instance(&env);

        // ── INTERACTION: fee to the epoch's operator (trusted SAC) ──────────
        transfer_fee(&env, &env.current_contract_address(), &epoch.oracle_address);

        env.events().publish(
            (symbol_short!("fulfill"),),
            (request_id, proof.beta_output, epoch_id),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CALLBACK DELIVERY
    // ─────────────────────────────────────────────────────────────────────────

    /// Deliver a fulfilled result to the requester's `on_vrf`. Anyone may call.
    ///
    /// The result is already final when this runs, so delivery has no influence
    /// on it. If `on_vrf` fails (panic, error or resource exhaustion) this whole
    /// call reverts and the callback stays pending: it can be retried, by the
    /// worker or by the consumer itself. On success the callback is marked
    /// delivered and cannot run again.
    pub fn deliver(env: Env, request_id: u64) {
        if !flag(&env, &DataKey::Fulfilled(request_id)) {
            panic!("request not yet fulfilled");
        }
        let callback_contract: Address = env
            .storage()
            .persistent()
            .get(&DataKey::CallbackContract(request_id))
            .unwrap_or_else(|| panic!("no pending callback"));
        let proof: BlsVrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof missing"));

        // Effects before the interaction. A failing callback reverts this too.
        env.storage()
            .persistent()
            .remove(&DataKey::CallbackContract(request_id));

        let mut args = Vec::<Val>::new(&env);
        args.push_back(request_id.into_val(&env));
        args.push_back(proof.beta_output.into_val(&env));
        args.push_back(proof.alpha_seed.into_val(&env));
        env.invoke_contract::<Val>(&callback_contract, &Symbol::new(&env, "on_vrf"), args);

        env.events().publish(
            (symbol_short!("delivered"),),
            (request_id, callback_contract),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REFUNDS
    // ─────────────────────────────────────────────────────────────────────────

    /// Refund an unfulfilled request. The fee always goes to the requester.
    ///
    /// - after `TIMEOUT_ROUNDS` past the bound round: the requester may call;
    /// - after `EXPIRY_ROUNDS`: anyone may call, so no request can stay open
    ///   forever because its requester never acts.
    ///
    /// Consumers must NOT re-request randomness for the same event after a
    /// refund: that would let whoever withheld the result re-roll it.
    pub fn timeout_refund(env: Env, request_id: u64) {
        let requester = load_requester(&env, request_id);
        ensure_open(&env, request_id);

        let required_round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request round missing"));
        let current_round = current_round(&env);
        if current_round <= required_round.saturating_add(TIMEOUT_ROUNDS) {
            panic!("timeout window not reached");
        }
        if current_round <= required_round.saturating_add(EXPIRY_ROUNDS) {
            requester.require_auth();
        }

        refund_internal(&env, request_id, &requester);
        env.events()
            .publish((symbol_short!("timeout"),), (request_id, requester));
    }

    /// Immediate refund for an unfulfilled request bound to a revoked epoch.
    /// Anyone can call; the fee goes to the requester.
    pub fn emergency_refund(env: Env, request_id: u64) {
        let requester = load_requester(&env, request_id);
        ensure_open(&env, request_id);

        let epoch_id = request_epoch_id(&env, request_id);
        if load_epoch(&env, epoch_id).status != EpochStatus::Revoked {
            panic!("emergency refund only for revoked epochs");
        }

        refund_internal(&env, request_id, &requester);
        env.events().publish(
            (Symbol::new(&env, "emrg_refund"),),
            (request_id, epoch_id, requester),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: KEY ROTATION
    // ─────────────────────────────────────────────────────────────────────────

    /// Propose a new key epoch. Requires the admin, the new operator account,
    /// and a BLS proof of possession over [`pop_message`].
    ///
    /// Only the oracle BLS key and the operator account rotate. The drand key is
    /// fixed for the life of the contract.
    pub fn propose_key_rotation(
        env: Env,
        admin: Address,
        new_oracle_pk: BytesN<192>,
        new_oracle_address: Address,
        bls_pop_signature: BytesN<96>,
    ) {
        require_admin(&env, &admin);

        let existing: Option<PendingRotation> = env
            .storage()
            .instance()
            .get(&DataKey::PendingRot)
            .unwrap_or(None);
        if existing.is_some() {
            panic!("pending rotation already exists");
        }
        if new_oracle_address == admin {
            panic!("new operator must differ from admin");
        }

        validate_g2_public_key(&env, &new_oracle_pk, "new oracle pk");
        let drand_pk: BytesN<192> = inst_get(&env, &DataKey::DrandPK, "drand pk missing");
        if new_oracle_pk == drand_pk {
            panic!("oracle pk must differ from drand pk");
        }
        new_oracle_address.require_auth();

        let epoch_counter: u32 = inst_get(&env, &DataKey::EpochCounter, "epoch counter missing");
        let new_epoch_id = epoch_counter
            .checked_add(1)
            .unwrap_or_else(|| panic!("epoch counter overflow"));
        env.storage()
            .instance()
            .set(&DataKey::EpochCounter, &new_epoch_id);

        // ── Proof of possession of the new BLS secret key ──
        let msg = pop_message(&env, new_epoch_id, &new_oracle_pk);
        let bls = env.crypto().bls12_381();
        let h_pop = bls.hash_to_g1(&msg, &Bytes::from_slice(&env, POP_BLS_DST));
        let pop_sig = Bls12381G1Affine::from_bytes(bls_pop_signature);
        if !pairing_eq(
            &env,
            pop_sig,
            h_pop,
            Bls12381G2Affine::from_bytes(new_oracle_pk.clone()),
        ) {
            panic!("BLS proof of possession failed");
        }

        let current_ledger = env.ledger().sequence();
        let timelock: u32 = inst_get(&env, &DataKey::RotTimelockLedgers, "timelock missing");
        let execute_after = current_ledger
            .checked_add(timelock)
            .unwrap_or_else(|| panic!("timelock overflow"));
        let active_id: u32 = inst_get(&env, &DataKey::ActiveEpochId, "active epoch missing");

        let pending = PendingRotation {
            new_epoch: EpochData {
                oracle_bls_pk: new_oracle_pk.clone(),
                oracle_address: new_oracle_address,
                status: EpochStatus::Active,
                created_ledger: current_ledger,
            },
            new_epoch_id,
            source_epoch_id: active_id,
            proposed_ledger: current_ledger,
            execute_after_ledger: execute_after,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingRot, &Some(pending));
        bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "propose_rot"),),
            (new_epoch_id, new_oracle_pk, execute_after, active_id),
        );
    }

    /// Execute a pending key rotation after the timelock. The previous epoch
    /// becomes `Superseded` (a `Revoked` epoch stays `Revoked`); its pending
    /// requests are still fulfilled with its own keys.
    pub fn execute_key_rotation(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: PendingRotation = env
            .storage()
            .instance()
            .get::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot)
            .unwrap_or(None)
            .unwrap_or_else(|| panic!("no pending rotation"));
        if env.ledger().sequence() < pending.execute_after_ledger {
            panic!("rotation timelock not elapsed");
        }

        let old_epoch_id: u32 = inst_get(&env, &DataKey::ActiveEpochId, "active epoch missing");
        let mut old_epoch = load_epoch(&env, old_epoch_id);
        if old_epoch.status != EpochStatus::Revoked {
            old_epoch.status = EpochStatus::Superseded;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(old_epoch_id), &old_epoch);
        bump_persistent(&env, &DataKey::Epoch(old_epoch_id));

        env.storage()
            .persistent()
            .set(&DataKey::Epoch(pending.new_epoch_id), &pending.new_epoch);
        bump_persistent(&env, &DataKey::Epoch(pending.new_epoch_id));
        env.storage()
            .instance()
            .set(&DataKey::ActiveEpochId, &pending.new_epoch_id);
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot, &None);
        bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "exec_rot"),),
            (old_epoch_id, pending.new_epoch_id),
        );
    }

    pub fn cancel_key_rotation(env: Env, admin: Address) {
        require_admin(&env, &admin);
        let pending: PendingRotation = env
            .storage()
            .instance()
            .get::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot)
            .unwrap_or(None)
            .unwrap_or_else(|| panic!("no pending rotation"));
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingRotation>>(&DataKey::PendingRot, &None);
        env.events()
            .publish((Symbol::new(&env, "cancel_rot"),), pending.new_epoch_id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: EMERGENCY
    // ─────────────────────────────────────────────────────────────────────────

    /// Revoke an epoch permanently (no timelock: this only removes power).
    /// Unfulfilled requests of that epoch can then be refunded at once with
    /// [`Self::emergency_refund`]. Revoking the active epoch stops new requests
    /// until a rotation executes. A pending rotation whose source is the revoked
    /// epoch is cancelled.
    pub fn revoke_epoch(env: Env, admin: Address, epoch_id: u32) {
        require_admin(&env, &admin);

        let mut epoch = load_epoch(&env, epoch_id);
        if epoch.status == EpochStatus::Revoked {
            panic!("epoch already revoked");
        }
        epoch.status = EpochStatus::Revoked;
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(epoch_id), &epoch);
        bump_persistent(&env, &DataKey::Epoch(epoch_id));

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
        bump_instance(&env);

        env.events()
            .publish((Symbol::new(&env, "epoch_revkd"),), epoch_id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOVERNANCE: UPGRADE
    // ─────────────────────────────────────────────────────────────────────────

    /// Propose a code upgrade. From now until the upgrade is executed or
    /// cancelled, `request()` is refused, so no request is ever created under
    /// code that is about to be replaced.
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
        let timelock: u32 = inst_get(&env, &DataKey::UpgTimelockLedgers, "timelock missing");
        let execute_after = current_ledger
            .checked_add(timelock)
            .unwrap_or_else(|| panic!("timelock overflow"));

        env.storage().instance().set(
            &DataKey::PendingUpg,
            &Some(PendingUpgrade {
                wasm_hash: wasm_hash.clone(),
                proposed_ledger: current_ledger,
                execute_after_ledger: execute_after,
            }),
        );
        bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "propose_upg"),),
            (wasm_hash, execute_after),
        );
    }

    pub fn execute_upgrade(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get::<DataKey, Option<PendingUpgrade>>(&DataKey::PendingUpg)
            .unwrap_or(None)
            .unwrap_or_else(|| panic!("no pending upgrade"));
        if env.ledger().sequence() < pending.execute_after_ledger {
            panic!("upgrade timelock not elapsed");
        }

        let version: u32 = inst_get(&env, &DataKey::ContractVersion, "version missing");
        let new_version = version
            .checked_add(1)
            .unwrap_or_else(|| panic!("version overflow"));
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &new_version);
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingUpgrade>>(&DataKey::PendingUpg, &None);

        env.events().publish(
            (Symbol::new(&env, "upgraded"),),
            (pending.wasm_hash.clone(), new_version),
        );

        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash);
    }

    pub fn cancel_upgrade(env: Env, admin: Address) {
        require_admin(&env, &admin);
        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get::<DataKey, Option<PendingUpgrade>>(&DataKey::PendingUpg)
            .unwrap_or(None)
            .unwrap_or_else(|| panic!("no pending upgrade"));
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingUpgrade>>(&DataKey::PendingUpg, &None);
        env.events()
            .publish((Symbol::new(&env, "cancel_upg"),), pending.wasm_hash);
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
        if new_admin == load_active_epoch(&env).1.oracle_address {
            panic!("new admin must differ from operator");
        }
        new_admin.require_auth();

        let current_ledger = env.ledger().sequence();
        let timelock: u32 = inst_get(&env, &DataKey::UpgTimelockLedgers, "timelock missing");
        let execute_after = current_ledger
            .checked_add(timelock)
            .unwrap_or_else(|| panic!("timelock overflow"));

        env.storage().instance().set(
            &DataKey::PendingAdminXfer,
            &Some(PendingAdminTransfer {
                new_admin: new_admin.clone(),
                proposed_ledger: current_ledger,
                execute_after_ledger: execute_after,
            }),
        );
        bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "propose_adm"),),
            (new_admin, execute_after),
        );
    }

    pub fn execute_admin_transfer(env: Env, admin: Address) {
        require_admin(&env, &admin);

        let pending: PendingAdminTransfer = env
            .storage()
            .instance()
            .get::<DataKey, Option<PendingAdminTransfer>>(&DataKey::PendingAdminXfer)
            .unwrap_or(None)
            .unwrap_or_else(|| panic!("no pending admin transfer"));
        if env.ledger().sequence() < pending.execute_after_ledger {
            panic!("admin transfer timelock not elapsed");
        }
        // The operator may have rotated since the proposal.
        if pending.new_admin == load_active_epoch(&env).1.oracle_address {
            panic!("new admin must differ from operator");
        }

        env.storage()
            .instance()
            .set(&DataKey::Admin, &pending.new_admin);
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingAdminTransfer>>(&DataKey::PendingAdminXfer, &None);
        bump_instance(&env);

        env.events().publish(
            (Symbol::new(&env, "admin_xfer"),),
            (admin, pending.new_admin),
        );
    }

    pub fn cancel_admin_transfer(env: Env, admin: Address) {
        require_admin(&env, &admin);
        let pending: PendingAdminTransfer = env
            .storage()
            .instance()
            .get::<DataKey, Option<PendingAdminTransfer>>(&DataKey::PendingAdminXfer)
            .unwrap_or(None)
            .unwrap_or_else(|| panic!("no pending admin transfer"));
        env.storage()
            .instance()
            .set::<DataKey, Option<PendingAdminTransfer>>(&DataKey::PendingAdminXfer, &None);
        env.events()
            .publish((Symbol::new(&env, "cancel_adm"),), pending.new_admin);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GETTERS
    // ─────────────────────────────────────────────────────────────────────────

    pub fn oracle_pk(env: Env) -> BytesN<192> {
        load_active_epoch(&env).1.oracle_bls_pk
    }

    pub fn oracle_address(env: Env) -> Address {
        load_active_epoch(&env).1.oracle_address
    }

    pub fn drand_pk(env: Env) -> BytesN<192> {
        inst_get(&env, &DataKey::DrandPK, "drand pk missing")
    }

    pub fn drand_genesis_time(env: Env) -> u64 {
        inst_get(&env, &DataKey::DrandGenesis, "genesis missing")
    }

    pub fn drand_period(env: Env) -> u32 {
        inst_get(&env, &DataKey::DrandPeriod, "period missing")
    }

    pub fn round_offset(env: Env) -> u32 {
        inst_get(&env, &DataKey::RoundOffset, "round offset missing")
    }

    pub fn fee(env: Env) -> (Address, i128) {
        (
            inst_get(&env, &DataKey::FeeToken, "fee token missing"),
            inst_get(&env, &DataKey::FeeAmount, "fee amount missing"),
        )
    }

    pub fn current_epoch_id(env: Env) -> u32 {
        inst_get(&env, &DataKey::ActiveEpochId, "active epoch missing")
    }

    pub fn epoch_data(env: Env, epoch_id: u32) -> EpochData {
        load_epoch(&env, epoch_id)
    }

    pub fn epoch_status(env: Env, epoch_id: u32) -> EpochStatus {
        load_epoch(&env, epoch_id).status
    }

    pub fn request_epoch(env: Env, request_id: u64) -> u32 {
        request_epoch_id(&env, request_id)
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
        inst_get(&env, &DataKey::ContractVersion, "version missing")
    }

    pub fn admin(env: Env) -> Address {
        inst_get(&env, &DataKey::Admin, "admin missing")
    }

    pub fn timeout_rounds(_env: Env) -> u64 {
        TIMEOUT_ROUNDS
    }

    pub fn expiry_rounds(_env: Env) -> u64 {
        EXPIRY_ROUNDS
    }

    pub fn request_round(env: Env, request_id: u64) -> u64 {
        let round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        bump_persistent(&env, &DataKey::RequestRound(request_id));
        round
    }

    pub fn requester_of(env: Env, request_id: u64) -> Address {
        let requester = load_requester(&env, request_id);
        bump_persistent(&env, &DataKey::Requester(request_id));
        requester
    }

    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        flag(&env, &DataKey::Fulfilled(request_id))
    }

    pub fn is_refunded(env: Env, request_id: u64) -> bool {
        flag(&env, &DataKey::Refunded(request_id))
    }

    /// The callback that is registered and **not yet delivered**, if any.
    pub fn callback_of(env: Env, request_id: u64) -> Option<(Address, Symbol)> {
        let cb: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::CallbackContract(request_id));
        cb.map(|addr| (addr, Symbol::new(&env, "on_vrf")))
    }

    pub fn get_context(env: Env, request_id: u64) -> Bytes {
        let context: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::RequestContext(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        bump_persistent(&env, &DataKey::RequestContext(request_id));
        context
    }

    pub fn get_proof(env: Env, request_id: u64) -> BlsVrfProof {
        let proof: BlsVrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"));
        bump_persistent(&env, &DataKey::Proof(request_id));
        proof
    }

    pub fn get_beta(env: Env, request_id: u64) -> BytesN<32> {
        read_beta(&env, request_id)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DERIVATION FUNCTIONS (unchanged from V1)
    // ─────────────────────────────────────────────────────────────────────────

    /// `sha256("VREP_DERIVE_V2" ‖ 0x01 ‖ request_id_be ‖ beta)[0..8]`.
    pub fn derive_random(env: Env, request_id: u64) -> u64 {
        let beta = read_beta(&env, request_id);
        let mut input = derive_prefix(&env, DERIVE_TAG_U64, request_id);
        input.append(&Bytes::from_slice(&env, &beta.to_array()));
        let hash_arr = env.crypto().sha256(&input).to_array();
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&hash_arr[0..8]);
        u64::from_be_bytes(buf)
    }

    /// Exactly uniform value in `[0, max)`. See [`reduce_uniform`].
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

    /// Like `derive_random_in_range` plus a domain separator. The domain MUST be
    /// fixed before fulfillment (a constant, or a value committed before
    /// `request()`), otherwise whoever picks it can grind over the output.
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

    /// Remove the bulky proof and the context of a fulfilled request. Keeps
    /// `Fulfilled`, `Beta`, `Requester`, `RequestRound`, `RequestEpoch`.
    ///
    /// Callable by the requester or by the operator of the request's epoch, and
    /// only after any registered callback has been delivered (the callback needs
    /// the proof's alpha, and the operator must not be able to cancel delivery).
    pub fn cleanup_proof(env: Env, request_id: u64, caller: Address) {
        caller.require_auth();

        if !flag(&env, &DataKey::Fulfilled(request_id)) {
            panic!("request not yet fulfilled");
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackContract(request_id))
        {
            panic!("callback not yet delivered");
        }

        let requester = load_requester(&env, request_id);
        let operator = load_epoch(&env, request_epoch_id(&env, request_id)).oracle_address;
        if caller != requester && caller != operator {
            panic!("only requester or oracle can cleanup");
        }

        remove_if_exists(&env, &DataKey::Proof(request_id));
        remove_if_exists(&env, &DataKey::RequestContext(request_id));
        bump_persistent(&env, &DataKey::Fulfilled(request_id));

        env.events()
            .publish((symbol_short!("cleanup"),), request_id);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

fn inst_get<V>(env: &Env, key: &DataKey, msg: &str) -> V
where
    V: soroban_sdk::TryFromVal<Env, Val>,
    V::Error: core::fmt::Debug,
{
    env.storage()
        .instance()
        .get(key)
        .unwrap_or_else(|| panic!("{}", msg))
}

/// A boolean marker that is only ever stored as `true`. Absent means false.
fn flag(env: &Env, key: &DataKey) -> bool {
    env.storage().persistent().get(key).unwrap_or(false)
}

fn require_admin(env: &Env, admin: &Address) {
    let stored_admin: Address = inst_get(env, &DataKey::Admin, "admin missing");
    if *admin != stored_admin {
        panic!("unauthorized: not admin");
    }
    admin.require_auth();
}

/// Load an epoch and keep its entry alive. Epochs are read on every request and
/// fulfillment; writing an entry does not extend its TTL on Soroban, so the
/// extension must be explicit.
fn load_epoch(env: &Env, epoch_id: u32) -> EpochData {
    let epoch: EpochData = env
        .storage()
        .persistent()
        .get(&DataKey::Epoch(epoch_id))
        .unwrap_or_else(|| panic!("epoch not found"));
    bump_persistent(env, &DataKey::Epoch(epoch_id));
    epoch
}

fn load_active_epoch(env: &Env) -> (u32, EpochData) {
    let active_id: u32 = inst_get(env, &DataKey::ActiveEpochId, "active epoch missing");
    (active_id, load_epoch(env, active_id))
}

fn request_epoch_id(env: &Env, request_id: u64) -> u32 {
    let epoch_id: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::RequestEpoch(request_id))
        .unwrap_or_else(|| panic!("request not found"));
    bump_persistent(env, &DataKey::RequestEpoch(request_id));
    epoch_id
}

fn load_requester(env: &Env, request_id: u64) -> Address {
    env.storage()
        .persistent()
        .get(&DataKey::Requester(request_id))
        .unwrap_or_else(|| panic!("request not found"))
}

/// Panics unless the request is neither fulfilled nor refunded.
fn ensure_open(env: &Env, request_id: u64) {
    if flag(env, &DataKey::Fulfilled(request_id)) {
        panic!("already fulfilled");
    }
    if flag(env, &DataKey::Refunded(request_id)) {
        panic!("already refunded");
    }
}

fn refund_internal(env: &Env, request_id: u64, requester: &Address) {
    env.storage()
        .persistent()
        .set(&DataKey::Refunded(request_id), &true);
    bump_persistent(env, &DataKey::Refunded(request_id));
    remove_if_exists(env, &DataKey::RequestContext(request_id));
    remove_if_exists(env, &DataKey::CallbackContract(request_id));
    bump_instance(env);
    transfer_fee(env, &env.current_contract_address(), requester);
}

/// Move the per-request fee. The fee token is set at construction (expected to
/// be a Stellar Asset Contract) and the amount is immutable, so the escrowed
/// amount is always exactly `FeeAmount`.
fn transfer_fee(env: &Env, from: &Address, to: &Address) {
    let fee_amount: i128 = inst_get(env, &DataKey::FeeAmount, "fee amount missing");
    if fee_amount <= 0 {
        return;
    }
    let fee_token: Address = inst_get(env, &DataKey::FeeToken, "fee token missing");
    let mut args = Vec::<Val>::new(env);
    args.push_back(from.into_val(env));
    args.push_back(to.into_val(env));
    args.push_back(fee_amount.into_val(env));
    env.invoke_contract::<Val>(&fee_token, &Symbol::new(env, "transfer"), args);
}

fn remove_if_exists(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage().persistent().remove(key);
    }
}

fn current_round(env: &Env) -> u64 {
    let genesis: u64 = inst_get(env, &DataKey::DrandGenesis, "genesis missing");
    let period: u32 = inst_get(env, &DataKey::DrandPeriod, "period missing");
    compute_current_round(env.ledger().timestamp(), genesis, period)
}

/// drand's own numbering: round 1 at genesis, `floor((now - genesis) / period) + 1`.
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

/// `e(sig, G2) == e(h, pk)`, evaluated as one pairing product.
fn pairing_eq(env: &Env, sig: Bls12381G1Affine, h: Bls12381G1Affine, pk: Bls12381G2Affine) -> bool {
    let mut g1 = Vec::<Bls12381G1Affine>::new(env);
    g1.push_back(sig);
    g1.push_back(-h);
    let mut g2 = Vec::<Bls12381G2Affine>::new(env);
    g2.push_back(g2_generator(env));
    g2.push_back(pk);
    env.crypto().bls12_381().pairing_check(g1, g2)
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

/// Message signed for the BLS proof of possession of a new epoch key:
/// `POP_DOMAIN ‖ xdr(ScVal::Address(this contract)) ‖ new_epoch_id_be ‖ new_pk`.
/// Binding the contract and the key makes a PoP unusable on any other contract
/// (for example testnet → mainnet) or for any other key.
pub fn pop_message(env: &Env, new_epoch_id: u32, new_pk: &BytesN<192>) -> Bytes {
    let mut msg = Bytes::from_slice(env, POP_DOMAIN);
    msg.append(&env.current_contract_address().to_xdr(env));
    msg.append(&u32_be_bytes(env, new_epoch_id));
    msg.append(&Bytes::from_slice(env, &new_pk.to_array()));
    msg
}

fn read_beta(env: &Env, request_id: u64) -> BytesN<32> {
    if !flag(env, &DataKey::Fulfilled(request_id)) {
        panic!("request not yet fulfilled");
    }
    let beta: BytesN<32> = env
        .storage()
        .persistent()
        .get(&DataKey::Beta(request_id))
        .unwrap_or_else(|| panic!("beta missing"));
    bump_persistent(env, &DataKey::Beta(request_id));
    bump_persistent(env, &DataKey::Fulfilled(request_id));
    beta
}

fn derive_prefix(env: &Env, tag: u8, request_id: u64) -> Bytes {
    let mut input = Bytes::from_slice(env, DERIVE_DOMAIN);
    input.push_back(tag);
    input.append(&u64_be_bytes(env, request_id));
    input
}

/// Exact-uniform reduction of a 32-byte hash into `[0, max)` by rejection
/// sampling over its two 128-bit halves. Requires `max >= 2`.
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

/// `alpha = sha256(request_id_be ‖ context ‖ round_be ‖ sha256(drand_sig) ‖ epoch_id_be)`.
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
    let drand_randomness = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &drand_signature.to_array()));
    input.append(&Bytes::from_slice(env, &drand_randomness.to_array()));
    input.append(&u32_be_bytes(env, epoch_id));
    env.crypto().sha256(&input).into()
}

fn derive_beta_output(env: &Env, gamma_point: &BytesN<96>) -> BytesN<32> {
    let mut beta_input = Bytes::from_slice(env, BETA_DOMAIN);
    beta_input.append(&Bytes::from_slice(env, &gamma_point.to_array()));
    env.crypto().sha256(&beta_input).into()
}

/// BLS-VRF check `e(gamma, G2) == e(H(alpha), pk)`.
fn verify_bls_vrf_proof(env: &Env, proof: &BlsVrfProof, pk: &BytesN<192>) -> bool {
    let h = env.crypto().bls12_381().hash_to_g1(
        &Bytes::from_slice(env, &proof.alpha_seed.to_array()),
        &Bytes::from_slice(env, VRF_DST),
    );
    pairing_eq(
        env,
        Bls12381G1Affine::from_bytes(proof.gamma_point.clone()),
        h,
        Bls12381G2Affine::from_bytes(pk.clone()),
    )
}

/// drand quicknet (unchained, G1 signatures): `e(sig, G2) == e(H(sha256(round_be)), drand_pk)`.
fn verify_drand_signature(env: &Env, proof: &BlsVrfProof, drand_pk: &BytesN<192>) -> bool {
    let round_hash = env.crypto().sha256(&u64_be_bytes(env, proof.drand_round));
    let h_msg = env.crypto().bls12_381().hash_to_g1(
        &Bytes::from_slice(env, &round_hash.to_array()),
        &Bytes::from_slice(env, DRAND_DST),
    );
    pairing_eq(
        env,
        Bls12381G1Affine::from_bytes(proof.drand_signature.clone()),
        h_msg,
        Bls12381G2Affine::from_bytes(drand_pk.clone()),
    )
}

fn request_internal(env: &Env, context: Bytes, requester: Address, with_callback: bool) -> u64 {
    requester.require_auth();

    if context.len() > MAX_CONTEXT_LEN {
        panic!("context exceeds maximum length");
    }

    let pending_upgrade: Option<PendingUpgrade> = env
        .storage()
        .instance()
        .get(&DataKey::PendingUpg)
        .unwrap_or(None);
    if pending_upgrade.is_some() {
        panic!("requests paused: upgrade pending");
    }

    let (epoch_id, epoch) = load_active_epoch(env);
    if epoch.status != EpochStatus::Active {
        panic!("active epoch not accepting requests");
    }

    transfer_fee(env, &requester, &env.current_contract_address());

    let counter: u64 = inst_get(env, &DataKey::Counter, "counter missing");
    let id = counter
        .checked_add(1)
        .unwrap_or_else(|| panic!("counter overflow"));
    env.storage().instance().set(&DataKey::Counter, &id);

    let offset: u32 = inst_get(env, &DataKey::RoundOffset, "round offset missing");
    let required_round = current_round(env).saturating_add(offset as u64);

    let ps = env.storage().persistent();
    ps.set(&DataKey::RequestEpoch(id), &epoch_id);
    ps.set(&DataKey::RequestContext(id), &context);
    ps.set(&DataKey::Requester(id), &requester);
    ps.set(&DataKey::RequestRound(id), &required_round);
    bump_persistent(env, &DataKey::RequestEpoch(id));
    bump_persistent(env, &DataKey::RequestContext(id));
    bump_persistent(env, &DataKey::Requester(id));
    bump_persistent(env, &DataKey::RequestRound(id));
    if with_callback {
        ps.set(&DataKey::CallbackContract(id), &requester);
        bump_persistent(env, &DataKey::CallbackContract(id));
    }
    bump_instance(env);

    env.events().publish(
        (symbol_short!("request"),),
        (id, requester, epoch_id, required_round),
    );
    id
}
