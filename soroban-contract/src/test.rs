#![cfg(test)]

extern crate alloc;
use alloc::format;

use soroban_sdk::{
    testutils::Address as _, testutils::Ledger as _, Address, Bytes, BytesN, Env, Symbol,
};

use crate::testkeys::{TEST_G2_TIMES_2, TEST_G2_TIMES_3, TEST_G2_TIMES_5};
use crate::{
    EpochData, EpochStatus, PendingRotation, VRFOracleContract, VRFOracleContractClient,
    MIN_ROTATION_TIMELOCK_LEDGERS, MIN_UPGRADE_TIMELOCK_LEDGERS,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SETUP
// ═══════════════════════════════════════════════════════════════════════════════

/// V2 setup: constructor now requires admin (separate from operator) + timelocks.
fn setup() -> (
    Env,
    VRFOracleContractClient<'static>,
    Address, // admin
    Address, // oracle_addr (operator)
    BytesN<192>, // oracle_pk
    BytesN<32>,  // oracle_ed25519
    BytesN<192>, // drand_pk
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);

    let contract_id = env.register(
        VRFOracleContract,
        (
            &admin,
            &oracle_pk,
            &oracle_addr,
            &oracle_ed25519,
            &drand_pk,
            &1_692_803_367u64,  // drand genesis
            &3u32,              // drand period
            &2u32,              // round offset
            &fee_token,
            &0i128,             // fee-free for tests
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
    let client = VRFOracleContractClient::new(&env, &contract_id);

    (
        env,
        client,
        admin,
        oracle_addr,
        oracle_pk,
        oracle_ed25519,
        drand_pk,
    )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTRUCTOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_init_stores_oracle_pk() {
    let (_env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    assert_eq!(client.oracle_pk(), oracle_pk);
}

#[test]
fn test_init_stores_oracle_address() {
    let (_env, client, _admin, oracle_addr, _pk, _ed, _drand_pk) = setup();
    assert_eq!(client.oracle_address(), oracle_addr);
}

#[test]
fn test_init_stores_admin() {
    let (_env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    assert_eq!(client.admin(), admin);
}

#[test]
fn test_init_creates_epoch_1() {
    let (_env, client, _admin, _addr, oracle_pk, _ed, drand_pk) = setup();
    assert_eq!(client.current_epoch_id(), 1);
    let epoch = client.epoch_data(&1);
    assert_eq!(epoch.oracle_bls_pk, oracle_pk);
    assert_eq!(epoch.drand_pk, drand_pk);
    assert_eq!(epoch.status, EpochStatus::Active);
    assert_eq!(epoch.pending_count, 0);
}

#[test]
fn test_init_version_and_getters() {
    let (_env, client, _admin, _addr, _pk, _ed, drand_pk) = setup();
    assert_eq!(client.contract_version(), 2);
    assert_eq!(client.drand_pk(), drand_pk);
    assert_eq!(client.drand_genesis_time(), 1_692_803_367);
    assert_eq!(client.drand_period(), 3);
    assert_eq!(client.timeout_rounds(), 20);
}

#[test]
#[should_panic(expected = "admin must differ from oracle operator")]
fn test_init_rejects_admin_eq_operator() {
    let env = Env::default();
    env.mock_all_auths();

    let same_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);

    env.register(
        VRFOracleContract,
        (
            &same_addr,        // admin = operator → must panic
            &oracle_pk,
            &same_addr,
            &oracle_ed25519,
            &drand_pk,
            &1_692_803_367u64,
            &3u32,
            &2u32,
            &fee_token,
            &0i128,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
}

#[test]
#[should_panic(expected = "rotation timelock below minimum")]
fn test_init_rejects_low_rotation_timelock() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);

    env.register(
        VRFOracleContract,
        (
            &admin,
            &oracle_pk,
            &oracle_addr,
            &oracle_ed25519,
            &drand_pk,
            &1_692_803_367u64,
            &3u32,
            &2u32,
            &fee_token,
            &0i128,
            &100u32,  // below MIN_ROTATION_TIMELOCK_LEDGERS
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
}

#[test]
#[should_panic(expected = "round_offset must be >= 2")]
fn test_init_rejects_zero_round_offset() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);

    env.register(
        VRFOracleContract,
        (
            &admin,
            &oracle_pk,
            &oracle_addr,
            &oracle_ed25519,
            &drand_pk,
            &1_692_803_367u64,
            &3u32,
            &0u32,  // must panic
            &fee_token,
            &0i128,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST TESTS — EPOCH BINDING (S1, S7)
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_request_returns_incremented_ids() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let ctx1 = Bytes::from_slice(&env, b"ctx_one");
    let ctx2 = Bytes::from_slice(&env, b"ctx_two");

    assert_eq!(client.request(&ctx1, &requester), 1);
    assert_eq!(client.request(&ctx2, &requester), 2);
}

#[test]
fn test_request_stores_epoch_id() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"test_context");

    let id = client.request(&context, &requester);
    assert_eq!(client.request_epoch(&id), 1); // bound to epoch 1
}

#[test]
fn test_request_increments_pending_count() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let ctx = Bytes::from_slice(&env, b"ctx");

    assert_eq!(client.epoch_data(&1).pending_count, 0);

    client.request(&ctx, &requester);
    assert_eq!(client.epoch_data(&1).pending_count, 1);

    let ctx2 = Bytes::from_slice(&env, b"ctx2");
    client.request(&ctx2, &requester);
    assert_eq!(client.epoch_data(&1).pending_count, 2);
}

#[test]
fn test_request_is_initially_unfulfilled() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"test_context");

    let id = client.request(&context, &requester);
    assert!(!client.is_fulfilled(&id));
    assert!(!client.is_refunded(&id));
}

#[test]
fn test_request_stores_requester() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");

    let id = client.request(&context, &requester);
    assert_eq!(client.requester_of(&id), requester);
}

#[test]
fn test_request_locks_expected_round() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"round_lock_context");

    let id = client.request(&context, &requester);
    let round = client.request_round(&id);
    // Default test env timestamp (0) is before genesis → current round 0, so round = 0+2 = 2
    assert_eq!(round, 2);
}

#[test]
#[should_panic(expected = "context exceeds maximum length")]
fn test_request_oversized_context_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let buf = [0u8; 1025];
    let context = Bytes::from_slice(&env, &buf);
    client.request(&context, &requester);
}

#[test]
fn test_request_counter_sequential() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);

    for expected_id in 1u64..=5 {
        let context = Bytes::from_slice(&env, format!("ctx_{}", expected_id).as_bytes());
        let id = client.request(&context, &requester);
        assert_eq!(id, expected_id);
    }
}

#[test]
fn test_request_with_callback_stores_callback() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let callback_contract = Address::generate(&env);
    let callback_fn = Symbol::new(&env, "on_vrf");
    let context = Bytes::from_slice(&env, b"callback_context");

    let id = client.request_with_callback(
        &context,
        &callback_contract,
        &callback_contract,
        &callback_fn,
    );
    let cb = client.callback_of(&id);
    assert!(cb.is_some());
    let (stored_contract, stored_fn) = cb.unwrap();
    assert_eq!(stored_contract, callback_contract);
    assert_eq!(stored_fn, callback_fn);
}

#[test]
fn test_timeout_rounds_constant() {
    let (_env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    assert_eq!(client.timeout_rounds(), 20);
}

#[test]
fn test_is_fulfilled_nonexistent_returns_false() {
    let (_env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    assert!(!client.is_fulfilled(&999u64));
}

// ═══════════════════════════════════════════════════════════════════════════════
// EPOCH REVOCATION TESTS (S8, S9, S16, S20)
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_revoke_epoch_sets_revoked() {
    let (_env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    client.revoke_epoch(&admin, &1);
    assert_eq!(client.epoch_status(&1), EpochStatus::Revoked);
}

#[test]
#[should_panic(expected = "epoch already revoked")]
fn test_revoke_epoch_idempotent_rejected() {
    let (_env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    client.revoke_epoch(&admin, &1);
    client.revoke_epoch(&admin, &1); // second call must panic
}

#[test]
#[should_panic(expected = "active epoch not accepting requests")]
fn test_revoke_active_blocks_new_requests() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    client.revoke_epoch(&admin, &1);

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"should_fail");
    client.request(&context, &requester); // must panic — active epoch is revoked
}

#[test]
#[should_panic(expected = "unauthorized: not admin")]
fn test_revoke_epoch_requires_admin() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let impostor = Address::generate(&env);
    client.revoke_epoch(&impostor, &1); // must panic
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMERGENCY REFUND TESTS (S9, S10)
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_emergency_refund_on_revoked_epoch() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"emergency_ctx");

    let id = client.request(&context, &requester);
    assert_eq!(client.epoch_data(&1).pending_count, 1);

    client.revoke_epoch(&admin, &1);
    client.emergency_refund(&id);

    assert!(client.is_refunded(&id));
    assert!(!client.is_fulfilled(&id));
    assert_eq!(client.epoch_data(&1).pending_count, 0);
    // RequestEpoch should still be queryable
    assert_eq!(client.request_epoch(&id), 1);
}

#[test]
#[should_panic(expected = "emergency refund only for revoked epochs")]
fn test_emergency_refund_on_active_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);
    client.emergency_refund(&id); // epoch is Active, must panic
}

#[test]
#[should_panic(expected = "already refunded")]
fn test_emergency_refund_double_rejected() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);
    client.revoke_epoch(&admin, &1);
    client.emergency_refund(&id);
    client.emergency_refund(&id); // must panic
}

// ═══════════════════════════════════════════════════════════════════════════════
// EPOCH LIFECYCLE TESTS (S6, S12)
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "cannot retire active epoch")]
fn test_retire_active_epoch_rejected() {
    let (_env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    client.retire_epoch(&1); // epoch 1 is active
}

#[test]
#[should_panic(expected = "epoch still has pending requests")]
fn test_retire_epoch_with_pending_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    client.request(&context, &requester); // pending_count = 1 on epoch 1

    // Simulate epoch 2 being active so epoch 1 is not the active epoch
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().instance().set(&DataKey::ActiveEpochId, &2u32);
    });

    client.retire_epoch(&1);
}

#[test]
fn test_retire_epoch_success() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().instance().set(&DataKey::ActiveEpochId, &2u32);
        env.storage().instance().set(&DataKey::RetainedEpochCount, &2u32);
    });

    assert_eq!(client.retained_epoch_count(), 2);
    client.retire_epoch(&1);
    assert_eq!(client.retained_epoch_count(), 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// KEY ROTATION GOVERNANCE & REVOCATION SURVIVAL (CRITICAL — S16, S20)
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_revocation_survives_rotation() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let req_id = client.request(&context, &requester);

    // 1. Revoke epoch 1
    client.revoke_epoch(&admin, &1);
    assert_eq!(client.epoch_status(&1), EpochStatus::Revoked);

    // 2. Set up pending rotation to epoch 2
    let new_oracle_addr = Address::generate(&env);
    let new_epoch_data = EpochData {
        oracle_bls_pk: BytesN::from_array(&env, &TEST_G2_TIMES_5),
        oracle_ed25519_pk: BytesN::from_array(&env, &[0x22; 32]),
        oracle_address: new_oracle_addr,
        drand_pk: BytesN::from_array(&env, &TEST_G2_TIMES_3),
        status: EpochStatus::Active,
        pending_count: 0,
        created_ledger: env.ledger().sequence(),
    };
    let pending = PendingRotation {
        new_epoch: new_epoch_data,
        new_epoch_id: 2,
        source_epoch_id: 1,
        proposed_ledger: env.ledger().sequence(),
        execute_after_ledger: env.ledger().sequence() + MIN_ROTATION_TIMELOCK_LEDGERS,
    };

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::PendingRot, &Some(pending));
    });

    // 3. Advance ledger past timelock
    env.ledger().with_mut(|li| {
        li.sequence_number += MIN_ROTATION_TIMELOCK_LEDGERS + 1;
    });

    // 4. Execute rotation
    client.execute_key_rotation(&admin);

    // 5. Invariant S16: epoch 1 MUST REMAIN Revoked (NEVER overridden to Superseded)
    assert_eq!(client.epoch_status(&1), EpochStatus::Revoked);
    assert_eq!(client.current_epoch_id(), 2);
    assert_eq!(client.epoch_status(&2), EpochStatus::Active);

    // 6. Emergency refund for epoch 1 request still succeeds
    client.emergency_refund(&req_id);
    assert!(client.is_refunded(&req_id));

    // 7. Active epoch 2 receives new requests normally
    let req2 = client.request(&context, &requester);
    assert_eq!(client.request_epoch(&req2), 2);
}

#[test]
fn test_revoke_source_cancels_pending_rotation() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();

    let new_oracle_addr = Address::generate(&env);
    let new_epoch_data = EpochData {
        oracle_bls_pk: BytesN::from_array(&env, &TEST_G2_TIMES_5),
        oracle_ed25519_pk: BytesN::from_array(&env, &[0x22; 32]),
        oracle_address: new_oracle_addr,
        drand_pk: BytesN::from_array(&env, &TEST_G2_TIMES_3),
        status: EpochStatus::Active,
        pending_count: 0,
        created_ledger: env.ledger().sequence(),
    };
    let pending = PendingRotation {
        new_epoch: new_epoch_data,
        new_epoch_id: 2,
        source_epoch_id: 1,
        proposed_ledger: env.ledger().sequence(),
        execute_after_ledger: env.ledger().sequence() + MIN_ROTATION_TIMELOCK_LEDGERS,
    };

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::PendingRot, &Some(pending));
    });

    assert!(client.pending_rotation().is_some());
    // Invariant S20: revoking source epoch auto-cancels the pending rotation
    client.revoke_epoch(&admin, &1);
    assert!(client.pending_rotation().is_none());
}

#[test]
#[should_panic(expected = "rotation timelock not elapsed")]
fn test_execute_key_rotation_before_timelock_rejected() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();

    let new_oracle_addr = Address::generate(&env);
    let new_epoch_data = EpochData {
        oracle_bls_pk: BytesN::from_array(&env, &TEST_G2_TIMES_5),
        oracle_ed25519_pk: BytesN::from_array(&env, &[0x22; 32]),
        oracle_address: new_oracle_addr,
        drand_pk: BytesN::from_array(&env, &TEST_G2_TIMES_3),
        status: EpochStatus::Active,
        pending_count: 0,
        created_ledger: env.ledger().sequence(),
    };
    let pending = PendingRotation {
        new_epoch: new_epoch_data,
        new_epoch_id: 2,
        source_epoch_id: 1,
        proposed_ledger: env.ledger().sequence(),
        execute_after_ledger: env.ledger().sequence() + MIN_ROTATION_TIMELOCK_LEDGERS,
    };

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::PendingRot, &Some(pending));
    });

    client.execute_key_rotation(&admin); // must panic: timelock not elapsed
}

#[test]
fn test_cancel_key_rotation() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();

    let new_oracle_addr = Address::generate(&env);
    let new_epoch_data = EpochData {
        oracle_bls_pk: BytesN::from_array(&env, &TEST_G2_TIMES_5),
        oracle_ed25519_pk: BytesN::from_array(&env, &[0x22; 32]),
        oracle_address: new_oracle_addr,
        drand_pk: BytesN::from_array(&env, &TEST_G2_TIMES_3),
        status: EpochStatus::Active,
        pending_count: 0,
        created_ledger: env.ledger().sequence(),
    };
    let pending = PendingRotation {
        new_epoch: new_epoch_data,
        new_epoch_id: 2,
        source_epoch_id: 1,
        proposed_ledger: env.ledger().sequence(),
        execute_after_ledger: env.ledger().sequence() + MIN_ROTATION_TIMELOCK_LEDGERS,
    };

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::PendingRot, &Some(pending));
    });

    assert!(client.pending_rotation().is_some());
    client.cancel_key_rotation(&admin);
    assert!(client.pending_rotation().is_none());
}

#[test]
#[should_panic(expected = "epoch revoked")]
fn test_fulfill_revoked_epoch_rejected() {
    let (env, client, admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);

    client.revoke_epoch(&admin, &1);

    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 2,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &dummy_proof, &dummy_sig);
}
// UPGRADE GOVERNANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_propose_upgrade_stores_proposal() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let wasm_hash = BytesN::from_array(&env, &[0xAA; 32]);

    assert!(client.pending_upgrade().is_none());
    client.propose_upgrade(&admin, &wasm_hash);
    let pending = client.pending_upgrade();
    assert!(pending.is_some());
    let p = pending.unwrap();
    assert_eq!(p.wasm_hash, wasm_hash);
}

#[test]
#[should_panic(expected = "unauthorized: not admin")]
fn test_propose_upgrade_requires_admin() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let impostor = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[0xAA; 32]);
    client.propose_upgrade(&impostor, &wasm_hash);
}

#[test]
#[should_panic(expected = "pending upgrade already exists")]
fn test_propose_upgrade_blocked_if_pending() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let wasm1 = BytesN::from_array(&env, &[0xAA; 32]);
    let wasm2 = BytesN::from_array(&env, &[0xBB; 32]);
    client.propose_upgrade(&admin, &wasm1);
    client.propose_upgrade(&admin, &wasm2); // must panic
}

#[test]
fn test_cancel_upgrade_clears_proposal() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let wasm_hash = BytesN::from_array(&env, &[0xAA; 32]);

    client.propose_upgrade(&admin, &wasm_hash);
    assert!(client.pending_upgrade().is_some());

    client.cancel_upgrade(&admin);
    assert!(client.pending_upgrade().is_none());
}

#[test]
#[should_panic(expected = "upgrade timelock not elapsed")]
fn test_execute_upgrade_before_timelock_rejected() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let wasm_hash = BytesN::from_array(&env, &[0xAA; 32]);
    client.propose_upgrade(&admin, &wasm_hash);
    // Don't advance ledger → timelock not elapsed
    client.execute_upgrade(&admin); // must panic
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN TRANSFER GOVERNANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_propose_admin_transfer() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let new_admin = Address::generate(&env);

    assert!(client.pending_admin_transfer().is_none());
    client.propose_admin_transfer(&admin, &new_admin);
    let pending = client.pending_admin_transfer();
    assert!(pending.is_some());
    assert_eq!(pending.unwrap().new_admin, new_admin);
}

#[test]
#[should_panic(expected = "new admin must differ from operator")]
fn test_propose_admin_transfer_rejects_operator_as_admin() {
    let (_env, client, admin, oracle_addr, _pk, _ed, _drand_pk) = setup();
    // Trying to set the oracle operator as the new admin must fail
    client.propose_admin_transfer(&admin, &oracle_addr);
}

#[test]
fn test_execute_admin_transfer_after_timelock() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin_transfer(&admin, &new_admin);

    // Advance ledger past the timelock
    env.ledger().with_mut(|li| {
        li.sequence_number += MIN_UPGRADE_TIMELOCK_LEDGERS + 1;
    });

    client.execute_admin_transfer(&admin);
    assert_eq!(client.admin(), new_admin);
    assert!(client.pending_admin_transfer().is_none());
}

#[test]
#[should_panic(expected = "admin transfer timelock not elapsed")]
fn test_execute_admin_transfer_before_timelock_rejected() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin_transfer(&admin, &new_admin);
    // Don't advance ledger
    client.execute_admin_transfer(&admin);
}

#[test]
fn test_cancel_admin_transfer() {
    let (env, client, admin, _addr, _pk, _ed, _drand_pk) = setup();
    let new_admin = Address::generate(&env);

    client.propose_admin_transfer(&admin, &new_admin);
    assert!(client.pending_admin_transfer().is_some());

    client.cancel_admin_transfer(&admin);
    assert!(client.pending_admin_transfer().is_none());
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMEOUT REFUND TESTS (epoch-aware)
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_timeout_refund_decrements_pending_count() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"timeout_ctx");

    let id = client.request(&context, &requester);
    assert_eq!(client.epoch_data(&1).pending_count, 1);

    // Advance past timeout window
    // round = 2, TIMEOUT_ROUNDS = 20, need current_round > 22
    // genesis = 1692803367, period = 3
    env.ledger().with_mut(|li| {
        li.timestamp = 1_692_803_367 + 100;
    });

    client.timeout_refund(&id);
    assert!(client.is_refunded(&id));
    assert_eq!(client.epoch_data(&1).pending_count, 0);
    // RequestEpoch still available
    assert_eq!(client.request_epoch(&id), 1);
}

#[test]
#[should_panic(expected = "timeout window not reached")]
fn test_timeout_refund_too_early() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);
    // Don't advance time
    client.timeout_refund(&id);
}

#[test]
#[should_panic(expected = "already fulfilled")]
fn test_timeout_refund_fulfilled_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
    });

    client.timeout_refund(&id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTRUCTOR VALIDATION & CRYPTOGRAPHIC GUARDS
// ═══════════════════════════════════════════════════════════════════════════════

fn try_construct(env: &Env, oracle_pk: [u8; 192], drand_pk: [u8; 192], ed: [u8; 32]) {
    let admin = Address::generate(env);
    let oracle_addr = Address::generate(env);
    let fee_token = Address::generate(env);
    env.register(
        VRFOracleContract,
        (
            &admin,
            &BytesN::from_array(env, &oracle_pk),
            &oracle_addr,
            &BytesN::from_array(env, &ed),
            &BytesN::from_array(env, &drand_pk),
            &1_692_803_367u64,
            &3u32,
            &2u32,
            &fee_token,
            &0i128,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
}

fn g2_infinity() -> [u8; 192] {
    let mut p = [0u8; 192];
    p[0] = 0x40;
    p
}

#[test]
#[should_panic(expected = "round_offset must be >= 2")]
fn test_init_rejects_round_offset_one() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);
    env.register(
        VRFOracleContract,
        (
            &admin,
            &oracle_pk,
            &oracle_addr,
            &oracle_ed25519,
            &drand_pk,
            &1_692_803_367u64,
            &3u32,
            &1u32, // < 2 must panic
            &fee_token,
            &0i128,
            &MIN_ROTATION_TIMELOCK_LEDGERS,
            &MIN_UPGRADE_TIMELOCK_LEDGERS,
        ),
    );
}

#[test]
#[should_panic(expected = "oracle pk is the point at infinity")]
fn test_constructor_rejects_infinity_oracle_pk() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(&env, g2_infinity(), TEST_G2_TIMES_3, [0x11; 32]);
}

#[test]
#[should_panic(expected = "drand pk is the point at infinity")]
fn test_constructor_rejects_infinity_drand_pk() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(&env, TEST_G2_TIMES_2, g2_infinity(), [0x11; 32]);
}

#[test]
#[should_panic(expected = "oracle pk must not be the G2 generator")]
fn test_constructor_rejects_generator_as_oracle_pk() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(
        &env,
        crate::BLS12_381_G2_GENERATOR,
        TEST_G2_TIMES_3,
        [0x11; 32],
    );
}

#[test]
#[should_panic(expected = "drand pk must not be the G2 generator")]
fn test_constructor_rejects_generator_as_drand_pk() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(
        &env,
        TEST_G2_TIMES_2,
        crate::BLS12_381_G2_GENERATOR,
        [0x11; 32],
    );
}

#[test]
#[should_panic]
fn test_constructor_rejects_non_point_oracle_pk() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(&env, [0x02; 192], TEST_G2_TIMES_3, [0x11; 32]);
}

#[test]
#[should_panic]
fn test_constructor_rejects_off_curve_oracle_pk() {
    let env = Env::default();
    env.mock_all_auths();
    let mut p = TEST_G2_TIMES_2;
    p[191] ^= 0x01;
    try_construct(&env, p, TEST_G2_TIMES_3, [0x11; 32]);
}

#[test]
#[should_panic(expected = "oracle pk must differ from drand pk")]
fn test_constructor_rejects_identical_oracle_and_drand_pk() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(&env, TEST_G2_TIMES_2, TEST_G2_TIMES_2, [0x11; 32]);
}

#[test]
#[should_panic(expected = "oracle ed25519 key must not be all zero")]
fn test_constructor_rejects_zero_ed25519() {
    let env = Env::default();
    env.mock_all_auths();
    try_construct(&env, TEST_G2_TIMES_2, TEST_G2_TIMES_3, [0u8; 32]);
}

#[test]
fn test_canonical_generator_and_test_keys_are_valid() {
    let env = Env::default();
    use soroban_sdk::crypto::bls12_381::Bls12381G2Affine;
    let _gen = Bls12381G2Affine::from_bytes(BytesN::from_array(&env, &crate::BLS12_381_G2_GENERATOR));
    crate::validate_g2_public_key(&env, &BytesN::from_array(&env, &TEST_G2_TIMES_2), "test key 2");
    crate::validate_g2_public_key(&env, &BytesN::from_array(&env, &TEST_G2_TIMES_3), "test key 3");
    crate::validate_g2_public_key(&env, &BytesN::from_array(&env, &TEST_G2_TIMES_5), "test key 5");
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST & CALLBACK VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "callback_contract must be the requester")]
fn test_request_with_callback_mismatched_requester_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let different = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    client.request_with_callback(
        &context,
        &requester,
        &different,
        &soroban_sdk::Symbol::new(&env, "on_vrf"),
    );
}

#[test]
fn test_is_refunded_initially_false() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);
    assert!(!client.is_refunded(&id));
}

#[test]
fn test_property_empty_context_allowed() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::new(&env);
    let id = client.request(&context, &requester);
    assert_eq!(id, 1);
}

#[test]
fn test_property_exact_max_context_boundary_allowed() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let buf = [0x55u8; 1024];
    let context = Bytes::from_slice(&env, &buf);
    let id = client.request(&context, &requester);
    assert_eq!(id, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULFILL VALIDATION & REPLAY DEFENSE
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "already fulfilled")]
fn test_fulfill_duplicate_rejected() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"dup_test");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
    });

    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 2,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "drand round mismatch")]
fn test_fulfill_wrong_round_rejected() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"wrong_round");
    let id = client.request(&context, &requester);

    let wrong_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 9999, // mismatch
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &wrong_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "oracle key mismatch")]
fn test_fulfill_wrong_pk_rejected() {
    let (env, client, _admin, _addr, _oracle_pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"wrong_pk");
    let id = client.request(&context, &requester);

    let wrong_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: BytesN::from_array(&env, &TEST_G2_TIMES_5), // wrong key
        drand_round: 2,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &wrong_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "request epoch missing")]
fn test_fulfill_nonexistent_request_rejected() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 0,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&9999u64, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "request refunded")]
fn test_property_fulfill_after_timeout_refund_rejected() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"refund_replay");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Refunded(id), &true);
    });

    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 2,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "request epoch missing")]
fn test_property_fulfill_request_id_zero_rejected() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 0,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&0u64, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "request epoch missing")]
fn test_property_fulfill_request_id_max_rejected() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 0,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&u64::MAX, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "fulfill already in progress")]
fn test_property_fulfilling_guard_blocks_concurrent_fulfill() {
    let (env, client, _admin, _addr, oracle_pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"reentrancy_test");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilling(id), &true);
    });

    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 2,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &dummy_proof, &dummy_sig);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMEOUT REFUND BOUNDARIES
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "already refunded")]
fn test_timeout_refund_double_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);

    env.ledger().with_mut(|li| {
        li.timestamp = 1_692_803_367 + 100;
    });

    client.timeout_refund(&id);
    client.timeout_refund(&id); // second refund must panic
}

#[test]
#[should_panic(expected = "request not found")]
fn test_property_timeout_refund_request_id_zero_rejected() {
    let (_env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    client.timeout_refund(&0u64);
}

#[test]
#[should_panic(expected = "request not found")]
fn test_property_timeout_refund_request_id_max_rejected() {
    let (_env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    client.timeout_refund(&u64::MAX);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP PROOF TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "request not yet fulfilled")]
fn test_cleanup_proof_unfulfilled_rejected() {
    let (env, client, _admin, oracle_addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"cleanup_unfulfilled");
    let id = client.request(&context, &requester);

    client.cleanup_proof(&id, &oracle_addr);
}

#[test]
#[should_panic(expected = "only requester or oracle can cleanup")]
fn test_cleanup_proof_unauthorized_rejected() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let attacker = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"cleanup_unauth");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
    });

    client.cleanup_proof(&id, &attacker);
}

#[test]
fn test_cleanup_proof_retains_fulfilled_flag() {
    let (env, client, _admin, oracle_addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"cleanup_preserve");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
    });

    client.cleanup_proof(&id, &oracle_addr);
    assert!(client.is_fulfilled(&id));
    assert_eq!(client.request_epoch(&id), 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RANDOMNESS DERIVATION & UNIFORM REJECTION SAMPLING
// ═══════════════════════════════════════════════════════════════════════════════

fn pow128_mod(max: u64) -> u128 {
    0u128.wrapping_sub(max as u128) % (max as u128)
}

fn hash_from_halves(c1: u128, c2: u128) -> [u8; 32] {
    let mut h = [0u8; 32];
    h[..16].copy_from_slice(&c1.to_be_bytes());
    h[16..].copy_from_slice(&c2.to_be_bytes());
    h
}

#[test]
#[should_panic(expected = "request not yet fulfilled")]
fn test_derive_random_requires_fulfillment() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);
    client.derive_random(&id);
}

#[test]
#[should_panic(expected = "request not yet fulfilled")]
fn test_get_beta_requires_fulfillment() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);
    client.get_beta(&id);
}

#[test]
fn test_derive_random_in_range_bounds() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);

    for i in 0u64..3 {
        let context = Bytes::from_slice(&env, format!("range_ctx_{}", i).as_bytes());
        let id = client.request(&context, &requester);

        use crate::DataKey;
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::Fulfilled(id), &true);
            env.storage().persistent().set(
                &DataKey::Beta(id),
                &BytesN::from_array(&env, &[i as u8 * 31; 32]),
            );
        });
        let max: u64 = 100;
        let result = client.derive_random_in_range(&id, &max);
        assert!(result < max);
    }
}

#[test]
fn test_derive_random_in_range_is_deterministic() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(
            &DataKey::Beta(id),
            &BytesN::from_array(&env, &[0x42; 32]),
        );
    });

    let res1 = client.derive_random_in_range(&id, &1000);
    let res2 = client.derive_random_in_range(&id, &1000);
    assert_eq!(res1, res2);
}

#[test]
fn test_derive_range_for_domain_separates_draws() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(
            &DataKey::Beta(id),
            &BytesN::from_array(&env, &[0x33; 32]),
        );
    });

    let max = 1_000_000u64;
    let d1 = Bytes::from_slice(&env, b"loot_roll");
    let d2 = Bytes::from_slice(&env, b"damage_roll");
    let r1 = client.derive_range_for_domain(&id, &d1, &max);
    let r2 = client.derive_range_for_domain(&id, &d2, &max);
    assert_ne!(r1, r2);
}

#[test]
#[should_panic(expected = "max must be > 0")]
fn test_derive_range_for_domain_rejects_zero_max() {
    let (env, client, _admin, _addr, _pk, _ed, _drand_pk) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"ctx");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(
            &DataKey::Beta(id),
            &BytesN::from_array(&env, &[0x33; 32]),
        );
    });

    let d = Bytes::from_slice(&env, b"test");
    client.derive_range_for_domain(&id, &d, &0u64);
}

#[test]
fn test_reduce_uniform_uses_first_candidate_when_accepted() {
    let max = 1_000_003u64;
    let h = hash_from_halves(123_456_789, 42);
    assert_eq!(
        crate::reduce_uniform(&h, max),
        (123_456_789u128 % max as u128) as u64
    );
}

#[test]
fn test_reduce_uniform_falls_back_to_second_candidate() {
    let max = (1u64 << 63) + 1;
    assert!(pow128_mod(max) > 0);
    let h = hash_from_halves(u128::MAX, 7);
    assert_eq!(crate::reduce_uniform(&h, max), 7);
}

#[test]
fn test_reduce_uniform_limit_boundary() {
    let max = 3u64;
    let rem = pow128_mod(max);
    assert_eq!(rem, 1);
    let last_accepted = u128::MAX - rem;
    let h = hash_from_halves(last_accepted, 0);
    assert_eq!(crate::reduce_uniform(&h, max), (last_accepted % 3) as u64);
    let h = hash_from_halves(u128::MAX, 5);
    assert_eq!(
        crate::reduce_uniform(&h, max),
        2,
        "limit rejected, second half used"
    );
}

#[test]
#[should_panic(expected = "range derivation failed: both candidates rejected")]
fn test_reduce_uniform_both_rejected_panics() {
    let h = hash_from_halves(u128::MAX, u128::MAX);
    crate::reduce_uniform(&h, (1u64 << 63) + 1);
}

#[test]
fn test_reduce_uniform_power_of_two_never_rejects() {
    for shift in [1u32, 7, 32, 63] {
        let max = 1u64 << shift;
        assert_eq!(pow128_mod(max), 0);
        let h = hash_from_halves(u128::MAX, u128::MAX);
        assert_eq!(
            crate::reduce_uniform(&h, max),
            (u128::MAX % max as u128) as u64
        );
    }
}

#[test]
fn test_reduce_uniform_model_is_exactly_uniform() {
    for max in 2u32..=97 {
        let rem = 256 % max;
        let limit = 256 - rem;
        let mut counts = alloc::vec![0u32; max as usize];
        for c in 0..limit {
            counts[(c % max) as usize] += 1;
        }
        assert!(
            counts.iter().all(|&n| n == counts[0]),
            "bias for max={}",
            max
        );
        assert_eq!(limit % max, 0);
    }
}
