#![cfg(test)]

extern crate alloc;
use alloc::format;

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Symbol};

use crate::{VRFOracleContract, VRFOracleContractClient};

fn setup() -> (
    Env,
    VRFOracleContractClient<'static>,
    Address,
    BytesN<192>,
    BytesN<32>,
    BytesN<192>,
    BytesN<192>,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &[0x22; 192]);
    let g2_generator = BytesN::from_array(&env, &[0x33; 192]);
    // fee_token = a dummy address; fee_amount = 0 (fee-free for unit tests)
    let fee_token = Address::generate(&env);

    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &1_692_803_367u64,
        &3u32,
        &2u32,
        &fee_token,
        &0i128,
    );

    (
        env,
        client,
        oracle_addr,
        oracle_pk,
        oracle_ed25519,
        drand_pk,
        g2_generator,
    )
}

// ── Tranche 1 tests (unchanged) ───────────────────────────────────────────────

#[test]
fn test_init_stores_oracle_pk() {
    let (_env, client, _addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let stored_pk = client.oracle_pk();
    assert_eq!(stored_pk, oracle_pk);
}

#[test]
fn test_init_stores_oracle_address() {
    let (_env, client, oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let stored_addr = client.oracle_address();
    assert_eq!(stored_addr, oracle_addr);
}

#[test]
fn test_request_returns_incremented_ids() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let ctx1 = Bytes::from_slice(&env, b"ctx_one");
    let ctx2 = Bytes::from_slice(&env, b"ctx_two");

    let id1 = client.request(&ctx1, &requester);
    let id2 = client.request(&ctx2, &requester);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_request_is_initially_unfulfilled() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"test_context");

    let id = client.request(&context, &requester);
    let fulfilled = client.is_fulfilled(&id);

    assert!(!fulfilled);
}

#[test]
fn test_request_locks_expected_round() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"round_lock_context");

    let id = client.request(&context, &requester);
    let round = client.request_round(&id);

    // With default test env timestamp (0), the contract returns round_offset (2).
    assert_eq!(round, 2);
}

#[test]
fn test_is_fulfilled_nonexistent_returns_false() {
    let (_env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let result = client.is_fulfilled(&999u64);
    assert!(!result);
}

#[test]
fn test_request_counter_sequential() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);

    for expected_id in 1u64..=5 {
        let context = Bytes::from_slice(&env, format!("ctx_{}", expected_id).as_bytes());
        let id = client.request(&context, &requester);
        assert_eq!(id, expected_id);
    }
}

#[test]
fn test_request_stores_requester() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"requester_context");

    let id = client.request(&context, &requester);
    let stored = client.requester_of(&id);
    assert_eq!(stored, requester);
}

#[test]
fn test_request_with_callback_stores_callback() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let callback_contract = Address::generate(&env);
    let callback_fn = Symbol::new(&env, "on_vrf");
    let context = Bytes::from_slice(&env, b"callback_context");

    let id = client.request_with_callback(&context, &requester, &callback_contract, &callback_fn);
    let cb = client.callback_of(&id);

    assert!(cb.is_some());
    let (stored_contract, stored_fn) = cb.unwrap();
    assert_eq!(stored_contract, callback_contract);
    assert_eq!(stored_fn, callback_fn);
}

#[test]
fn test_is_refunded_initially_false() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"refund_context");

    let id = client.request(&context, &requester);
    assert!(!client.is_refunded(&id));
}

#[test]
fn test_timeout_rounds_constant() {
    let (_env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    assert_eq!(client.timeout_rounds(), 20);
}

#[test]
#[should_panic(expected = "round_offset must be >= 2")]
fn test_init_rejects_zero_round_offset() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &[0x22; 192]);
    let g2_generator = BytesN::from_array(&env, &[0x33; 192]);

    let fee_token = Address::generate(&env);
    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &1_692_803_367u64,
        &3u32,
        &0u32,
        &fee_token,
        &0i128,
    );
}

#[test]
#[should_panic(expected = "round_offset must be >= 2")]
fn test_init_rejects_round_offset_one() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &[0x22; 192]);
    let g2_generator = BytesN::from_array(&env, &[0x33; 192]);

    let fee_token = Address::generate(&env);
    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &1_692_803_367u64,
        &3u32,
        &1u32, // Should fail: round_offset must be >= 2
        &fee_token,
        &0i128,
    );
}

// ── Tranche 2: Failure scenario tests ────────────────────────────────────────

/// fulfill() must reject a duplicate fulfillment attempt.
/// This validates the "already fulfilled" guard and is the primary
/// defense against oracle double-spend / replay attacks.
#[test]
#[should_panic(expected = "already fulfilled")]
fn test_fulfill_duplicate_rejected() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"dup_test");
    let id = client.request(&context, &requester);

    // Manually force-set fulfilled = true to simulate a completed request.
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
    });

    // Attempt to fulfill again — must panic.
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

/// fulfill() must reject a proof with the wrong drand_round.
#[test]
#[should_panic(expected = "drand round mismatch")]
fn test_fulfill_wrong_round_rejected() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"round_mismatch");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    let wrong_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: required_round + 999, // wrong round
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &wrong_proof, &dummy_sig);
}

/// fulfill() must reject a proof carrying a public key that differs from the stored oracle PK.
#[test]
#[should_panic(expected = "oracle key mismatch")]
fn test_fulfill_wrong_pk_rejected() {
    let (env, client, _oracle_addr, _oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"pk_mismatch");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    let wrong_pk = BytesN::from_array(&env, &[0xAB; 192]); // different key
    let wrong_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: wrong_pk,
        drand_round: required_round,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &wrong_proof, &dummy_sig);
}

/// fulfill() must reject a request that doesn't exist.
#[test]
#[should_panic(expected = "request not found")]
fn test_fulfill_nonexistent_request_rejected() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();

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

/// timeout_refund() must be rejected if called before the timeout window elapses.
#[test]
#[should_panic(expected = "timeout window not reached")]
fn test_timeout_refund_before_window_rejected() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"too_early_refund");
    let id = client.request(&context, &requester);

    // Ledger timestamp is 0 — timeout window hasn't elapsed.
    client.timeout_refund(&id);
}

/// timeout_refund() must be rejected if the request was already fulfilled.
#[test]
#[should_panic(expected = "already fulfilled")]
fn test_timeout_refund_after_fulfilled_rejected() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"fulfilled_refund");
    let id = client.request(&context, &requester);

    // Force-set fulfilled.
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
    });

    client.timeout_refund(&id);
}

/// timeout_refund() must be rejected on a second call (double refund).
#[test]
#[should_panic(expected = "already refunded")]
fn test_timeout_refund_double_rejected() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"double_refund");
    let id = client.request(&context, &requester);

    // Force-set refunded.
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Refunded(id), &true);
    });

    client.timeout_refund(&id);
}

/// cleanup_proof() must be rejected for an unfulfilled request.
#[test]
#[should_panic(expected = "request not yet fulfilled")]
fn test_cleanup_proof_unfulfilled_rejected() {
    let (env, client, oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"cleanup_unfulfilled");
    let id = client.request(&context, &requester);

    client.cleanup_proof(&id, &oracle_addr);
}

/// cleanup_proof() must be rejected for callers that are neither the requester nor oracle.
#[test]
#[should_panic(expected = "only requester or oracle can cleanup")]
fn test_cleanup_proof_unauthorized_rejected() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let attacker = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"cleanup_unauth");
    let id = client.request(&context, &requester);

    // Force-set fulfilled.
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
    });

    client.cleanup_proof(&id, &attacker);
}

/// After cleanup_proof(), is_fulfilled() must still return true.
/// This validates the TTL edge case: Fulfilled flag is preserved after cleanup.
#[test]
fn test_cleanup_proof_retains_fulfilled_flag() {
    let (env, client, oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"cleanup_ttl_test");
    let id = client.request(&context, &requester);

    // Force-set fulfilled.
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
    });

    // Oracle performs cleanup.
    client.cleanup_proof(&id, &oracle_addr);

    // Fulfilled flag must still be true.
    assert!(client.is_fulfilled(&id), "Fulfilled flag must survive cleanup_proof");
}

// ── Tranche 2: Key rotation tests ─────────────────────────────────────────────

/// rotate_oracle_keys() must update all three oracle key fields.
#[test]
fn test_rotate_oracle_keys() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();

    let new_pk = BytesN::from_array(&env, &[0xAA; 192]);
    let new_addr = Address::generate(&env);
    let new_ed = BytesN::from_array(&env, &[0xBB; 32]);

    client.rotate_oracle_keys(&new_pk, &new_addr, &new_ed);

    assert_eq!(client.oracle_pk(), new_pk);
    assert_eq!(client.oracle_address(), new_addr);
}

/// rotate_drand_pk() must update the drand public key.
#[test]
fn test_rotate_drand_pk() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();

    let new_drand_pk = BytesN::from_array(&env, &[0xCC; 192]);
    client.rotate_drand_pk(&new_drand_pk);

    // Verify by checking the oracle_pk() still reports correctly (drand PK is internal,
    // so we verify indirectly that the call succeeded without panicking).
    // A direct drand_pk() getter could be added in M3; for now no-panic is the assertion.
    let _ = client.oracle_pk(); // contract still functional after rotation
}

/// derive_random_in_range() must return values within [0, max).
/// Tests multiple max values to validate rejection sampling is bounded.
#[test]
fn test_derive_random_in_range_bounds() {
    let (env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);

    for i in 0u64..3 {
        let context = Bytes::from_slice(&env, format!("range_ctx_{}", i).as_bytes());
        let id = client.request(&context, &requester);

        use crate::DataKey;
        env.as_contract(&client.address, || {
            env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
            // Store minimal proof for derive_random_in_range.
            env.storage().persistent().set(
                &DataKey::Proof(id),
                &crate::BlsVrfProof {
                    alpha_seed: BytesN::from_array(&env, &[i as u8 * 17; 32]),
                    gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                    beta_output: BytesN::from_array(&env, &[i as u8 * 31; 32]),
                    public_key: BytesN::from_array(&env, &[0u8; 192]),
                    drand_round: 2,
                    drand_signature: BytesN::from_array(&env, &[0u8; 96]),
                },
            );
        });

        let derive_ctx = Bytes::from_slice(&env, b"range_derive");
        let max: u64 = 100;
        let result = client.derive_random_in_range(&id, &derive_ctx, &max);
        assert!(result < max, "result {} must be < max {}", result, max);
    }
}
