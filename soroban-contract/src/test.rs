#![cfg(test)]
//! V2 test suite.
//!
//! Every success-path test uses **real** cryptography: a real drand quicknet
//! beacon (round 32 427 720) and oracle proofs produced with `@noble/curves`
//! (the library the worker uses). `test_noble_vector_matches_host_computation`
//! recomputes the same proof with the Soroban host, so worker and contract are
//! checked against each other byte for byte.
extern crate std;

use crate::testkeys::{TEST_G2_TIMES_2, TEST_G2_TIMES_3};
use crate::{
    BlsVrfProof, DataKey, EpochStatus, VRFOracleContract, VRFOracleContractClient,
    BLS12_381_G2_GENERATOR, EXPIRY_ROUNDS, MIN_ROTATION_TIMELOCK_LEDGERS,
    MIN_UPGRADE_TIMELOCK_LEDGERS, POP_BLS_DST, TIMEOUT_ROUNDS, VRF_DST,
};
use soroban_sdk::crypto::bls12_381::{Bls12381Fr, Bls12381G2Affine};
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val};

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURE
// ═══════════════════════════════════════════════════════════════════════════════

const GENESIS: u64 = 1_692_803_367;
const PERIOD: u32 = 3;
const OFFSET: u32 = 4;
const ROUND: u64 = 32_427_720;
const CONTEXT: &[u8] = b"Nonzero-fee Mainnet CPU Profiling 2026";
const FEE: i128 = 2_000_000;

struct T {
    env: Env,
    client: VRFOracleContractClient<'static>,
    admin: Address,
    operator: Address,
    token: Address,
}

/// Ledger timestamp at which a new request is bound to `ROUND`.
fn request_ts() -> u64 {
    GENESIS + (ROUND - OFFSET as u64 - 1) * PERIOD as u64
}

/// Timestamp at which drand round `round` is current.
fn ts_of_round(round: u64) -> u64 {
    GENESIS + (round - 1) * PERIOD as u64
}

fn setup_with_fee(fee: i128) -> T {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(request_ts());
    env.ledger().set_sequence_number(1_000);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();

    let id = env.register(
        VRFOracleContract,
        (
            &admin,
            &BytesN::from_array(&env, &E1_PK),
            &operator,
            &BytesN::from_array(&env, &FIX_DRAND_PK),
            &GENESIS,
            &PERIOD,
            &OFFSET,
            &token,
            &fee,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
    let client = VRFOracleContractClient::new(&env, &id);
    T {
        env,
        client,
        admin,
        operator,
        token,
    }
}

fn setup() -> T {
    setup_with_fee(0)
}

fn funded_requester(t: &T) -> Address {
    let r = Address::generate(&t.env);
    StellarAssetClient::new(&t.env, &t.token).mint(&r, &(FEE * 10));
    r
}

fn balance(t: &T, who: &Address) -> i128 {
    TokenClient::new(&t.env, &t.token).balance(who)
}

fn ctx(env: &Env) -> Bytes {
    Bytes::from_slice(env, CONTEXT)
}

fn proof(env: &Env, alpha: &[u8; 32], gamma: &[u8; 96], beta: &[u8; 32]) -> BlsVrfProof {
    BlsVrfProof {
        alpha_seed: BytesN::from_array(env, alpha),
        gamma_point: BytesN::from_array(env, gamma),
        beta_output: BytesN::from_array(env, beta),
        drand_round: ROUND,
        drand_signature: BytesN::from_array(env, &FIX_DRAND_SIG),
    }
}

/// Valid proof for request #1 in epoch 1.
fn e1_proof(env: &Env) -> BlsVrfProof {
    proof(env, &E1_ALPHA, &E1_GAMMA, &E1_BETA)
}

/// Valid proof for request #2 in epoch 2.
fn e2_proof(env: &Env) -> BlsVrfProof {
    proof(env, &E2_ALPHA, &E2_GAMMA, &E2_BETA)
}

fn fr(env: &Env, sk: &[u8; 32]) -> Bls12381Fr {
    Bls12381Fr::from_bytes(BytesN::from_array(env, sk))
}

/// Proof of possession for `pk` as epoch `epoch_id` of `t`'s contract.
fn pop(t: &T, epoch_id: u32, sk: &[u8; 32], pk: &[u8; 192]) -> BytesN<96> {
    pop_for(&t.env, &t.client.address, epoch_id, sk, pk)
}

fn pop_for(
    env: &Env,
    contract: &Address,
    epoch_id: u32,
    sk: &[u8; 32],
    pk: &[u8; 192],
) -> BytesN<96> {
    let pk = BytesN::from_array(env, pk);
    let msg = env.as_contract(contract, || crate::pop_message(env, epoch_id, &pk));
    let bls = env.crypto().bls12_381();
    let h = bls.hash_to_g1(&msg, &Bytes::from_slice(env, POP_BLS_DST));
    bls.g1_mul(&h, &fr(env, sk)).to_bytes()
}

/// Propose + wait + execute a rotation to epoch 2 with the E2 key.
fn rotate_to_e2(t: &T) -> Address {
    let op2 = Address::generate(&t.env);
    let sig = pop(t, 2, &E2_SK, &E2_PK);
    t.client
        .propose_key_rotation(&t.admin, &BytesN::from_array(&t.env, &E2_PK), &op2, &sig);
    advance_ledgers(&t.env, MIN_ROTATION_TIMELOCK_LEDGERS);
    t.client.execute_key_rotation(&t.admin);
    op2
}

fn advance_ledgers(env: &Env, n: u32) {
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + n);
}

/// Data of the last event emitted by the VRF contract.
fn last_event_data(t: &T) -> Val {
    let evs = t.env.events().all().filter_by_contract(&t.client.address);
    let e = evs.events().last().expect("no event").clone();
    let soroban_sdk::xdr::ContractEventBody::V0(body) = e.body;
    Val::try_from_val(&t.env, &body.data).unwrap()
}

fn seed_beta(t: &T, id: u64, beta: [u8; 32]) {
    t.env.as_contract(&t.client.address, || {
        let ps = t.env.storage().persistent();
        ps.set(&DataKey::Fulfilled(id), &true);
        ps.set(&DataKey::Beta(id), &BytesN::from_array(&t.env, &beta));
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CONSUMERS
// ═══════════════════════════════════════════════════════════════════════════════

mod good_consumer {
    use soroban_sdk::{contract, contractimpl, BytesN, Env};

    #[contract]
    pub struct GoodConsumer;

    #[contractimpl]
    impl GoodConsumer {
        pub fn on_vrf(env: Env, request_id: u64, beta: BytesN<32>, _alpha: BytesN<32>) {
            env.storage().instance().set(&request_id, &beta);
        }
        pub fn got(env: Env, request_id: u64) -> Option<BytesN<32>> {
            env.storage().instance().get(&request_id)
        }
    }
}

mod bad_consumer {
    use soroban_sdk::{contract, contractimpl, BytesN, Env};

    #[contract]
    pub struct PanicConsumer;

    #[contractimpl]
    impl PanicConsumer {
        pub fn on_vrf(_env: Env, _request_id: u64, _beta: BytesN<32>, _alpha: BytesN<32>) {
            panic!("consumer failure");
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRYPTO CROSS-CHECK
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_noble_vector_matches_host_computation() {
    let env = Env::default();
    let bls = env.crypto().bls12_381();
    let g2 = Bls12381G2Affine::from_bytes(BytesN::from_array(&env, &BLS12_381_G2_GENERATOR));
    for (sk, pk, alpha, gamma) in [
        (&E1_SK, &E1_PK, &E1_ALPHA, &E1_GAMMA),
        (&E2_SK, &E2_PK, &E2_ALPHA, &E2_GAMMA),
    ] {
        assert_eq!(bls.g2_mul(&g2, &fr(&env, sk)).to_bytes().to_array(), *pk);
        let h = bls.hash_to_g1(
            &Bytes::from_slice(&env, alpha),
            &Bytes::from_slice(&env, VRF_DST),
        );
        assert_eq!(bls.g1_mul(&h, &fr(&env, sk)).to_bytes().to_array(), *gamma);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTRUCTOR
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_init_getters() {
    let t = setup_with_fee(FEE);
    assert_eq!(t.client.admin(), t.admin);
    assert_eq!(t.client.oracle_address(), t.operator);
    assert_eq!(t.client.oracle_pk(), BytesN::from_array(&t.env, &E1_PK));
    assert_eq!(
        t.client.drand_pk(),
        BytesN::from_array(&t.env, &FIX_DRAND_PK)
    );
    assert_eq!(t.client.drand_genesis_time(), GENESIS);
    assert_eq!(t.client.drand_period(), PERIOD);
    assert_eq!(t.client.round_offset(), OFFSET);
    assert_eq!(t.client.fee(), (t.token.clone(), FEE));
    assert_eq!(t.client.current_epoch_id(), 1);
    assert_eq!(t.client.epoch_status(&1), EpochStatus::Active);
    assert_eq!(t.client.contract_version(), 2);
    assert_eq!(t.client.timeout_rounds(), TIMEOUT_ROUNDS);
    assert_eq!(t.client.expiry_rounds(), EXPIRY_ROUNDS);
    assert!(t.client.pending_rotation().is_none());
    assert!(t.client.pending_upgrade().is_none());
}

fn try_construct(
    admin_is_operator: bool,
    oracle_pk: [u8; 192],
    drand_pk: [u8; 192],
    offset: u32,
    rot: u32,
    upg: u32,
) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let operator = if admin_is_operator {
        admin.clone()
    } else {
        Address::generate(&env)
    };
    env.register(
        VRFOracleContract,
        (
            &admin,
            &BytesN::from_array(&env, &oracle_pk),
            &operator,
            &BytesN::from_array(&env, &drand_pk),
            &GENESIS,
            &PERIOD,
            &offset,
            &Address::generate(&env),
            &0i128,
            &rot,
            &upg,
        ),
    );
}

const ROT: u32 = MIN_ROTATION_TIMELOCK_LEDGERS;
const UPG: u32 = MIN_UPGRADE_TIMELOCK_LEDGERS;

#[test]
#[should_panic(expected = "admin must differ from oracle operator")]
fn test_init_rejects_admin_eq_operator() {
    try_construct(true, E1_PK, FIX_DRAND_PK, OFFSET, ROT, UPG);
}

#[test]
#[should_panic(expected = "round_offset below minimum")]
fn test_init_rejects_low_round_offset() {
    try_construct(false, E1_PK, FIX_DRAND_PK, 3, ROT, UPG);
}

#[test]
#[should_panic(expected = "rotation timelock below minimum")]
fn test_init_rejects_low_rotation_timelock() {
    try_construct(false, E1_PK, FIX_DRAND_PK, OFFSET, ROT - 1, UPG);
}

#[test]
#[should_panic(expected = "upgrade timelock below minimum")]
fn test_init_rejects_low_upgrade_timelock() {
    try_construct(false, E1_PK, FIX_DRAND_PK, OFFSET, ROT, UPG - 1);
}

#[test]
#[should_panic(expected = "oracle pk must differ from drand pk")]
fn test_init_rejects_identical_keys() {
    try_construct(false, TEST_G2_TIMES_2, TEST_G2_TIMES_2, OFFSET, ROT, UPG);
}

#[test]
#[should_panic(expected = "oracle pk must not be the G2 generator")]
fn test_init_rejects_generator_key() {
    try_construct(
        false,
        BLS12_381_G2_GENERATOR,
        FIX_DRAND_PK,
        OFFSET,
        ROT,
        UPG,
    );
}

#[test]
#[should_panic(expected = "drand pk is the point at infinity")]
fn test_init_rejects_infinity_drand_key() {
    let mut inf = [0u8; 192];
    inf[0] = 0x40;
    try_construct(false, E1_PK, inf, OFFSET, ROT, UPG);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_request_binds_round_epoch_and_escrows_fee() {
    let t = setup_with_fee(FEE);
    let r = funded_requester(&t);
    let before = balance(&t, &r);
    let id = t.client.request(&ctx(&t.env), &r);
    assert_eq!(id, 1);
    assert_eq!(t.client.request_round(&id), ROUND);
    assert_eq!(t.client.request_epoch(&id), 1);
    assert_eq!(t.client.requester_of(&id), r);
    assert_eq!(t.client.get_context(&id), ctx(&t.env));
    assert!(!t.client.is_fulfilled(&id));
    assert!(!t.client.is_refunded(&id));
    assert!(t.client.callback_of(&id).is_none());
    assert_eq!(balance(&t, &r), before - FEE);
    assert_eq!(balance(&t, &t.client.address), FEE);
    assert_eq!(t.client.request(&ctx(&t.env), &r), 2);
}

#[test]
fn test_request_does_not_write_default_flags() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env.as_contract(&t.client.address, || {
        assert!(!t.env.storage().persistent().has(&DataKey::Fulfilled(id)));
        assert!(!t.env.storage().persistent().has(&DataKey::Refunded(id)));
    });
}

#[test]
fn test_request_event_carries_epoch_and_round() {
    let t = setup();
    let r = Address::generate(&t.env);
    let id = t.client.request(&ctx(&t.env), &r);
    let data = last_event_data(&t);
    let (eid, who, epoch, round): (u64, Address, u32, u64) =
        <(u64, Address, u32, u64)>::try_from_val(&t.env, &data).unwrap();
    assert_eq!((eid, who, epoch, round), (id, r, 1, ROUND));
}

#[test]
#[should_panic(expected = "context exceeds maximum length")]
fn test_request_oversized_context_rejected() {
    let t = setup();
    let big = Bytes::from_slice(&t.env, &[0u8; 1025]);
    t.client.request(&big, &Address::generate(&t.env));
}

#[test]
#[should_panic(expected = "callback_contract must be the requester")]
fn test_request_with_callback_requester_mismatch_rejected() {
    let t = setup();
    t.client.request_with_callback(
        &ctx(&t.env),
        &Address::generate(&t.env),
        &Address::generate(&t.env),
        &Symbol::new(&t.env, "on_vrf"),
    );
}

#[test]
#[should_panic(expected = "callback_fn must be 'on_vrf'")]
fn test_request_with_callback_wrong_fn_rejected() {
    let t = setup();
    let r = Address::generate(&t.env);
    t.client
        .request_with_callback(&ctx(&t.env), &r, &r, &Symbol::new(&t.env, "steal"));
}

#[test]
fn test_requests_paused_while_upgrade_pending() {
    let t = setup();
    let r = Address::generate(&t.env);
    t.client
        .propose_upgrade(&t.admin, &BytesN::from_array(&t.env, &[0xAA; 32]));
    assert!(t.client.try_request(&ctx(&t.env), &r).is_err());
    t.client.cancel_upgrade(&t.admin);
    assert_eq!(t.client.request(&ctx(&t.env), &r), 1);
}

#[test]
#[should_panic(expected = "active epoch not accepting requests")]
fn test_revoked_active_epoch_blocks_requests() {
    let t = setup();
    t.client.revoke_epoch(&t.admin, &1);
    t.client.request(&ctx(&t.env), &Address::generate(&t.env));
}

#[test]
fn test_epoch_ttl_is_extended_by_requests() {
    let t = setup();
    let r = Address::generate(&t.env);
    let ttl = |t: &T| {
        t.env.as_contract(&t.client.address, || {
            t.env.storage().persistent().get_ttl(&DataKey::Epoch(1))
        })
    };
    // Let the epoch entry age past the extension threshold, then request.
    advance_ledgers(&t.env, 518_400 - 17_000);
    let aged = ttl(&t);
    assert!(aged < 17_280, "precondition: entry is below the threshold");
    t.client.request(&ctx(&t.env), &r);
    assert!(ttl(&t) >= 518_400 - 1, "request must extend the epoch TTL");
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULFILL
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_fulfill_real_proof_succeeds_and_pays_operator() {
    let t = setup_with_fee(FEE);
    let r = funded_requester(&t);
    let id = t.client.request(&ctx(&t.env), &r);
    t.client.fulfill(&id, &e1_proof(&t.env));

    // Events are those of the last invocation: check them first.
    let data = last_event_data(&t);
    let (eid, beta, epoch): (u64, BytesN<32>, u32) =
        <(u64, BytesN<32>, u32)>::try_from_val(&t.env, &data).unwrap();
    assert_eq!((eid, epoch), (id, 1));
    assert_eq!(beta, BytesN::from_array(&t.env, &E1_BETA));

    assert!(t.client.is_fulfilled(&id));
    assert_eq!(t.client.get_beta(&id), BytesN::from_array(&t.env, &E1_BETA));
    assert_eq!(t.client.get_proof(&id), e1_proof(&t.env));
    assert_eq!(balance(&t, &t.operator), FEE);
    assert_eq!(balance(&t, &t.client.address), 0);
}

#[test]
fn test_fulfill_requires_operator_auth() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env.set_auths(&[]);
    assert!(t.client.try_fulfill(&id, &e1_proof(&t.env)).is_err());
    assert!(!t.client.is_fulfilled(&id));
}

#[test]
fn test_fulfill_records_operator_auth() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
    let auths = t.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.operator);
}

#[test]
#[should_panic(expected = "already fulfilled")]
fn test_fulfill_duplicate_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
}

#[test]
#[should_panic(expected = "request not found")]
fn test_fulfill_unknown_request_rejected() {
    let t = setup();
    t.client.fulfill(&9, &e1_proof(&t.env));
}

#[test]
#[should_panic(expected = "drand round mismatch")]
fn test_fulfill_wrong_round_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    let mut p = e1_proof(&t.env);
    p.drand_round = ROUND + 1;
    t.client.fulfill(&id, &p);
}

#[test]
#[should_panic(expected = "drand signature verification failed")]
fn test_fulfill_forged_drand_signature_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    let mut p = e1_proof(&t.env);
    // A valid G1 point that is not drand's signature (the alpha-derived gamma).
    p.drand_signature = BytesN::from_array(&t.env, &E2_GAMMA);
    t.client.fulfill(&id, &p);
}

#[test]
#[should_panic(expected = "alpha seed mismatch")]
fn test_fulfill_tampered_alpha_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    let mut a = E1_ALPHA;
    a[0] ^= 1;
    t.client
        .fulfill(&id, &proof(&t.env, &a, &E1_GAMMA, &E1_BETA));
}

#[test]
#[should_panic(expected = "alpha seed mismatch")]
fn test_fulfill_other_request_proof_rejected() {
    // A valid proof for request #1 cannot be replayed on request #2.
    let t = setup();
    let r = Address::generate(&t.env);
    t.client.request(&ctx(&t.env), &r);
    let id2 = t.client.request(&ctx(&t.env), &r);
    t.client.fulfill(&id2, &e1_proof(&t.env));
}

#[test]
#[should_panic(expected = "bls vrf verification failed")]
fn test_fulfill_gamma_from_wrong_key_rejected() {
    // Correct alpha, but gamma computed with the epoch-2 key.
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    let env = &t.env;
    let bls = env.crypto().bls12_381();
    let h = bls.hash_to_g1(
        &Bytes::from_slice(env, &E1_ALPHA),
        &Bytes::from_slice(env, VRF_DST),
    );
    let wrong_gamma = bls.g1_mul(&h, &fr(env, &E2_SK)).to_bytes().to_array();
    t.client
        .fulfill(&id, &proof(env, &E1_ALPHA, &wrong_gamma, &E1_BETA));
}

#[test]
#[should_panic(expected = "beta output mismatch")]
fn test_fulfill_tampered_beta_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    let mut b = E1_BETA;
    b[31] ^= 1;
    t.client
        .fulfill(&id, &proof(&t.env, &E1_ALPHA, &E1_GAMMA, &b));
}

#[test]
#[should_panic(expected = "epoch revoked")]
fn test_fulfill_revoked_epoch_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.revoke_epoch(&t.admin, &1);
    t.client.fulfill(&id, &e1_proof(&t.env));
}

#[test]
#[should_panic(expected = "request refunded")]
fn test_fulfill_after_refund_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    t.client.timeout_refund(&id);
    t.client.fulfill(&id, &e1_proof(&t.env));
}

// ── Fulfillment window (audit finding H-1) ──────────────────────────────────

#[test]
fn test_fulfill_and_refund_windows_are_disjoint() {
    // At every ledger time exactly one of fulfill / requester-refund can
    // succeed. Otherwise a requester could watch a late fulfill transaction
    // and refund first whenever it dislikes the output.
    let t = setup();
    let r = Address::generate(&t.env);
    let id = t.client.request(&ctx(&t.env), &r);

    // Last round of the fulfillment window: refund is rejected, fulfill works.
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS));
    assert!(t.client.try_timeout_refund(&id).is_err());
    t.client.fulfill(&id, &e1_proof(&t.env));
    assert!(t.client.is_fulfilled(&id));
}

#[test]
#[should_panic(expected = "fulfillment window closed")]
fn test_fulfill_after_window_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    t.client.fulfill(&id, &e1_proof(&t.env));
}

#[test]
fn test_late_valid_proof_cannot_beat_refund() {
    // One round after the window: the (valid) proof is rejected and the
    // refund goes through. No ordering of the two transactions lets the
    // requester pick between "accept this output" and "refund".
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    assert!(t.client.try_fulfill(&id, &e1_proof(&t.env)).is_err());
    t.client.timeout_refund(&id);
    assert!(t.client.is_refunded(&id));
    assert!(!t.client.is_fulfilled(&id));
}

// ── Alpha is bound to the contract (audit finding L-1) ──────────────────────

#[test]
#[should_panic(expected = "alpha seed mismatch")]
fn test_proof_for_another_deployment_rejected() {
    // Same oracle key, same drand key, same request id / context / round /
    // epoch, but a different contract instance: the proof must not carry over.
    let t = setup();
    let other = t.env.register(
        VRFOracleContract,
        (
            &t.admin,
            &BytesN::from_array(&t.env, &E1_PK),
            &t.operator,
            &BytesN::from_array(&t.env, &FIX_DRAND_PK),
            &GENESIS,
            &PERIOD,
            &OFFSET,
            &t.token,
            &0i128,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
    let other = VRFOracleContractClient::new(&t.env, &other);
    let id = other.request(&ctx(&t.env), &Address::generate(&t.env));
    assert_eq!(id, 1);
    assert_eq!(other.request_round(&id), ROUND);
    other.fulfill(&id, &e1_proof(&t.env));
}

// ── Role separation survives an admin transfer (audit finding L-2) ──────────

#[test]
fn test_rotation_cannot_make_operator_equal_admin_after_admin_transfer() {
    let t = setup();
    let x = Address::generate(&t.env);
    // Rotation to operator X is proposed while X is not the admin...
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    t.client
        .propose_key_rotation(&t.admin, &BytesN::from_array(&t.env, &E2_PK), &x, &sig);
    // ...then the admin role is transferred to X...
    t.client.propose_admin_transfer(&t.admin, &x);
    advance_ledgers(&t.env, MIN_UPGRADE_TIMELOCK_LEDGERS);
    t.client.execute_admin_transfer(&t.admin);
    assert_eq!(t.client.admin(), x);
    // ...so executing the rotation would make admin == operator. Refused.
    assert!(t.client.try_execute_key_rotation(&x).is_err());
    assert_eq!(t.client.current_epoch_id(), 1);
}

#[test]
fn test_fulfill_core_budget() {
    let t = setup_with_fee(FEE);
    let id = t.client.request(&ctx(&t.env), &funded_requester(&t));
    t.env.cost_estimate().budget().reset_unlimited();
    t.client.fulfill(&id, &e1_proof(&t.env));
    let cpu = t.env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("fulfill CPU instructions (with fee transfer): {}", cpu);
    assert!(cpu < 75_000_000, "fulfill used {} CPU instructions", cpu);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALLBACK DELIVERY
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_fulfill_does_not_run_callback_and_deliver_does() {
    let t = setup();
    let consumer = t.env.register(good_consumer::GoodConsumer, ());
    let cc = good_consumer::GoodConsumerClient::new(&t.env, &consumer);
    let id = t.client.request_with_callback(
        &ctx(&t.env),
        &consumer,
        &consumer,
        &Symbol::new(&t.env, "on_vrf"),
    );
    assert!(t.client.callback_of(&id).is_some());

    t.client.fulfill(&id, &e1_proof(&t.env));
    assert!(cc.got(&id).is_none(), "fulfill must not run consumer code");
    assert!(t.client.callback_of(&id).is_some());

    t.client.deliver(&id);
    assert_eq!(cc.got(&id), Some(BytesN::from_array(&t.env, &E1_BETA)));
    assert!(t.client.callback_of(&id).is_none());
    assert!(t.client.try_deliver(&id).is_err(), "delivered only once");
}

#[test]
fn test_failing_callback_cannot_undo_result_and_stays_retryable() {
    let t = setup();
    let consumer = t.env.register(bad_consumer::PanicConsumer, ());
    let id = t.client.request_with_callback(
        &ctx(&t.env),
        &consumer,
        &consumer,
        &Symbol::new(&t.env, "on_vrf"),
    );
    t.client.fulfill(&id, &e1_proof(&t.env));
    assert!(t.client.try_deliver(&id).is_err());
    assert!(t.client.is_fulfilled(&id));
    assert_eq!(t.client.get_beta(&id), BytesN::from_array(&t.env, &E1_BETA));
    assert!(t.client.callback_of(&id).is_some(), "still pending");
    // The request is final: it can no longer be refunded.
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + EXPIRY_ROUNDS + 1));
    assert!(t.client.try_timeout_refund(&id).is_err());
}

#[test]
#[should_panic(expected = "request not yet fulfilled")]
fn test_deliver_before_fulfill_rejected() {
    let t = setup();
    let consumer = t.env.register(good_consumer::GoodConsumer, ());
    let id = t.client.request_with_callback(
        &ctx(&t.env),
        &consumer,
        &consumer,
        &Symbol::new(&t.env, "on_vrf"),
    );
    t.client.deliver(&id);
}

#[test]
fn test_cleanup_waits_for_delivery_and_keeps_beta() {
    let t = setup();
    let consumer = t.env.register(good_consumer::GoodConsumer, ());
    let id = t.client.request_with_callback(
        &ctx(&t.env),
        &consumer,
        &consumer,
        &Symbol::new(&t.env, "on_vrf"),
    );
    t.client.fulfill(&id, &e1_proof(&t.env));
    // The operator cannot cancel delivery by cleaning up first.
    assert!(t.client.try_cleanup_proof(&id, &t.operator).is_err());
    t.client.deliver(&id);
    t.client.cleanup_proof(&id, &t.operator);
    assert!(t.client.try_get_proof(&id).is_err());
    assert!(t.client.is_fulfilled(&id));
    assert_eq!(t.client.get_beta(&id), BytesN::from_array(&t.env, &E1_BETA));
}

#[test]
#[should_panic(expected = "only requester or oracle can cleanup")]
fn test_cleanup_by_stranger_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
    t.client.cleanup_proof(&id, &Address::generate(&t.env));
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFUNDS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "timeout window not reached")]
fn test_timeout_refund_too_early() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS));
    t.client.timeout_refund(&id);
}

#[test]
fn test_timeout_refund_needs_requester_before_expiry() {
    let t = setup_with_fee(FEE);
    let r = funded_requester(&t);
    let before = balance(&t, &r);
    let id = t.client.request(&ctx(&t.env), &r);
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    t.client.timeout_refund(&id);
    assert!(t.env.auths().iter().any(|(a, _)| *a == r));
    assert!(t.client.is_refunded(&id));
    assert_eq!(balance(&t, &r), before);
}

#[test]
fn test_timeout_refund_permissionless_after_expiry() {
    let t = setup_with_fee(FEE);
    let r = funded_requester(&t);
    let before = balance(&t, &r);
    let id = t.client.request(&ctx(&t.env), &r);
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + EXPIRY_ROUNDS + 1));
    t.client.timeout_refund(&id);
    assert!(
        !t.env.auths().iter().any(|(a, _)| *a == r),
        "requester authorization not required after expiry"
    );
    assert_eq!(balance(&t, &r), before, "fee goes back to the requester");
}

#[test]
fn test_timeout_refund_before_expiry_fails_without_requester_auth() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    t.env.set_auths(&[]);
    assert!(t.client.try_timeout_refund(&id).is_err());
}

#[test]
#[should_panic(expected = "already refunded")]
fn test_timeout_refund_double_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    t.client.timeout_refund(&id);
    t.client.timeout_refund(&id);
}

#[test]
#[should_panic(expected = "already fulfilled")]
fn test_timeout_refund_after_fulfill_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
    t.env
        .ledger()
        .set_timestamp(ts_of_round(ROUND + TIMEOUT_ROUNDS + 1));
    t.client.timeout_refund(&id);
}

#[test]
fn test_emergency_refund_on_revoked_epoch() {
    let t = setup_with_fee(FEE);
    let r = funded_requester(&t);
    let before = balance(&t, &r);
    let id = t.client.request(&ctx(&t.env), &r);
    t.client.revoke_epoch(&t.admin, &1);
    t.client.emergency_refund(&id);
    assert!(t.client.is_refunded(&id));
    assert_eq!(balance(&t, &r), before);
    assert!(t.client.try_emergency_refund(&id).is_err());
}

#[test]
#[should_panic(expected = "emergency refund only for revoked epochs")]
fn test_emergency_refund_on_active_epoch_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.emergency_refund(&id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KEY ROTATION
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_rotation_keeps_pending_requests_on_their_epoch() {
    let t = setup();
    let r = Address::generate(&t.env);
    // Request #1 is bound to epoch 1 before the rotation.
    let id1 = t.client.request(&ctx(&t.env), &r);
    let op2 = rotate_to_e2(&t);
    assert_eq!(t.client.current_epoch_id(), 2);
    assert_eq!(t.client.epoch_status(&1), EpochStatus::Superseded);
    assert_eq!(t.client.oracle_address(), op2);

    // Request #2 is bound to epoch 2.
    let id2 = t.client.request(&ctx(&t.env), &r);
    assert_eq!(t.client.request_epoch(&id2), 2);

    // #1 is still verified against the epoch-1 key and paid by its operator...
    t.client.fulfill(&id1, &e1_proof(&t.env));
    assert_eq!(t.env.auths()[0].0, t.operator);
    // ...and #2 against the epoch-2 key.
    t.client.fulfill(&id2, &e2_proof(&t.env));
    assert_eq!(t.env.auths()[0].0, op2);
    assert_eq!(
        t.client.get_beta(&id2),
        BytesN::from_array(&t.env, &E2_BETA)
    );
}

#[test]
fn test_new_key_cannot_fulfill_old_epoch_request() {
    // The heart of the epoch design: rotating keys cannot change the output
    // of a request created before the rotation.
    let t = setup();
    let id1 = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    rotate_to_e2(&t);
    let env = &t.env;
    let bls = env.crypto().bls12_381();
    let h = bls.hash_to_g1(
        &Bytes::from_slice(env, &E1_ALPHA),
        &Bytes::from_slice(env, VRF_DST),
    );
    let gamma = bls.g1_mul(&h, &fr(env, &E2_SK)).to_bytes().to_array();
    let mut beta_in = Bytes::from_slice(env, b"VREP_BETA_V1");
    beta_in.append(&Bytes::from_slice(env, &gamma));
    let beta = env.crypto().sha256(&beta_in).to_array();
    assert!(t
        .client
        .try_fulfill(&id1, &proof(env, &E1_ALPHA, &gamma, &beta))
        .is_err());
}

#[test]
#[should_panic(expected = "rotation timelock not elapsed")]
fn test_rotation_before_timelock_rejected() {
    let t = setup();
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
    advance_ledgers(&t.env, MIN_ROTATION_TIMELOCK_LEDGERS - 1);
    t.client.execute_key_rotation(&t.admin);
}

#[test]
#[should_panic(expected = "BLS proof of possession failed")]
fn test_rotation_pop_for_other_epoch_rejected() {
    let t = setup();
    let sig = pop(&t, 3, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
}

#[test]
#[should_panic(expected = "BLS proof of possession failed")]
fn test_rotation_pop_from_other_contract_rejected() {
    let t = setup();
    // A second instance in the same environment.
    let other = t.env.register(
        VRFOracleContract,
        (
            &t.admin,
            &BytesN::from_array(&t.env, &E1_PK),
            &t.operator,
            &BytesN::from_array(&t.env, &FIX_DRAND_PK),
            &GENESIS,
            &PERIOD,
            &OFFSET,
            &t.token,
            &0i128,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
    assert_ne!(other, t.client.address);
    // Same epoch id, same key, but signed for the other instance.
    let sig = pop_for(&t.env, &other, 2, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
}

#[test]
#[should_panic(expected = "new operator must differ from admin")]
fn test_rotation_operator_eq_admin_rejected() {
    let t = setup();
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &t.admin,
        &sig,
    );
}

#[test]
#[should_panic(expected = "unauthorized: not admin")]
fn test_rotation_by_operator_rejected() {
    let t = setup();
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.operator,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
}

#[test]
#[should_panic(expected = "pending rotation already exists")]
fn test_concurrent_rotation_rejected() {
    let t = setup();
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    let pk = BytesN::from_array(&t.env, &E2_PK);
    t.client
        .propose_key_rotation(&t.admin, &pk, &Address::generate(&t.env), &sig);
    t.client
        .propose_key_rotation(&t.admin, &pk, &Address::generate(&t.env), &sig);
}

#[test]
fn test_cancel_rotation() {
    let t = setup();
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
    t.client.cancel_key_rotation(&t.admin);
    assert!(t.client.pending_rotation().is_none());
    assert_eq!(t.client.current_epoch_id(), 1);
}

#[test]
fn test_many_rotations_with_abandoned_requests() {
    // Regression: abandoned (never fulfilled, never refunded) requests must not
    // be able to block key rotation.
    let t = setup();
    let r = Address::generate(&t.env);
    let keys = [&TEST_G2_TIMES_2, &TEST_G2_TIMES_3, &E2_PK];
    let sks: [[u8; 32]; 3] = [
        {
            let mut s = [0u8; 32];
            s[31] = 2;
            s
        },
        {
            let mut s = [0u8; 32];
            s[31] = 3;
            s
        },
        E2_SK,
    ];
    for round in 0..6u32 {
        t.client.request(&ctx(&t.env), &r); // abandoned on purpose
        let epoch_id = round + 2;
        let i = (round as usize) % 3;
        let sig = pop(&t, epoch_id, &sks[i], keys[i]);
        t.client.propose_key_rotation(
            &t.admin,
            &BytesN::from_array(&t.env, keys[i]),
            &Address::generate(&t.env),
            &sig,
        );
        advance_ledgers(&t.env, MIN_ROTATION_TIMELOCK_LEDGERS);
        t.client.execute_key_rotation(&t.admin);
        assert_eq!(t.client.current_epoch_id(), epoch_id);
    }
}

#[test]
fn test_revocation_survives_rotation_and_cancels_pending() {
    let t = setup();
    let sig = pop(&t, 2, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
    t.client.revoke_epoch(&t.admin, &1);
    assert!(t.client.pending_rotation().is_none(), "source revoked");
    assert!(t.client.try_revoke_epoch(&t.admin, &1).is_err());

    // A fresh proposal (epoch 3) from the revoked epoch restores service.
    let sig = pop(&t, 3, &E2_SK, &E2_PK);
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &sig,
    );
    advance_ledgers(&t.env, MIN_ROTATION_TIMELOCK_LEDGERS);
    t.client.execute_key_rotation(&t.admin);
    assert_eq!(t.client.epoch_status(&1), EpochStatus::Revoked);
    assert_eq!(t.client.current_epoch_id(), 3);
    t.client.request(&ctx(&t.env), &Address::generate(&t.env));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPGRADE / ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "unauthorized: not admin")]
fn test_propose_upgrade_requires_admin() {
    let t = setup();
    t.client
        .propose_upgrade(&t.operator, &BytesN::from_array(&t.env, &[0xAA; 32]));
}

#[test]
#[should_panic(expected = "pending upgrade already exists")]
fn test_double_upgrade_proposal_rejected() {
    let t = setup();
    t.client
        .propose_upgrade(&t.admin, &BytesN::from_array(&t.env, &[0xAA; 32]));
    t.client
        .propose_upgrade(&t.admin, &BytesN::from_array(&t.env, &[0xBB; 32]));
}

#[test]
#[should_panic(expected = "upgrade timelock not elapsed")]
fn test_execute_upgrade_before_timelock_rejected() {
    let t = setup();
    t.client
        .propose_upgrade(&t.admin, &BytesN::from_array(&t.env, &[0xAA; 32]));
    advance_ledgers(&t.env, MIN_UPGRADE_TIMELOCK_LEDGERS - 1);
    t.client.execute_upgrade(&t.admin);
}

#[test]
fn test_admin_transfer_after_timelock() {
    let t = setup();
    let new_admin = Address::generate(&t.env);
    t.client.propose_admin_transfer(&t.admin, &new_admin);
    assert!(t.client.try_execute_admin_transfer(&t.admin).is_err());
    advance_ledgers(&t.env, MIN_UPGRADE_TIMELOCK_LEDGERS);
    t.client.execute_admin_transfer(&t.admin);
    assert_eq!(t.client.admin(), new_admin);
}

#[test]
#[should_panic(expected = "new admin must differ from operator")]
fn test_admin_transfer_to_operator_rejected() {
    let t = setup();
    t.client.propose_admin_transfer(&t.admin, &t.operator);
}

#[test]
fn test_cancel_admin_transfer() {
    let t = setup();
    t.client
        .propose_admin_transfer(&t.admin, &Address::generate(&t.env));
    t.client.cancel_admin_transfer(&t.admin);
    assert!(t.client.pending_admin_transfer().is_none());
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVATION (unchanged from V1; vectors shared with the SDKs)
// ═══════════════════════════════════════════════════════════════════════════════

pub(crate) const VEC_REQUEST_ID: u64 = 7;
pub(crate) const VEC_U64: u64 = 17_155_214_937_666_214_782;
pub(crate) const VEC_RANGE: [(u64, u64); 3] = [
    (6, 4),
    (1_000_000, 889_164),
    (u64::MAX, 11_798_261_183_955_500_607),
];
pub(crate) const VEC_DOMAIN_CARD1_1000: u64 = 595;

#[test]
fn test_derive_vectors_shared_with_sdks() {
    let t = setup();
    let r = Address::generate(&t.env);
    let mut id = 0;
    while id < VEC_REQUEST_ID {
        id = t.client.request(&Bytes::from_slice(&t.env, b"vec"), &r);
    }
    let mut beta = [0u8; 32];
    for (i, b) in beta.iter_mut().enumerate() {
        *b = i as u8;
    }
    seed_beta(&t, id, beta);
    assert_eq!(t.client.derive_random(&id), VEC_U64);
    for (max, want) in VEC_RANGE {
        assert_eq!(
            t.client.derive_random_in_range(&id, &max),
            want,
            "max={}",
            max
        );
    }
    let d = t
        .client
        .derive_range_for_domain(&id, &Bytes::from_slice(&t.env, b"card-1"), &1000u64);
    assert_eq!(d, VEC_DOMAIN_CARD1_1000);
}

#[test]
fn test_derive_from_real_fulfillment() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
    for max in [1u64, 2, 6, 1000, u64::MAX] {
        let v = t.client.derive_random_in_range(&id, &max);
        assert!(v < max);
        assert_eq!(v, t.client.derive_random_in_range(&id, &max));
    }
    let d1 =
        t.client
            .derive_range_for_domain(&id, &Bytes::from_slice(&t.env, b"card-1"), &u64::MAX);
    let d2 =
        t.client
            .derive_range_for_domain(&id, &Bytes::from_slice(&t.env, b"card-2"), &u64::MAX);
    assert_ne!(d1, d2);
}

#[test]
#[should_panic(expected = "request not yet fulfilled")]
fn test_derive_requires_fulfillment() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.derive_random(&id);
}

#[test]
#[should_panic(expected = "max must be > 0")]
fn test_derive_zero_max_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    seed_beta(&t, id, [1; 32]);
    t.client.derive_random_in_range(&id, &0);
}

#[test]
#[should_panic(expected = "domain exceeds maximum length")]
fn test_derive_long_domain_rejected() {
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    seed_beta(&t, id, [1; 32]);
    let domain = Bytes::from_slice(&t.env, &[0x41u8; crate::MAX_DERIVE_DOMAIN_LEN as usize + 1]);
    t.client.derive_range_for_domain(&id, &domain, &10);
}

#[test]
fn test_reduce_uniform_rejection_boundary() {
    // max = 2^64 - 1: rem = 2^128 mod max = 1, so only u128::MAX is rejected.
    let max = u64::MAX;
    let mut h = [0xffu8; 32];
    h[31] = 0x00; // second half != u128::MAX
    let v = crate::reduce_uniform(&h, max);
    let second = u128::from_be_bytes(h[16..32].try_into().unwrap());
    assert_eq!(v as u128, second % max as u128);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATED FIXTURES (see header)
// ═══════════════════════════════════════════════════════════════════════════════

const FIX_DRAND_PK: [u8; 192] = [
    0x03, 0xcf, 0x0f, 0x28, 0x96, 0xad, 0xee, 0x7e, 0xb8, 0xb5, 0xf0, 0x1f, 0xca, 0xd3, 0x91, 0x22,
    0x12, 0xc4, 0x37, 0xe0, 0x07, 0x3e, 0x91, 0x1f, 0xb9, 0x00, 0x22, 0xd3, 0xe7, 0x60, 0x18, 0x3c,
    0x8c, 0x4b, 0x45, 0x0b, 0x6a, 0x0a, 0x6c, 0x3a, 0xc6, 0xa5, 0x77, 0x6a, 0x2d, 0x10, 0x64, 0x51,
    0x0d, 0x1f, 0xec, 0x75, 0x8c, 0x92, 0x1c, 0xc2, 0x2b, 0x0e, 0x17, 0xe6, 0x3a, 0xaf, 0x4b, 0xcb,
    0x5e, 0xd6, 0x63, 0x04, 0xde, 0x9c, 0xf8, 0x09, 0xbd, 0x27, 0x4c, 0xa7, 0x3b, 0xab, 0x4a, 0xf5,
    0xa6, 0xe9, 0xc7, 0x6a, 0x4b, 0xc0, 0x9e, 0x76, 0xea, 0xe8, 0x99, 0x1e, 0xf5, 0xec, 0xe4, 0x5a,
    0x01, 0xa7, 0x14, 0xf2, 0xed, 0xb7, 0x41, 0x19, 0xa2, 0xf2, 0xb0, 0xd5, 0xa7, 0xc7, 0x5b, 0xa9,
    0x02, 0xd1, 0x63, 0x70, 0x0a, 0x61, 0xbc, 0x22, 0x4e, 0xde, 0xdd, 0x8e, 0x63, 0xae, 0xf7, 0xbe,
    0x1a, 0xaf, 0x8e, 0x93, 0xd7, 0xa9, 0x71, 0x8b, 0x04, 0x7c, 0xcd, 0xdb, 0x3e, 0xb5, 0xd6, 0x8b,
    0x0e, 0x5d, 0xb2, 0xb6, 0xbf, 0xbb, 0x01, 0xc8, 0x67, 0x74, 0x9c, 0xad, 0xff, 0xca, 0x88, 0xb3,
    0x6c, 0x24, 0xf3, 0x01, 0x2b, 0xa0, 0x9f, 0xc4, 0xd3, 0x02, 0x2c, 0x5c, 0x37, 0xdc, 0xe0, 0xf9,
    0x77, 0xd3, 0xad, 0xb5, 0xd1, 0x83, 0xc7, 0x47, 0x7c, 0x44, 0x2b, 0x1f, 0x04, 0x51, 0x52, 0x73,
];

const FIX_DRAND_SIG: [u8; 96] = [
    0x04, 0xd8, 0x55, 0xb2, 0xde, 0x9c, 0x5c, 0x21, 0xee, 0x03, 0x90, 0xb2, 0xb9, 0x18, 0x02, 0x96,
    0xa9, 0x19, 0xa1, 0xaf, 0x43, 0x51, 0xca, 0xc6, 0xfd, 0x20, 0x00, 0x7b, 0xa1, 0xc6, 0x10, 0xe0,
    0x1e, 0x5b, 0xd0, 0xeb, 0x7d, 0xc5, 0x6a, 0x79, 0x3c, 0x60, 0x2d, 0x79, 0x42, 0xbc, 0x0b, 0x3d,
    0x15, 0x76, 0x22, 0x83, 0xeb, 0x6a, 0x04, 0x5c, 0x59, 0xc0, 0xb7, 0x88, 0xae, 0x34, 0xea, 0xfc,
    0xdd, 0x6d, 0xd0, 0x87, 0x7a, 0xa5, 0x24, 0xf1, 0x8c, 0xab, 0x25, 0x84, 0x4d, 0xf9, 0x7b, 0x09,
    0xb0, 0x66, 0x0c, 0x2a, 0x92, 0xca, 0x2a, 0x28, 0x83, 0x0a, 0x94, 0x81, 0x96, 0xbb, 0xeb, 0x92,
];

const E1_SK: [u8; 32] = [
    0x4e, 0x82, 0x79, 0x6b, 0xf7, 0x17, 0x2e, 0x57, 0x1e, 0xc8, 0x8c, 0x62, 0x41, 0xf2, 0xe0, 0x97,
    0x95, 0x6e, 0xba, 0x56, 0x9a, 0x3f, 0xf9, 0xbf, 0x60, 0xb1, 0x70, 0x38, 0xb4, 0x33, 0xf4, 0x49,
];

const E1_PK: [u8; 192] = [
    0x08, 0xc8, 0x2b, 0xc4, 0x98, 0x8f, 0x2d, 0x2f, 0x0f, 0xf3, 0x1e, 0x4a, 0x95, 0x3a, 0xe4, 0xff,
    0x24, 0x22, 0xdd, 0x70, 0x47, 0x27, 0xc5, 0x9d, 0x88, 0x8e, 0x80, 0x88, 0x30, 0xeb, 0x17, 0x16,
    0x68, 0x48, 0x01, 0x46, 0xcd, 0x07, 0x38, 0x45, 0x06, 0xf3, 0xfd, 0x07, 0x80, 0xd0, 0xb0, 0x74,
    0x09, 0xc9, 0x9d, 0xb1, 0x29, 0x35, 0xbd, 0xae, 0x81, 0xc6, 0x2a, 0x95, 0x00, 0x7f, 0xe2, 0x48,
    0x34, 0x51, 0xf0, 0x8c, 0xed, 0x4f, 0x73, 0x6f, 0x39, 0x70, 0xc6, 0xab, 0xdd, 0x13, 0x58, 0x1f,
    0x71, 0x40, 0x2b, 0xa4, 0xd8, 0x7e, 0xf0, 0xa2, 0xf7, 0x49, 0x4d, 0x11, 0xdd, 0x19, 0x04, 0x6f,
    0x15, 0xd8, 0x69, 0xb4, 0xaf, 0x6e, 0x79, 0x9e, 0x90, 0x7d, 0x34, 0x28, 0x03, 0xf5, 0x4d, 0x8d,
    0x9b, 0x7b, 0xfb, 0x87, 0xfc, 0xe5, 0x0c, 0xda, 0x1d, 0x3c, 0x6a, 0x00, 0x7d, 0xde, 0x8e, 0x0c,
    0x57, 0x2b, 0x88, 0x3b, 0xc3, 0x97, 0xc9, 0x2c, 0x2e, 0xfd, 0x28, 0x2a, 0x73, 0xab, 0x64, 0xcd,
    0x15, 0xda, 0x2f, 0x31, 0x0c, 0xaf, 0x09, 0xe8, 0x21, 0xbb, 0x49, 0x50, 0x73, 0xa6, 0xbd, 0x08,
    0x0e, 0x1a, 0x6e, 0xaf, 0x88, 0xe6, 0xb3, 0xb7, 0x7e, 0x1a, 0x5c, 0x57, 0x05, 0x50, 0x00, 0xc1,
    0x44, 0xf9, 0xc5, 0xde, 0x48, 0x97, 0x8f, 0x2d, 0xa4, 0xc1, 0xfd, 0x6a, 0x18, 0xc9, 0xf1, 0xd7,
];

const E1_ALPHA: [u8; 32] = [
    0x7b, 0xeb, 0x6e, 0xc7, 0x32, 0xb9, 0xac, 0x65, 0x5b, 0xda, 0xed, 0x2a, 0x71, 0xf9, 0x8d, 0xad,
    0x0a, 0x02, 0xb0, 0x3f, 0x2a, 0x57, 0x7e, 0x85, 0x8d, 0x2d, 0x80, 0xc9, 0xfa, 0x84, 0x7d, 0xcb,
];

const E1_GAMMA: [u8; 96] = [
    0x0b, 0xaf, 0x7b, 0xe5, 0x30, 0xb5, 0xc4, 0xaa, 0x4d, 0x35, 0xa2, 0xcc, 0x07, 0x78, 0x0c, 0xaf,
    0xe1, 0x3c, 0x7c, 0x4e, 0x0a, 0x97, 0x5a, 0x16, 0x85, 0xd4, 0xb0, 0xc3, 0x0b, 0x82, 0xf1, 0x3f,
    0x14, 0x6a, 0x31, 0xea, 0x7e, 0x8d, 0x16, 0x33, 0x8e, 0x48, 0xf8, 0x08, 0xba, 0x49, 0x2b, 0x5f,
    0x03, 0xd2, 0x2b, 0x8a, 0xb3, 0x49, 0x07, 0x99, 0xfe, 0x28, 0x83, 0xf9, 0x51, 0x70, 0x82, 0x07,
    0xda, 0xcc, 0x86, 0xcf, 0x04, 0xbc, 0xd9, 0xea, 0x27, 0x43, 0x1d, 0x1d, 0x23, 0x77, 0xca, 0x71,
    0x13, 0x2b, 0x4d, 0xa7, 0x35, 0x2c, 0xf3, 0x4d, 0xf2, 0x86, 0x77, 0xab, 0xd4, 0x65, 0x46, 0x93,
];

const E1_BETA: [u8; 32] = [
    0xe3, 0x5a, 0x05, 0x18, 0x0a, 0xc9, 0xba, 0xaf, 0x2e, 0x75, 0x41, 0x9f, 0xa3, 0xbc, 0x8e, 0xa4,
    0xe8, 0x77, 0xa0, 0x07, 0x7c, 0x24, 0x18, 0x45, 0x05, 0xf2, 0x65, 0x7f, 0xce, 0xfe, 0xab, 0x48,
];

const E2_SK: [u8; 32] = [
    0x15, 0xf0, 0xea, 0xe9, 0xa1, 0x5c, 0x85, 0xa0, 0x0e, 0xc1, 0x65, 0x53, 0xce, 0xd0, 0x0c, 0x16,
    0x65, 0x04, 0x6a, 0x2f, 0x5b, 0xa9, 0xc6, 0xfe, 0x1f, 0x9a, 0x80, 0x2a, 0x37, 0xce, 0x20, 0xc9,
];

const E2_PK: [u8; 192] = [
    0x17, 0x84, 0xe8, 0xd7, 0x59, 0x34, 0x34, 0x75, 0x39, 0x2e, 0xd4, 0xa9, 0xa2, 0x2f, 0x30, 0x68,
    0xab, 0xb6, 0xd4, 0x4a, 0x1c, 0x83, 0x91, 0x61, 0x5c, 0xd1, 0xec, 0x91, 0x36, 0xf7, 0xa5, 0xd2,
    0x6b, 0xb5, 0xaa, 0x2e, 0xb6, 0xbc, 0x61, 0xf9, 0x47, 0x26, 0xf2, 0x87, 0xc9, 0xae, 0x87, 0xb5,
    0x08, 0x83, 0x83, 0x26, 0x5e, 0x93, 0x7b, 0xe2, 0x16, 0x0a, 0xcd, 0x91, 0x78, 0x14, 0xcf, 0x3a,
    0x6b, 0xa6, 0x03, 0xb0, 0x9b, 0xd9, 0x8d, 0x57, 0x71, 0x79, 0x54, 0x26, 0x6e, 0x56, 0x3b, 0x76,
    0x2f, 0x73, 0x1d, 0xb5, 0x1c, 0xff, 0xa2, 0x65, 0xfe, 0x37, 0x6c, 0x04, 0x5c, 0x1f, 0x9b, 0xd8,
    0x0b, 0x77, 0x5a, 0xc5, 0x6e, 0x90, 0xaa, 0xc3, 0x80, 0xc9, 0x24, 0x60, 0x2c, 0x8b, 0x2d, 0x98,
    0xc3, 0x8e, 0x47, 0xa6, 0x8e, 0x9a, 0xf3, 0xc8, 0xd1, 0x0f, 0xfc, 0x16, 0x22, 0x62, 0xcd, 0xa7,
    0xd6, 0xe0, 0x73, 0xe2, 0x7c, 0x1c, 0x75, 0x82, 0x7f, 0x46, 0xb5, 0x14, 0x02, 0xcc, 0xba, 0x63,
    0x0a, 0x5e, 0x62, 0xf2, 0xc4, 0x8d, 0xa0, 0xf6, 0xe9, 0xab, 0xc0, 0x4e, 0x23, 0x21, 0x16, 0x52,
    0x2b, 0xb2, 0x8e, 0x0b, 0xcb, 0x6e, 0x0d, 0x90, 0xf7, 0x75, 0x8b, 0x46, 0xfb, 0x07, 0x03, 0x33,
    0x5b, 0x5b, 0xda, 0x41, 0x91, 0x40, 0x1a, 0x3d, 0x24, 0x71, 0x6c, 0xb3, 0x9b, 0x40, 0xde, 0xfa,
];

const E2_ALPHA: [u8; 32] = [
    0x1b, 0x61, 0x0e, 0x41, 0x4d, 0xd8, 0x6c, 0x6d, 0xc8, 0xd8, 0xf9, 0x33, 0x1f, 0xd0, 0x26, 0xc7,
    0x54, 0xa2, 0x7c, 0x48, 0x5c, 0x6d, 0x53, 0xe5, 0xfa, 0x0e, 0xf6, 0x2b, 0x73, 0xd0, 0x39, 0x96,
];

const E2_GAMMA: [u8; 96] = [
    0x04, 0xf8, 0xf9, 0x57, 0x02, 0x3f, 0xa0, 0xe4, 0x28, 0x49, 0x88, 0xaf, 0x15, 0xc3, 0x08, 0xcf,
    0x0f, 0xf2, 0xd6, 0xed, 0xf2, 0xa7, 0x30, 0x91, 0xad, 0xa3, 0x3e, 0x48, 0xb4, 0x44, 0x18, 0x6b,
    0xbf, 0xf3, 0x98, 0x79, 0x25, 0x96, 0x0b, 0x3e, 0xbd, 0xa4, 0x97, 0x56, 0xe3, 0x4e, 0x4e, 0x54,
    0x0b, 0xe9, 0x96, 0x27, 0x7c, 0x2e, 0x8b, 0xae, 0x52, 0xc7, 0xf1, 0x73, 0x90, 0x79, 0x91, 0x8b,
    0x9b, 0xc8, 0x62, 0x48, 0xde, 0xd5, 0x46, 0xe8, 0x79, 0x9b, 0x73, 0x0b, 0x7c, 0x46, 0x22, 0x65,
    0xa0, 0x09, 0xc1, 0x52, 0x1d, 0xaf, 0x4b, 0xcd, 0x9d, 0x1a, 0x7e, 0x1f, 0x40, 0x79, 0xec, 0xc5,
];

const E2_BETA: [u8; 32] = [
    0x46, 0x46, 0xff, 0x6c, 0x79, 0x8c, 0xa2, 0xae, 0xf2, 0x14, 0xd4, 0x03, 0x62, 0x9a, 0x85, 0x98,
    0x37, 0x49, 0x97, 0xba, 0x87, 0x9a, 0x2c, 0xa4, 0xfb, 0xd1, 0xde, 0x19, 0xfd, 0x28, 0xcc, 0x4b,
];

#[test]
fn test_pop_message_layout() {
    // Layout documented for off-chain tools (oracle-worker/v2_pop.mjs):
    // POP_DOMAIN ‖ xdr(ScVal::Address(contract)) ‖ epoch_id_be ‖ pk.
    use soroban_sdk::xdr::ToXdr;
    let t = setup();
    let pk = BytesN::from_array(&t.env, &E2_PK);
    let msg = t
        .env
        .as_contract(&t.client.address, || crate::pop_message(&t.env, 7, &pk));
    let mut want = Bytes::from_slice(&t.env, crate::POP_DOMAIN);
    want.append(&t.client.address.clone().to_xdr(&t.env));
    want.append(&Bytes::from_slice(&t.env, &7u32.to_be_bytes()));
    want.append(&Bytes::from_slice(&t.env, &E2_PK));
    assert_eq!(msg, want);
    let addr_xdr = t.client.address.clone().to_xdr(&t.env);
    let mut hex = std::string::String::new();
    for b in addr_xdr.iter() {
        hex.push_str(&std::format!("{:02x}", b));
    }
    let strkey = t.client.address.to_string();
    let mut buf = [0u8; 56];
    strkey.copy_into_slice(&mut buf);
    // Same bytes as `new Address(strkey).toScVal().toXDR()` in stellar-sdk JS
    // (checked once against @stellar/stellar-sdk 17 for this test address).
    assert_eq!(
        core::str::from_utf8(&buf).unwrap(),
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM"
    );
    assert_eq!(
        hex,
        "00000012000000010000000000000000000000000000000000000000000000000000000000000005"
    );
}

/// PoP produced by `oracle-worker/v2_lib.mjs` (`popSignature`) for this test
/// contract address, epoch 2 and the E2 key: the operator tool and the
/// contract agree on the message layout.
const JS_POP_E2_EPOCH2: [u8; 96] = [
    0x0b, 0x1a, 0x5a, 0x89, 0x8f, 0xe8, 0x67, 0x30, 0x16, 0x3d, 0xc6, 0x8e, 0xf2, 0x70, 0x91, 0x7b,
    0xb1, 0x96, 0x89, 0x8f, 0xc7, 0xce, 0x4b, 0x6f, 0xb7, 0x53, 0xf1, 0x42, 0x37, 0x4c, 0xb2, 0xbd,
    0x41, 0x79, 0xb9, 0xac, 0x06, 0xf1, 0xa0, 0xb3, 0xfa, 0x7e, 0xcb, 0xd7, 0x88, 0x22, 0x0a, 0x1f,
    0x07, 0xcd, 0xbc, 0x9e, 0xcc, 0x7f, 0xc7, 0x1e, 0x79, 0x11, 0x78, 0x45, 0x52, 0xe7, 0x39, 0x54,
    0xe3, 0x0a, 0xf6, 0x09, 0x41, 0xc6, 0x49, 0x65, 0x7a, 0xe0, 0x2e, 0x91, 0xb5, 0x3e, 0x28, 0x8e,
    0xa3, 0x5a, 0x41, 0xad, 0x3b, 0xaa, 0x3c, 0xc3, 0xe4, 0xe0, 0xa2, 0x8f, 0x8e, 0x54, 0xbc, 0x78,
];

#[test]
fn test_pop_from_operator_tool_accepted() {
    let t = setup();
    t.client.propose_key_rotation(
        &t.admin,
        &BytesN::from_array(&t.env, &E2_PK),
        &Address::generate(&t.env),
        &BytesN::from_array(&t.env, &JS_POP_E2_EPOCH2),
    );
    assert_eq!(t.client.pending_rotation().unwrap().new_epoch_id, 2);
}

/// The V2 `fulfill` event value, byte for byte. The same hex is parsed by the
/// Rust SDK (`test_parse_v2_event_vectors`) and was built with stellar-sdk JS.
const EVT_FULFILL_V2_XDR_HEX: &str = "0000001000000001000000030000000500000000000000010000000d00000020e35a05180ac9baaf2e75419fa3bc8ea4e877a0077c24184505f2657fcefeab480000000300000001";

#[test]
fn test_fulfill_event_wire_format_v2() {
    use soroban_sdk::xdr::{Limits, WriteXdr};
    let t = setup();
    let id = t.client.request(&ctx(&t.env), &Address::generate(&t.env));
    t.client.fulfill(&id, &e1_proof(&t.env));
    let evs = t.env.events().all().filter_by_contract(&t.client.address);
    let e = evs.events().last().unwrap().clone();
    let soroban_sdk::xdr::ContractEventBody::V0(body) = e.body;
    let bytes = body.data.to_xdr(Limits::none()).unwrap();
    let mut hex = std::string::String::new();
    for b in bytes {
        hex.push_str(&std::format!("{:02x}", b));
    }
    assert_eq!(hex, EVT_FULFILL_V2_XDR_HEX);
}
