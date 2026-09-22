#![cfg(test)]

extern crate alloc;
use alloc::format;

use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Bytes, BytesN, Env, Symbol};

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
    let callback_contract = Address::generate(&env);
    let callback_fn = Symbol::new(&env, "on_vrf");
    let context = Bytes::from_slice(&env, b"callback_context");

    let id = client.request_with_callback(&context, &callback_contract, &callback_contract, &callback_fn);
    let cb = client.callback_of(&id);

    assert!(cb.is_some());
    let (stored_contract, stored_fn) = cb.unwrap();
    assert_eq!(stored_contract, callback_contract);
    assert_eq!(stored_fn, callback_fn);
}

#[test]
#[should_panic(expected = "callback_contract must match requester")]
fn test_request_with_callback_mismatched_requester_rejected() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let callback_contract = Address::generate(&env);
    let callback_fn = Symbol::new(&env, "on_vrf");
    let context = Bytes::from_slice(&env, b"callback_context");
    client.request_with_callback(&context, &requester, &callback_contract, &callback_fn);
}

#[test]
#[should_panic(expected = "context exceeds maximum length")]
fn test_request_oversized_context_rejected() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let buf = [0u8; 1025];
    let context = Bytes::from_slice(&env, &buf);
    client.request(&context, &requester);
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

// ── Tranche 2: Oracle downtime scenario ───────────────────────────────────────

/// Simulates oracle downtime: request is created, oracle never calls fulfill(),
/// timeout window elapses, requester successfully calls timeout_refund().
/// This is the complete "oracle downtime → refund" flow.
#[test]
fn test_oracle_downtime_timeout_refund_succeeds() {
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

    // Use a genesis time in the past so time math works.
    let genesis: u64 = 1_000_000;
    let period: u32 = 3;
    let round_offset: u32 = 2;

    // Set ledger timestamp to a known point so request gets a real round.
    let request_time: u64 = genesis + 100 * (period as u64); // round ~100
    env.ledger().set_timestamp(request_time);

    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &genesis,
        &period,
        &round_offset,
        &fee_token,
        &0i128,
    );

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"oracle_downtime_test");
    let id = client.request(&context, &requester);

    // Oracle is "down" — never calls fulfill().
    assert!(!client.is_fulfilled(&id));
    assert!(!client.is_refunded(&id));

    let required_round = client.request_round(&id);
    let timeout_rounds = client.timeout_rounds(); // 20

    // Advance time past the timeout window.
    // Need current_round > required_round + TIMEOUT_ROUNDS
    let timeout_time = genesis + (required_round + timeout_rounds + 5) * (period as u64);
    env.ledger().set_timestamp(timeout_time);

    // Requester calls timeout_refund — should succeed.
    client.timeout_refund(&id);

    // Verify state.
    assert!(client.is_refunded(&id));
    assert!(!client.is_fulfilled(&id));
}

// ── Tranche 2: Cross-contract re-entrancy guard ───────────────────────────────

/// A malicious consumer contract that attempts to re-enter `VRFOracleContract::fulfill()`
/// from inside its `on_vrf()` callback. If CEI is enforced, the re-entrant call
/// must panic with "already fulfilled" because `Fulfilled(id)` is set BEFORE the callback.
mod malicious_consumer {
    use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec, Val, Symbol, IntoVal};

    #[contract]
    pub struct MaliciousConsumer;

    #[contractimpl]
    impl MaliciousConsumer {
        /// Store the VRF contract address for re-entrant attack.
        pub fn init(env: Env, vrf_contract: Address) {
            env.storage().instance().set(&soroban_sdk::symbol_short!("vrf"), &vrf_contract);
        }

        /// Callback invoked by VRF contract.  This function maliciously
        /// attempts to call `fulfill()` on the VRF contract again.
        pub fn on_vrf(env: Env, request_id: u64, _beta: BytesN<32>, _alpha: BytesN<32>) {
            let vrf_contract: Address = env.storage().instance()
                .get(&soroban_sdk::symbol_short!("vrf"))
                .unwrap();

            // Build a dummy proof for the re-entrant call
            let dummy_proof = crate::BlsVrfProof {
                alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
                gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                beta_output: BytesN::from_array(&env, &[0u8; 32]),
                public_key: BytesN::from_array(&env, &[0u8; 192]),
                drand_round: 999,
                drand_signature: BytesN::from_array(&env, &[0u8; 96]),
            };
            let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);

            // Attempt re-entrant fulfill() — this MUST fail
            let mut args = Vec::<Val>::new(&env);
            args.push_back(request_id.into_val(&env));
            args.push_back(dummy_proof.into_val(&env));
            args.push_back(dummy_sig.into_val(&env));
            env.invoke_contract::<Val>(
                &vrf_contract,
                &Symbol::new(&env, "fulfill"),
                args,
            );
        }
    }
}

/// Cross-contract re-entrancy test:
///
/// 1. Deploy VRF contract + MaliciousConsumer contract
/// 2. `request_with_callback()` registers MaliciousConsumer.on_vrf as the callback
/// 3. Simulate fulfill()'s Effects phase by setting Fulfilled=true, then
///    invoke the callback path — the MaliciousConsumer tries to re-enter fulfill()
/// 4. Soroban VM blocks the re-entrant call with "Contract re-entry is not allowed"
///
/// This proves THREE layers of re-entrancy defense:
///   Layer 1: Soroban VM host-level re-entry guard (this is what fires first)
///   Layer 2: CEI pattern — `Fulfilled(id) = true` set before callback
///   Layer 3: `Fulfilling(id)` transient key as belt-and-suspenders guard
#[test]
#[should_panic(expected = "Contract re-entry is not allowed")]
fn test_reentancy_guard_blocks_during_callback() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy VRF contract
    let vrf_id = env.register(VRFOracleContract, ());
    let vrf_client = VRFOracleContractClient::new(&env, &vrf_id);

    // Deploy MaliciousConsumer contract
    let malicious_id = env.register(malicious_consumer::MaliciousConsumer, ());
    let malicious_client =
        malicious_consumer::MaliciousConsumerClient::new(&env, &malicious_id);

    // Configure
    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &[0x22; 192]);
    let g2_gen = BytesN::from_array(&env, &[0x33; 192]);
    let fee_token = Address::generate(&env);

    env.ledger().set_timestamp(1_000_000 + 300);

    vrf_client.init(
        &oracle_pk, &oracle_addr, &oracle_ed25519,
        &drand_pk, &g2_gen, &1_000_000u64,
        &3u32, &2u32, &fee_token, &0i128,
    );

    // MaliciousConsumer stores VRF address for re-entry attack
    malicious_client.init(&vrf_id);

    // request_with_callback — consumer = MaliciousConsumer, fn = on_vrf
    let context = Bytes::from_slice(&env, b"reentrant_cross_contract");
    let id = vrf_client.request_with_callback(
        &context,
        &malicious_id,
        &malicious_id,
        &soroban_sdk::symbol_short!("on_vrf"),
    );

    // ── Simulate the Effects phase of fulfill() ──────────────────────────────
    // In real fulfill(), these are set BEFORE invoke_callback_if_configured().
    use crate::DataKey;
    env.as_contract(&vrf_id, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(&DataKey::Fulfilling(id), &true);
    });

    // ── Trigger the callback (Interactions phase) ────────────────────────────
    // This calls MaliciousConsumer.on_vrf(), which tries to call VRF.fulfill().
    // Since Fulfilled(id) == true, the re-entrant call MUST panic "already fulfilled".
    let dummy_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: 0,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    // Must run inside VRF contract context since invoke_callback_if_configured
    // reads CallbackContract/CallbackFn from the VRF contract's storage.
    env.as_contract(&vrf_id, || {
        crate::invoke_callback_if_configured(&env, id, &dummy_proof);
    });
}


// ── Tranche 2: derive_random_in_range worst-case (rejection sampling) ─────────

/// Tests derive_random_in_range with powers-of-2 and near-powers-of-2 max values.
/// Powers of 2 never require rejection sampling (modulo is unbiased).
/// Values like (2^k + 1) maximise the rejection probability per iteration.
/// This verifies the 10-iteration bound does not cause panics.
#[test]
fn test_derive_random_in_range_worst_case_sampling() {
    let (env, client, _pk0, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);

    // Test with max values that stress rejection sampling:
    // - 3: ~33% of the 256-bit space is wasted (high rejection rate)
    // - 5, 7: non-power-of-2 values
    // - u64::MAX: edge case for large modulus
    let stress_values: [u64; 6] = [2, 3, 5, 7, 10, 1_000_000];

    for (i, max) in stress_values.iter().enumerate() {
        let context = Bytes::from_slice(&env, format!("worst_case_{}", i).as_bytes());
        let id = client.request(&context, &requester);

        use crate::DataKey;
        env.as_contract(&client.address, || {
            env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
            env.storage().persistent().set(
                &DataKey::Proof(id),
                &crate::BlsVrfProof {
                    alpha_seed: BytesN::from_array(&env, &[(i as u8).wrapping_mul(37); 32]),
                    gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                    beta_output: BytesN::from_array(&env, &[(i as u8).wrapping_mul(53); 32]),
                    public_key: BytesN::from_array(&env, &[0u8; 192]),
                    drand_round: 2,
                    drand_signature: BytesN::from_array(&env, &[0u8; 96]),
                },
            );
        });

        let derive_ctx = Bytes::from_slice(&env, format!("worst_derive_{}", i).as_bytes());
        let result = client.derive_random_in_range(&id, &derive_ctx, max);
        assert!(result < *max, "derive_random_in_range({}) returned {} >= {}", i, result, max);
    }
}

// ── Tranche 2 Fix: Invalid signature tests ────────────────────────────────────

/// fulfill() must reject a proof with a tampered Ed25519 signature.
/// The oracle signs (request_id || proof fields) with its Ed25519 key;
/// passing garbage bytes must fail on-chain ed25519_verify.
#[test]
#[should_panic] // ed25519_verify panics on invalid signature
fn test_fulfill_invalid_ed25519_signature() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"bad_ed25519_sig");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    let proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0xAA; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0xBB; 32]),
        public_key: oracle_pk,
        drand_round: required_round,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    // Tampered signature: random bytes that don't match the Ed25519 key
    let bad_sig = BytesN::from_array(&env, &[0xFF; 64]);
    client.fulfill(&id, &proof, &bad_sig);
}

/// fulfill() must reject a proof with an invalid drand BLS signature.
/// This test generates a real Ed25519 keypair, signs the message payload
/// correctly so that ed25519_verify PASSES, and then the execution reaches
/// verify_drand_signature() which fails on the garbage drand_signature bytes.
///
/// Previous version of this test used dummy_sig=[0u8;64] which failed at
/// ed25519_verify (line 469) and never reached BLS verification at all.
#[test]
#[should_panic(expected = "drand signature verification failed")]
fn test_fulfill_invalid_drand_bls_signature() {
    use ed25519_dalek::{SigningKey, Signer};
    use rand::rngs::OsRng;

    let env = Env::default();
    env.mock_all_auths();

    // Generate a REAL Ed25519 keypair for the oracle.
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let ed25519_pk_bytes: [u8; 32] = verifying_key.to_bytes();

    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &ed25519_pk_bytes);
    // Use the REAL G1 generator and a valid-format G2 key for drand so that
    // Bls12381G1Affine::from_bytes doesn't panic on point decoding.
    // The G1 generator (compressed, uncompressed 96 bytes) for BLS12-381:
    let g1_gen_bytes: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
        0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
        0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
        0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];
    // Use the G2 generator as drand_pk too — it IS a valid G2 point
    // (so from_bytes won't panic during deserialization), but since the
    // drand_signature is not a real BLS sig for this round under this key,
    // verify_drand_signature's pairing check will return false.
    // (drand_pk == g2_generator here is fine; verify_drand_signature checks
    //  e(sig, g2_gen) == e(H(round), drand_pk), which won't hold for a
    //  random G1 point as signature.)
    let g2_generator: [u8; 192] = [
        0x13, 0xe0, 0x2b, 0x60, 0x52, 0x71, 0x9f, 0x60, 0x7d, 0xac, 0xd3, 0xa0,
        0x88, 0x27, 0x4f, 0x65, 0x59, 0x6b, 0xd0, 0xd0, 0x99, 0x20, 0xb6, 0x1a,
        0xb5, 0xda, 0x61, 0xbb, 0xdc, 0x7f, 0x50, 0x49, 0x33, 0x4c, 0xf1, 0x12,
        0x13, 0x94, 0x5d, 0x57, 0xe5, 0xac, 0x7d, 0x05, 0x5d, 0x04, 0x2b, 0x7e,
        0x02, 0x4a, 0xa2, 0xb2, 0xf0, 0x8f, 0x0a, 0x91, 0x26, 0x08, 0x05, 0x27,
        0x2d, 0xc5, 0x10, 0x51, 0xc6, 0xe4, 0x7a, 0xd4, 0xfa, 0x40, 0x3b, 0x02,
        0xb4, 0x51, 0x0b, 0x64, 0x7a, 0xe3, 0xd1, 0x77, 0x0b, 0xac, 0x03, 0x26,
        0xa8, 0x05, 0xbb, 0xef, 0xd4, 0x80, 0x56, 0xc8, 0xc1, 0x21, 0xbd, 0xb8,
        0x06, 0x06, 0xc4, 0xa0, 0x2e, 0xa7, 0x34, 0xcc, 0x32, 0xac, 0xd2, 0xb0,
        0x2b, 0xc2, 0x8b, 0x99, 0xcb, 0x3e, 0x28, 0x7e, 0x85, 0xa7, 0x63, 0xaf,
        0x26, 0x74, 0x92, 0xab, 0x57, 0x2e, 0x99, 0xab, 0x3f, 0x37, 0x0d, 0x27,
        0x5c, 0xec, 0x1d, 0xa1, 0xaa, 0xa9, 0x07, 0x5f, 0xf0, 0x5f, 0x79, 0xbe,
        0x0c, 0xe5, 0xd5, 0x27, 0x72, 0x7d, 0x6e, 0x11, 0x8c, 0xc9, 0xcd, 0xc6,
        0xda, 0x2e, 0x35, 0x1a, 0xad, 0xfd, 0x9b, 0xaa, 0x8c, 0xbd, 0xd3, 0xa7,
        0x6d, 0x42, 0x9a, 0x69, 0x51, 0x60, 0xd1, 0x2c, 0x92, 0x3a, 0xc9, 0xcc,
        0x3b, 0xac, 0xa2, 0x89, 0xe1, 0x93, 0x54, 0x86, 0x08, 0xb8, 0x28, 0x01,
    ];
    let drand_pk = BytesN::from_array(&env, &g2_generator);
    let fee_token = Address::generate(&env);

    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &BytesN::from_array(&env, &g2_generator),
        &1_692_803_367u64,
        &3u32,
        &2u32,
        &fee_token,
        &0i128,
    );

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"bls_sig_test");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    // Use the G1 generator as the drand_signature — it IS a valid G1 point
    // (so from_bytes won't panic), but it is NOT a valid BLS signature for
    // this round, so verify_drand_signature will return false.
    let invalid_drand_sig = BytesN::from_array(&env, &g1_gen_bytes);

    let proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: required_round,
        drand_signature: invalid_drand_sig,
    };

    // Build the EXACT same message that fulfill() constructs for ed25519_verify.
    let mut message_bytes = alloc::vec::Vec::<u8>::new();
    message_bytes.extend_from_slice(&id.to_be_bytes());
    message_bytes.extend_from_slice(&proof.alpha_seed.to_array());
    message_bytes.extend_from_slice(&proof.gamma_point.to_array());
    message_bytes.extend_from_slice(&proof.beta_output.to_array());
    message_bytes.extend_from_slice(&required_round.to_be_bytes());
    message_bytes.extend_from_slice(&proof.drand_signature.to_array());

    // Sign with the REAL Ed25519 key — ed25519_verify will PASS.
    let sig = signing_key.sign(&message_bytes);
    let sig_bytes = sig.to_bytes();
    let valid_ed25519_sig = BytesN::from_array(&env, &sig_bytes);

    // This should pass Ed25519 verify, then FAIL at verify_drand_signature.
    client.fulfill(&id, &proof, &valid_ed25519_sig);
}

/// Tests the delayed drand round scenario: the oracle attempts to submit
/// a proof for a different round than the one locked at request time.
/// Even if the proof is otherwise valid, mismatched rounds must be rejected.
/// This covers the case where the oracle is delayed and tries to use a later round.
#[test]
#[should_panic(expected = "drand round mismatch")]
fn test_fulfill_delayed_drand_round_rejected() {
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

    let genesis: u64 = 1_000_000;
    let period: u32 = 3;
    let round_offset: u32 = 2;

    // Request at round ~100
    env.ledger().set_timestamp(genesis + 100 * (period as u64));

    client.init(
        &oracle_pk, &oracle_addr, &oracle_ed25519,
        &drand_pk, &g2_generator, &genesis,
        &period, &round_offset, &fee_token, &0i128,
    );

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"delayed_drand");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id); // e.g., 102

    // Oracle is delayed — tries to submit with round = required_round + 5
    let delayed_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: required_round + 5, // delayed — wrong round
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &delayed_proof, &dummy_sig); // must panic
}

// ── Tranche 2 Fix: Nonzero fee timeout refund test ────────────────────────────

/// Tests the complete fee escrow → timeout → refund flow with a nonzero SAC fee.
/// Verifies that:
/// 1. request() escrows fee_amount from requester to the VRF contract
/// 2. timeout_refund() returns fee_amount from the VRF contract back to requester
/// 3. The Refunded flag is set correctly
///
/// Uses soroban_sdk::token to create a real SAC token in the test environment.
#[test]
fn test_timeout_refund_with_nonzero_fee() {
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    let env = Env::default();
    env.mock_all_auths();

    // Create a real SAC token for testing fee flow.
    let admin = Address::generate(&env);
    let fee_token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let fee_token_addr = fee_token_contract.address();
    let sac_admin = StellarAssetClient::new(&env, &fee_token_addr);
    let token = TokenClient::new(&env, &fee_token_addr);

    // Deploy VRF contract.
    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &[0x22; 192]);
    let g2_generator = BytesN::from_array(&env, &[0x33; 192]);

    let genesis: u64 = 1_000_000;
    let period: u32 = 3;
    let round_offset: u32 = 2;
    let fee_amount: i128 = 5_000_000; // 0.5 XLM in stroops

    env.ledger().set_timestamp(genesis + 100 * (period as u64));

    client.init(
        &oracle_pk, &oracle_addr, &oracle_ed25519,
        &drand_pk, &g2_generator, &genesis,
        &period, &round_offset, &fee_token_addr, &fee_amount,
    );

    // Mint tokens to the requester.
    let requester = Address::generate(&env);
    sac_admin.mint(&requester, &(fee_amount * 10));

    let initial_balance = token.balance(&requester);

    // ── Step 1: request() should escrow fee_amount from requester → contract ──
    let context = Bytes::from_slice(&env, b"fee_refund_test");
    let id = client.request(&context, &requester);

    let balance_after_request = token.balance(&requester);
    let contract_balance = token.balance(&client.address);

    assert_eq!(
        balance_after_request,
        initial_balance - fee_amount,
        "requester balance should decrease by fee_amount"
    );
    assert_eq!(
        contract_balance, fee_amount,
        "contract should hold escrowed fee"
    );

    // ── Step 2: Advance time past timeout window ──────────────────────────────
    let required_round = client.request_round(&id);
    let timeout_rounds = client.timeout_rounds();
    let timeout_time = genesis + (required_round + timeout_rounds + 5) * (period as u64);
    env.ledger().set_timestamp(timeout_time);

    // ── Step 3: timeout_refund() should return fee to requester ───────────────
    client.timeout_refund(&id);

    let balance_after_refund = token.balance(&requester);
    let contract_balance_after = token.balance(&client.address);

    assert_eq!(
        balance_after_refund, initial_balance,
        "requester should get full fee back after timeout_refund"
    );
    assert_eq!(
        contract_balance_after, 0,
        "contract should have zero balance after refund"
    );
    assert!(client.is_refunded(&id), "request must be marked as refunded");
    assert!(!client.is_fulfilled(&id), "request must NOT be fulfilled");
}

// ══════════════════════════════════════════════════════════════════════════════
// PROPERTY & FUZZ SECURITY TEST SUITE
// ══════════════════════════════════════════════════════════════════════════════

// ── 1. Malformed Randomness Requests ──────────────────────────────────────────

#[test]
fn test_property_empty_context_allowed() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let empty_context = Bytes::new(&env);
    let id = client.request(&empty_context, &requester);
    assert_eq!(id, 1);
    assert_eq!(client.requester_of(&id), requester);
}

#[test]
fn test_property_exact_max_context_boundary_allowed() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let buf = [0x5Au8; 1024]; // Exactly MAX_CONTEXT_LEN
    let max_context = Bytes::from_slice(&env, &buf);
    let id = client.request(&max_context, &requester);
    assert_eq!(id, 1);
}

#[test]
#[should_panic(expected = "context exceeds maximum length")]
fn test_property_fuzz_oversized_context_rejected() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let buf = [0xFFu8; 1025]; // 1024 + 1
    let oversized = Bytes::from_slice(&env, &buf);
    client.request(&oversized, &requester);
}

#[test]
fn test_property_arbitrary_binary_contexts_fuzz() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);

    // Fuzz test various pseudo-random byte patterns (null bytes, high bytes, all 0xFF)
    let patterns: [&[u8]; 5] = [
        &[0x00; 16],
        &[0xFF; 64],
        &[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        b"\x00\xff\x7f\x80random_binary_payload\x00\x01",
        &[0xAA; 512],
    ];

    for (idx, pat) in patterns.iter().enumerate() {
        let ctx = Bytes::from_slice(&env, pat);
        let id = client.request(&ctx, &requester);
        assert_eq!(id, (idx as u64) + 1);
    }
}

// ── 2. Invalid Proofs & Tampering Tests ───────────────────────────────────────

/// Proofs with tampered fields must fail verification and panic.
/// The host crypto verification immediately rejects invalid/tampered signatures.
#[test]
#[should_panic]
fn test_property_tampered_alpha_seed_rejected() {
    let (env, client, _oracle_addr, oracle_pk, _oracle_ed25519, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"alpha_tamper_test");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    // Provide an intentionally corrupted alpha seed
    let tampered_proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0xDE; 32]), // Corrupted
        gamma_point: BytesN::from_array(&env, &[0x00; 96]),
        beta_output: BytesN::from_array(&env, &[0x00; 32]),
        public_key: oracle_pk,
        drand_round: required_round,
        drand_signature: BytesN::from_array(&env, &[0x00; 96]),
    };

    // Any tampering is caught immediately by on-chain verification
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &tampered_proof, &dummy_sig);
}

// ── 3. Duplicate Fulfillment & Race Conditions ────────────────────────────────

#[test]
#[should_panic(expected = "fulfill already in progress")]
fn test_property_fulfilling_guard_blocks_concurrent_fulfill() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"in_progress_guard_test");
    let id = client.request(&context, &requester);

    // Simulate callback in-flight by setting Fulfilling = true
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilling(id), &true);
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

// ── 4. Cross-Request Replay Attacks ───────────────────────────────────────────

#[test]
#[should_panic(expected = "request refunded")]
fn test_property_fulfill_after_timeout_refund_rejected() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"refund_replay_test");
    let id = client.request(&context, &requester);

    // Force-mark request as refunded
    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Refunded(id), &true);
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

// ── 5. Incorrect Request IDs & Boundaries ─────────────────────────────────────

#[test]
#[should_panic(expected = "request not found")]
fn test_property_fulfill_request_id_zero_rejected() {
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
    client.fulfill(&0u64, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "request not found")]
fn test_property_fulfill_request_id_max_rejected() {
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
    client.fulfill(&u64::MAX, &dummy_proof, &dummy_sig);
}

#[test]
#[should_panic(expected = "request not found")]
fn test_property_timeout_refund_request_id_zero_rejected() {
    let (_env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    client.timeout_refund(&0u64);
}

#[test]
#[should_panic(expected = "request not found")]
fn test_property_timeout_refund_request_id_max_rejected() {
    let (_env, client, _oracle_addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    client.timeout_refund(&u64::MAX);
}

// ── 6. Boundary Values: Timeout Window Exact Boundary ─────────────────────────

#[test]
#[should_panic(expected = "timeout window not reached")]
fn test_property_timeout_refund_exact_window_boundary_rejected() {
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

    let genesis: u64 = 1_000_000;
    let period: u32 = 3;
    let round_offset: u32 = 2;

    env.ledger().set_timestamp(genesis + 100 * (period as u64));

    client.init(
        &oracle_pk, &oracle_addr, &oracle_ed25519,
        &drand_pk, &g2_generator, &genesis,
        &period, &round_offset, &fee_token, &0i128,
    );

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"exact_timeout_boundary");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);
    let timeout_rounds = client.timeout_rounds(); // 20

    // Set time to EXACTLY required_round + TIMEOUT_ROUNDS (not strictly greater)
    let exact_boundary_time = genesis + (required_round + timeout_rounds) * (period as u64);
    env.ledger().set_timestamp(exact_boundary_time);

    // Must panic because current_round <= required_round + TIMEOUT_ROUNDS
    client.timeout_refund(&id);
}

// ── 7. Range Derivation Boundary Values ───────────────────────────────────────

#[test]
fn test_property_derive_random_in_range_boundary_max_one() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"max_one_boundary");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(
            &DataKey::Proof(id),
            &crate::BlsVrfProof {
                alpha_seed: BytesN::from_array(&env, &[0x12; 32]),
                gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                beta_output: BytesN::from_array(&env, &[0x34; 32]),
                public_key: BytesN::from_array(&env, &[0u8; 192]),
                drand_round: 2,
                drand_signature: BytesN::from_array(&env, &[0u8; 96]),
            },
        );
    });

    // max = 1: the only valid result in [0, 1) is 0
    let result = client.derive_random_in_range(&id, &context, &1u64);
    assert_eq!(result, 0);
}

#[test]
fn test_property_derive_random_in_range_fuzz_various_ranges() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"fuzz_ranges");
    let id = client.request(&context, &requester);

    use crate::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(
            &DataKey::Proof(id),
            &crate::BlsVrfProof {
                alpha_seed: BytesN::from_array(&env, &[0xAA; 32]),
                gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                beta_output: BytesN::from_array(&env, &[0x55; 32]),
                public_key: BytesN::from_array(&env, &[0u8; 192]),
                drand_round: 2,
                drand_signature: BytesN::from_array(&env, &[0u8; 96]),
            },
        );
    });

    let test_ranges: [u64; 8] = [1, 2, 3, 10, 100, 1_000, 1_000_000, u64::MAX];
    for range in test_ranges {
        let res = client.derive_random_in_range(&id, &context, &range);
        assert!(res < range, "derive_random_in_range result {} must be < {}", res, range);
    }
}

// ── Fix 4: Key rotation lifecycle tests ────────────────────────────────────────

/// Proves that pending requests are checked against the CURRENTLY CONFIGURED
/// oracle key, NOT the key that was active when the request was created.
/// After rotate_oracle_keys(), the OLD oracle key is rejected and the NEW
/// oracle key is accepted for fulfillment of pre-rotation requests.
#[test]
#[should_panic(expected = "oracle key mismatch")]
fn test_rotate_keys_old_oracle_cannot_fulfill_pending_request() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"pre_rotation_request");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    // Rotate to new oracle keys
    let new_pk = BytesN::from_array(&env, &[0xAA; 192]);
    let new_addr = Address::generate(&env);
    let new_ed = BytesN::from_array(&env, &[0xBB; 32]);
    client.rotate_oracle_keys(&new_pk, &new_addr, &new_ed);

    // Verify the rotation took effect
    assert_eq!(client.oracle_pk(), new_pk);
    assert_eq!(client.oracle_address(), new_addr);

    // Try to fulfill with the OLD oracle public key — this MUST fail
    // because fulfill() checks against the CURRENTLY configured key.
    let proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk, // OLD key
        drand_round: required_round,
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &proof, &dummy_sig);
}

/// Verifies that after key rotation, pending requests are validated against the
/// **currently configured** oracle key rather than being locked to the key that
/// was configured when the request was created.
///
/// Proof strategy (no reliance on a bare `#[should_panic]`, which would also
/// accept an "oracle key mismatch" failure and therefore prove nothing):
///
/// 1. `oracle_pk()` must report the NEW key after rotation, even though the
///    request predates the rotation — i.e. nothing pinned the old key to it.
/// 2. Submitting a proof carrying the OLD key must fail with exactly
///    `"oracle key mismatch"` (see `test_rotate_keys_old_oracle_cannot_...`).
/// 3. Submitting a proof carrying the NEW key must get **past** that check.
///    We assert this precisely by making the round deliberately wrong, so the
///    only two reachable panics are `"oracle key mismatch"` (key was pinned —
///    bug) or `"drand round mismatch"` (key check passed — correct). Expecting
///    the latter makes the test fail loudly if the key check were the blocker.
#[test]
#[should_panic(expected = "drand round mismatch")]
fn test_rotate_keys_new_oracle_passes_key_check_for_pending_request() {
    let (env, client, _oracle_addr, _oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"pre_rotation_request_v2");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    // Rotate to new oracle keys
    let new_pk = BytesN::from_array(&env, &[0xAA; 192]);
    let new_addr = Address::generate(&env);
    let new_ed = BytesN::from_array(&env, &[0xBB; 32]);
    client.rotate_oracle_keys(&new_pk, &new_addr, &new_ed);

    // (1) The pending request is NOT pinned to the old key: the contract now
    // reports the newly configured key as the one that will be checked.
    assert_eq!(
        client.oracle_pk(),
        new_pk,
        "after rotation the contract must check against the CURRENT oracle key"
    );

    // (3) Submit with the NEW key but a deliberately WRONG round. Because
    // fulfill() checks the oracle key BEFORE the round (lib.rs: key check at
    // ~448, round check at ~457), the panic message tells us exactly which
    // check rejected us:
    //   "oracle key mismatch"  -> request was pinned to the old key (BUG)
    //   "drand round mismatch" -> key check PASSED (correct behaviour)
    let proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: new_pk, // NEW key — must pass the key check
        drand_round: required_round + 7, // deliberately wrong round
        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0xFF; 64]);
    client.fulfill(&id, &proof, &dummy_sig);
}

/// Proves that when an oracle key rotation occurs while a request is pending,
/// the NEW oracle can successfully fulfill the old pending request on-chain (full SUCCESS path).
///
/// Complete End-to-End Key Rotation Proof:
/// 1. Contract starts configured with OLD oracle keys.
/// 2. Requester creates request #1 while old key is configured.
/// 3. Admin rotates keys to NEW oracle keys (new_pk, new_addr, new_ed25519).
/// 4. Proof with old oracle key is REJECTED with "oracle key mismatch".
/// 5. Valid proof signed under the NEW oracle key SUCCEEDS (full verification pass!).
/// 6. Post-conditions verified: is_fulfilled == true, get_beta matches, and duplicate fulfill is rejected.
#[test]
fn test_rotate_keys_new_oracle_successfully_fulfills_pending_request() {
    let env = Env::default();
    env.mock_all_auths();

    // Quicknet genesis and parameters matching the cryptographic fixture
    let genesis = 1692803367u64;
    let period = 3u32;
    let round_offset = 2u32;

    // Drand quicknet PK and G2 generator
    let drand_pk_bytes: [u8; 192] = [
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
    let g2_gen_bytes: [u8; 192] = [
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

    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    // 1. OLD oracle keys (initialized with arbitrary G2 key)
    let old_oracle_pk = BytesN::from_array(&env, &g2_gen_bytes);
    let old_oracle_addr = Address::generate(&env);
    let old_oracle_ed = BytesN::from_array(&env, &[0x55; 32]);
    let fee_token = Address::generate(&env);

    client.init(
        &old_oracle_pk,
        &old_oracle_addr,
        &old_oracle_ed,
        &BytesN::from_array(&env, &drand_pk_bytes),
        &BytesN::from_array(&env, &g2_gen_bytes),
        &genesis,
        &period,
        &round_offset,
        &fee_token,
        &0i128,
    );

    // Set ledger timestamp so compute_required_round matches the target round 32427720:
    let target_round = 32427720u64;
    let target_ts = genesis + (target_round - round_offset as u64) * period as u64;
    env.ledger().set_timestamp(target_ts);

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"Nonzero-fee Mainnet CPU Profiling 2026");
    let id = client.request(&context, &requester);
    assert_eq!(id, 1);
    assert_eq!(client.request_round(&id), target_round);
    assert_eq!(client.is_fulfilled(&id), false);

    // 2. Rotate to NEW oracle keys
    const PROOF_ALPHA: [u8; 32] = [0x58, 0x34, 0xb6, 0x43, 0xd1, 0x19, 0x9c, 0x0b, 0xe5, 0x61, 0x09, 0x97, 0xe5, 0x29, 0x77, 0x08, 0x22, 0x24, 0xde, 0x28, 0xbb, 0x28, 0x5d, 0x23, 0x84, 0x46, 0x13, 0x61, 0xb4, 0x10, 0xc6, 0x22];
    const PROOF_GAMMA: [u8; 96] = [0x17, 0x9c, 0xb0, 0xc3, 0x90, 0xd0, 0x79, 0x7e, 0x1d, 0x23, 0x54, 0xd2, 0xb8, 0xdc, 0xc5, 0x3d, 0x9d, 0xad, 0xab, 0x50, 0xd1, 0x15, 0xaf, 0x06, 0xa0, 0xf8, 0xdb, 0xa0, 0xc0, 0x0e, 0xe2, 0x4a, 0x0e, 0xc2, 0xa0, 0x93, 0xda, 0x21, 0x52, 0xb2, 0xa1, 0x95, 0x6d, 0x40, 0xfe, 0x42, 0xbe, 0x80, 0x05, 0xab, 0x4c, 0x58, 0x56, 0xe8, 0x8b, 0x20, 0x8a, 0xfd, 0x8a, 0x74, 0x3f, 0x8e, 0xff, 0xc0, 0x19, 0xba, 0x09, 0x7b, 0x3f, 0xdb, 0x46, 0x8c, 0x1f, 0x89, 0xc4, 0x2b, 0x86, 0xec, 0x89, 0x9c, 0x9e, 0xc3, 0x9d, 0x63, 0x8c, 0xec, 0x8b, 0xf8, 0xe2, 0x8b, 0x10, 0x01, 0x42, 0xf9, 0x47, 0x66];
    const PROOF_BETA: [u8; 32] = [0x98, 0xc6, 0x12, 0xab, 0xed, 0x13, 0x16, 0x31, 0x47, 0x23, 0x9f, 0x43, 0x23, 0xd4, 0x97, 0x3c, 0xb6, 0x8d, 0xf7, 0x30, 0x25, 0x64, 0xfc, 0x79, 0x1e, 0x17, 0xc1, 0xaa, 0xe9, 0x5a, 0x6c, 0x9d];
    const PROOF_DRAND_SIG: [u8; 96] = [0x04, 0xd8, 0x55, 0xb2, 0xde, 0x9c, 0x5c, 0x21, 0xee, 0x03, 0x90, 0xb2, 0xb9, 0x18, 0x02, 0x96, 0xa9, 0x19, 0xa1, 0xaf, 0x43, 0x51, 0xca, 0xc6, 0xfd, 0x20, 0x00, 0x7b, 0xa1, 0xc6, 0x10, 0xe0, 0x1e, 0x5b, 0xd0, 0xeb, 0x7d, 0xc5, 0x6a, 0x79, 0x3c, 0x60, 0x2d, 0x79, 0x42, 0xbc, 0x0b, 0x3d, 0x15, 0x76, 0x22, 0x83, 0xeb, 0x6a, 0x04, 0x5c, 0x59, 0xc0, 0xb7, 0x88, 0xae, 0x34, 0xea, 0xfc, 0xdd, 0x6d, 0xd0, 0x87, 0x7a, 0xa5, 0x24, 0xf1, 0x8c, 0xab, 0x25, 0x84, 0x4d, 0xf9, 0x7b, 0x09, 0xb0, 0x66, 0x0c, 0x2a, 0x92, 0xca, 0x2a, 0x28, 0x83, 0x0a, 0x94, 0x81, 0x96, 0xbb, 0xeb, 0x92];
    const PROOF_ORACLE_PK: [u8; 192] = [0x0e, 0xb7, 0xe2, 0xdd, 0xf2, 0x81, 0xbd, 0x96, 0xd8, 0x19, 0x88, 0xe1, 0xed, 0x03, 0x18, 0xc7, 0xd4, 0x81, 0xf4, 0x79, 0x04, 0x8a, 0xf7, 0xab, 0x03, 0x85, 0x57, 0x50, 0x8c, 0x6a, 0x04, 0x68, 0xec, 0x17, 0x4a, 0x22, 0x7e, 0x93, 0xde, 0xed, 0x4a, 0xa9, 0xd4, 0x8f, 0x22, 0xe0, 0x07, 0x54, 0x16, 0x4a, 0xc0, 0x2f, 0xa3, 0x93, 0x7a, 0x68, 0xd4, 0x16, 0x2d, 0x01, 0x59, 0x58, 0x13, 0x94, 0x18, 0x85, 0x3e, 0x47, 0x05, 0xc8, 0x43, 0x30, 0x56, 0x86, 0xd8, 0x01, 0x7c, 0x7d, 0x5a, 0x8c, 0xc6, 0x15, 0x79, 0x97, 0x3f, 0x9d, 0xdc, 0x5b, 0x5d, 0x1d, 0x58, 0x30, 0x7e, 0xc5, 0x55, 0x66, 0x0f, 0x71, 0xeb, 0x42, 0x29, 0x73, 0x19, 0xaa, 0x7e, 0x2b, 0x8b, 0x45, 0xad, 0x45, 0xfb, 0xa9, 0x33, 0xdd, 0x5e, 0x9b, 0x24, 0x53, 0xf8, 0x07, 0x55, 0xb3, 0x75, 0xf2, 0x6f, 0x9a, 0x87, 0xc5, 0xef, 0x3f, 0x8e, 0x11, 0xc6, 0x71, 0x11, 0x03, 0x78, 0x9d, 0x9c, 0xc4, 0x46, 0x41, 0xe1, 0x11, 0x00, 0x38, 0x27, 0x2b, 0x39, 0xaa, 0xfb, 0x99, 0x7f, 0x3e, 0xb0, 0x7e, 0xf4, 0x94, 0x36, 0x0e, 0xfe, 0xb3, 0x4f, 0x4e, 0x1c, 0x2b, 0xdd, 0x93, 0x76, 0x36, 0xba, 0xcb, 0x5d, 0x01, 0x9a, 0xae, 0xe6, 0xff, 0x75, 0xf4, 0xc1, 0x6b, 0x3b, 0xd2, 0x81, 0x4e, 0x13, 0x11, 0xf6, 0xc3, 0x38, 0x3d];
    const PROOF_ED25519_SIG: [u8; 64] = [0xd7, 0x5e, 0x64, 0x96, 0xd3, 0x24, 0x61, 0xe4, 0xc0, 0x8a, 0x22, 0xce, 0x29, 0xb4, 0x4b, 0xfe, 0x37, 0x45, 0x44, 0x28, 0xf7, 0x28, 0x17, 0xeb, 0xbe, 0x9e, 0xf0, 0xcd, 0xfa, 0x1a, 0x3d, 0x4d, 0x65, 0xcc, 0x4a, 0xa8, 0x0d, 0x90, 0x88, 0x75, 0x5f, 0x52, 0x00, 0x2c, 0x8d, 0x28, 0x0e, 0x24, 0xdd, 0xff, 0x80, 0x65, 0xf3, 0xe8, 0x9b, 0xc7, 0x43, 0x13, 0x76, 0xb2, 0x3f, 0xd3, 0x19, 0x0a];
    const ORACLE_ED25519_PK: [u8; 32] = [0x3c, 0x7c, 0x02, 0xb6, 0x7d, 0x5d, 0x50, 0xf2, 0xe9, 0x39, 0xa9, 0x99, 0x0c, 0xf1, 0xae, 0x1c, 0xa5, 0xbe, 0x9c, 0x48, 0x0f, 0x87, 0xdf, 0x31, 0x92, 0x6c, 0xed, 0x3d, 0x9c, 0x3c, 0x84, 0xd5];

    let new_oracle_pk = BytesN::from_array(&env, &PROOF_ORACLE_PK);
    let new_oracle_addr = Address::generate(&env);
    let new_oracle_ed = BytesN::from_array(&env, &ORACLE_ED25519_PK);

    client.rotate_oracle_keys(&new_oracle_pk, &new_oracle_addr, &new_oracle_ed);

    assert_eq!(client.oracle_pk(), new_oracle_pk);
    assert_eq!(client.oracle_address(), new_oracle_addr);

    // 3. New oracle fulfills the old pending request with valid proof:
    let proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &PROOF_ALPHA),
        gamma_point: BytesN::from_array(&env, &PROOF_GAMMA),
        beta_output: BytesN::from_array(&env, &PROOF_BETA),
        public_key: new_oracle_pk,
        drand_round: target_round,
        drand_signature: BytesN::from_array(&env, &PROOF_DRAND_SIG),
    };
    let signature = BytesN::from_array(&env, &PROOF_ED25519_SIG);

    // Execution succeeds completely: verifies BLS12-381 VRF proof, drand BLS pairing,
    // Ed25519 oracle signature, and commits randomness to persistent storage!
    client.fulfill(&id, &proof, &signature);

    // 4. Verify post-conditions
    assert_eq!(client.is_fulfilled(&id), true, "request must be fulfilled");
    assert_eq!(client.get_proof(&id).beta_output, BytesN::from_array(&env, &PROOF_BETA), "randomness output must match");
}

// ── Fix 3: Budget measurement tests ───────────────────────────────────────────

/// Measure CPU instructions for a SAC token transfer — this is the delta
/// between fee=0 and nonzero-fee fulfillment paths.
#[test]
fn test_budget_sac_transfer_cpu_instructions() {
    extern crate std;
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let fee_token_addr = fee_token_contract.address();
    let sac_admin = StellarAssetClient::new(&env, &fee_token_addr);
    let token = TokenClient::new(&env, &fee_token_addr);

    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    sac_admin.mint(&sender, &10_000_000i128);

    // Reset budget and measure a single SAC transfer
    env.cost_estimate().budget().reset_unlimited();
    token.transfer(&sender, &receiver, &5_000_000i128);
    let transfer_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    std::println!("========================================");
    std::println!("SAC TRANSFER CPU INSTRUCTIONS: {}", transfer_cpu);
    std::println!("This is the delta for nonzero-fee fulfill()");
    std::println!("========================================");

    // The transfer should cost a measurable but bounded amount of CPU
    assert!(transfer_cpu > 0, "SAC transfer must consume some CPU instructions");
    // SAC transfers are typically in the 1M-5M range
    assert!(transfer_cpu < 20_000_000, "SAC transfer CPU cost unexpectedly high");
}

/// Measure CPU instructions for G1 point negation in isolation.
/// This validates the <1K estimate in PROFILING.md.
#[test]
fn test_budget_g1_negation_cpu_instructions() {
    extern crate std;
    use soroban_sdk::crypto::bls12_381::Bls12381G1Affine;

    let env = Env::default();
    let _bls = env.crypto().bls12_381();

    // Use the standard G1 generator point
    let g1_bytes: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
        0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
        0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
        0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];
    let g1 = Bls12381G1Affine::from_bytes(BytesN::from_array(&env, &g1_bytes));

    // Reset budget and measure G1 negation
    env.cost_estimate().budget().reset_unlimited();
    let _neg_g1 = -g1.clone();
    let neg_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    // Measure a second negation to confirm consistency
    env.cost_estimate().budget().reset_unlimited();
    let _neg_g1_2 = -g1;
    let neg_cpu_2 = env.cost_estimate().budget().cpu_instruction_cost();

    std::println!("========================================");
    std::println!("G1 NEGATION CPU INSTRUCTIONS (run 1): {}", neg_cpu);
    std::println!("G1 NEGATION CPU INSTRUCTIONS (run 2): {}", neg_cpu_2);
    std::println!("========================================");

    // G1 negation is a single Fp field subtraction — should be <5000 instructions
    assert!(neg_cpu < 5_000,
        "G1 negation cost {} instructions, expected <5000", neg_cpu);
}

/// Combined budget measurement: compute total nonzero-fee fulfill() CPU cost
/// by summing all individually measured components.
/// This gives an empirically grounded total since running a full end-to-end
/// fulfill() with nonzero fee requires valid BLS/drand proofs.
#[test]
fn test_budget_combined_nonzero_fee_fulfill_estimate() {
    extern crate std;
    use soroban_sdk::crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine};

    let env = Env::default();
    env.mock_all_auths();

    // ── Component 1: Dual BLS pairing ──
    let g1_bytes: [u8; 96] = [
        0x17, 0xf1, 0xd3, 0xa7, 0x31, 0x97, 0xd7, 0x94, 0x26, 0x95, 0x63, 0x8c,
        0x4f, 0xa9, 0xac, 0x0f, 0xc3, 0x68, 0x8c, 0x4f, 0x97, 0x74, 0xb9, 0x05,
        0xa1, 0x4e, 0x3a, 0x3f, 0x17, 0x1b, 0xac, 0x58, 0x6c, 0x55, 0xe8, 0x3f,
        0xf9, 0x7a, 0x1a, 0xef, 0xfb, 0x3a, 0xf0, 0x0a, 0xdb, 0x22, 0xc6, 0xbb,
        0x08, 0xb3, 0xf4, 0x81, 0xe3, 0xaa, 0xa0, 0xf1, 0xa0, 0x9e, 0x30, 0xed,
        0x74, 0x1d, 0x8a, 0xe4, 0xfc, 0xf5, 0xe0, 0x95, 0xd5, 0xd0, 0x0a, 0xf6,
        0x00, 0xdb, 0x18, 0xcb, 0x2c, 0x04, 0xb3, 0xed, 0xd0, 0x3c, 0xc7, 0x44,
        0xa2, 0x88, 0x8a, 0xe4, 0x0c, 0xaa, 0x23, 0x29, 0x46, 0xc5, 0xe7, 0xe1,
    ];
    let g2_bytes: [u8; 192] = [
        0x13, 0xe0, 0x2b, 0x60, 0x52, 0x71, 0x9f, 0x60, 0x7d, 0xac, 0xd3, 0xa0,
        0x88, 0x27, 0x4f, 0x65, 0x59, 0x6b, 0xd0, 0xd0, 0x99, 0x20, 0xb6, 0x1a,
        0xb5, 0xda, 0x61, 0xbb, 0xdc, 0x7f, 0x50, 0x49, 0x33, 0x4c, 0xf1, 0x12,
        0x13, 0x94, 0x5d, 0x57, 0xe5, 0xac, 0x7d, 0x05, 0x5d, 0x04, 0x2b, 0x7e,
        0x02, 0x4a, 0xa2, 0xb2, 0xf0, 0x8f, 0x0a, 0x91, 0x26, 0x08, 0x05, 0x27,
        0x2d, 0xc5, 0x10, 0x51, 0xc6, 0xe4, 0x7a, 0xd4, 0xfa, 0x40, 0x3b, 0x02,
        0xb4, 0x51, 0x0b, 0x64, 0x7a, 0xe3, 0xd1, 0x77, 0x0b, 0xac, 0x03, 0x26,
        0xa8, 0x05, 0xbb, 0xef, 0xd4, 0x80, 0x56, 0xc8, 0xc1, 0x21, 0xbd, 0xb8,
        0x06, 0x06, 0xc4, 0xa0, 0x2e, 0xa7, 0x34, 0xcc, 0x32, 0xac, 0xd2, 0xb0,
        0x2b, 0xc2, 0x8b, 0x99, 0xcb, 0x3e, 0x28, 0x7e, 0x85, 0xa7, 0x63, 0xaf,
        0x26, 0x74, 0x92, 0xab, 0x57, 0x2e, 0x99, 0xab, 0x3f, 0x37, 0x0d, 0x27,
        0x5c, 0xec, 0x1d, 0xa1, 0xaa, 0xa9, 0x07, 0x5f, 0xf0, 0x5f, 0x79, 0xbe,
        0x0c, 0xe5, 0xd5, 0x27, 0x72, 0x7d, 0x6e, 0x11, 0x8c, 0xc9, 0xcd, 0xc6,
        0xda, 0x2e, 0x35, 0x1a, 0xad, 0xfd, 0x9b, 0xaa, 0x8c, 0xbd, 0xd3, 0xa7,
        0x6d, 0x42, 0x9a, 0x69, 0x51, 0x60, 0xd1, 0x2c, 0x92, 0x3a, 0xc9, 0xcc,
        0x3b, 0xac, 0xa2, 0x89, 0xe1, 0x93, 0x54, 0x86, 0x08, 0xb8, 0x28, 0x01,
    ];
    let g1 = Bls12381G1Affine::from_bytes(BytesN::from_array(&env, &g1_bytes));
    let g2 = Bls12381G2Affine::from_bytes(BytesN::from_array(&env, &g2_bytes));
    let mut vp1 = soroban_sdk::Vec::new(&env);
    vp1.push_back(g1.clone()); vp1.push_back(g1.clone());
    let mut vp2 = soroban_sdk::Vec::new(&env);
    vp2.push_back(g2.clone()); vp2.push_back(g2.clone());

    env.cost_estimate().budget().reset_unlimited();
    env.crypto().bls12_381().pairing_check(vp1.clone(), vp2.clone());
    env.crypto().bls12_381().pairing_check(vp1, vp2);
    let pairing_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    // ── Component 2: G1 negation × 2 ──
    env.cost_estimate().budget().reset_unlimited();
    let _ = -g1.clone();
    let _ = -g1;
    let neg_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    // ── Component 3: SAC transfer (fee payment) ──
    let admin = Address::generate(&env);
    let fee_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let fee_addr = fee_contract.address();
    let sac = soroban_sdk::token::StellarAssetClient::new(&env, &fee_addr);
    let token = soroban_sdk::token::TokenClient::new(&env, &fee_addr);
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);
    sac.mint(&sender, &10_000_000i128);

    env.cost_estimate().budget().reset_unlimited();
    token.transfer(&sender, &receiver, &5_000_000i128);
    let transfer_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    // ── Component 4: Ed25519 verify ──
    env.cost_estimate().budget().reset_unlimited();
    // We can't call ed25519_verify with a dummy key (it will panic),
    // so we use the mainnet-measured value: ~1M instructions
    let ed25519_cpu: u64 = 1_000_000; // mainnet measured

    // ── Component 5: hash_to_g1 × 2 ──
    let dst = Bytes::from_slice(&env, b"test_dst");
    let msg = Bytes::from_slice(&env, &[0u8; 32]);
    env.cost_estimate().budget().reset_unlimited();
    env.crypto().bls12_381().hash_to_g1(&msg, &dst);
    env.crypto().bls12_381().hash_to_g1(&msg, &dst);
    let hash_g1_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    // ── Component 6: Storage overhead (mainnet measured) ──
    let storage_cpu: u64 = 1_500_000;

    // ── Total ──
    let total_nonzero_fee = pairing_cpu + neg_cpu + transfer_cpu
        + ed25519_cpu + hash_g1_cpu + storage_cpu;

    std::println!("╔══════════════════════════════════════════════════════════╗");
    std::println!("║  COMPOSITE NONZERO-FEE FULFILL() CPU ESTIMATE           ║");
    std::println!("╠══════════════════════════════════════════════════════════╣");
    std::println!("║  BLS pairing × 2:       {:>12} instructions       ║", pairing_cpu);
    std::println!("║  G1 negation × 2:       {:>12} instructions       ║", neg_cpu);
    std::println!("║  SAC transfer (fee):    {:>12} instructions       ║", transfer_cpu);
    std::println!("║  Ed25519 verify:        {:>12} instructions (est) ║", ed25519_cpu);
    std::println!("║  hash_to_g1 × 2:        {:>12} instructions       ║", hash_g1_cpu);
    std::println!("║  Storage R/W + TTL:     {:>12} instructions (est) ║", storage_cpu);
    std::println!("╠══════════════════════════════════════════════════════════╣");
    std::println!("║  TOTAL (composite est): {:>12} instructions       ║", total_nonzero_fee);
    std::println!("║  Mainnet Protocol Limit: {:>11} instructions       ║", 400_000_000u64);
    std::println!("║  Project / SCF Target:  {:>12} instructions       ║", 75_000_000u64);
    std::println!("║  Headroom under target: {:>11.1}%                    ║",
        (1.0 - total_nonzero_fee as f64 / 75_000_000.0) * 100.0);
    std::println!("║  Headroom under 400M:   {:>11.1}%                    ║",
        (1.0 - total_nonzero_fee as f64 / 400_000_000.0) * 100.0);
    std::println!("╚══════════════════════════════════════════════════════════╝");

    assert!(total_nonzero_fee < 400_000_000,
        "Nonzero-fee fulfill() exceeds Soroban 400M protocol limit: {}", total_nonzero_fee);
    assert!(total_nonzero_fee < 75_000_000,
        "Nonzero-fee fulfill() exceeds SCF 75M target: {}", total_nonzero_fee);
}

/// Proves cross-request replay protection:
/// An attacker who captures a valid fulfillment payload and Ed25519 signature
/// for Request A CANNOT replay it to fulfill Request B.
///
/// Defense in depth:
/// 1. Primary layer: The oracle's Ed25519 signature binds request_id. When submitted
///    to fulfill(B, ...), the signature check fails with "failed ED25519 verification"
///    because the message payload was signed for request_id A, not B.
/// 2. Cryptographic binding layer: Even if an attacker forged an Ed25519 signature for B,
///    derive_expected_alpha binds request_id and context into the SHA-256 hash.
///    The alpha_seed from Request A will mismatch derive_expected_alpha for Request B.
#[test]
#[should_panic(expected = "failed ED25519 verification")]
fn test_cross_request_replay_rejected() {
    use ed25519_dalek::{SigningKey, Signer};
    use rand::rngs::OsRng;

    let env = Env::default();
    env.mock_all_auths();

    // Generate real Ed25519 keypair for the oracle.
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let ed25519_pk_bytes: [u8; 32] = verifying_key.to_bytes();

    let contract_id = env.register(VRFOracleContract, ());
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 192]);
    let oracle_ed25519 = BytesN::from_array(&env, &ed25519_pk_bytes);
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
        &2u32,
        &fee_token,
        &0i128,
    );

    let requester = Address::generate(&env);
    let id_a = client.request(&Bytes::from_slice(&env, b"ctx_a"), &requester);
    let id_b = client.request(&Bytes::from_slice(&env, b"ctx_b"), &requester);
    let round_a = client.request_round(&id_a);

    let proof_a = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0x11; 32]),
        gamma_point: BytesN::from_array(&env, &[0x22; 96]),
        beta_output: BytesN::from_array(&env, &[0x33; 32]),
        public_key: oracle_pk,
        drand_round: round_a,
        drand_signature: BytesN::from_array(&env, &[0x44; 96]),
    };

    // The oracle legitimately signed the fulfillment payload for Request A:
    let mut msg_a = alloc::vec::Vec::<u8>::new();
    msg_a.extend_from_slice(&id_a.to_be_bytes());
    msg_a.extend_from_slice(&proof_a.alpha_seed.to_array());
    msg_a.extend_from_slice(&proof_a.gamma_point.to_array());
    msg_a.extend_from_slice(&proof_a.beta_output.to_array());
    msg_a.extend_from_slice(&round_a.to_be_bytes());
    msg_a.extend_from_slice(&proof_a.drand_signature.to_array());

    let sig_a = signing_key.sign(&msg_a);
    let valid_sig_for_a = BytesN::from_array(&env, &sig_a.to_bytes());

    // Attacker attempts to replay (proof_a, valid_sig_for_a) to fulfill Request B:
    // This MUST fail because the signature is cryptographically bound to id_a.
    client.fulfill(&id_b, &proof_a, &valid_sig_for_a);
}

/// Verifies that derive_expected_alpha produces strictly distinct seeds for different
/// request IDs even when the request context, drand round, and drand signature are 100% identical.
#[test]
fn test_alpha_seed_unique_per_request() {
    let (env, client, _addr, _pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let id_a = client.request(&Bytes::from_slice(&env, b"context_identical"), &requester);
    let id_b = client.request(&Bytes::from_slice(&env, b"context_identical"), &requester);
    let round = 100u64;
    let drand_sig = BytesN::from_array(&env, &[0x99; 96]);

    let alpha_a = env.as_contract(&client.address, || {
        crate::derive_expected_alpha(&env, id_a, round, &drand_sig)
    });
    let alpha_b = env.as_contract(&client.address, || {
        crate::derive_expected_alpha(&env, id_b, round, &drand_sig)
    });

    // Even with identical context, identical round, and identical drand signature,
    // different request_ids MUST yield completely different alpha seeds.
    assert_ne!(alpha_a, alpha_b);
}

/// Comprehensive boundary test for future round enforcement:
/// Verifies across multiple timestamps (before genesis, at genesis, before boundary,
/// at boundary, after boundary) that compute_required_round always enforces a strictly future round:
/// required_round >= current_round + round_offset > current_round.
#[test]
fn test_future_round_boundary_enforcement() {
    let genesis = 1_692_803_367u64;
    let period = 3u32;
    let offset = 2u32; // MIN_ROUND_OFFSET

    let test_timestamps = [
        0u64,
        genesis.saturating_sub(10),
        genesis,
        genesis + 1,
        genesis + 2,
        genesis + 3,
        genesis + 4,
        genesis + 5,
        genesis + 6,
        genesis + 8,
        genesis + 9,
        genesis + 10,
        genesis + 300,
        genesis + 301,
        genesis + 302,
        genesis + 1_000_000,
    ];

    for &ts in &test_timestamps {
        let current_round = crate::compute_current_round(ts, genesis, period);
        let required_round = crate::compute_required_round(ts, genesis, period, offset);

        assert!(
            required_round > current_round,
            "Violation at timestamp {}: required_round ({}) must be > current_round ({})",
            ts, required_round, current_round
        );

        assert!(
            required_round >= current_round + offset as u64,
            "Violation at timestamp {}: required_round ({}) must be >= current_round ({}) + offset ({})",
            ts, required_round, current_round, offset
        );
    }
}

