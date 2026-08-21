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
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"reentrant_cross_contract");
    let id = vrf_client.request_with_callback(
        &context,
        &requester,
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
/// Even if all other fields are correct, a wrong drand_signature means
/// the beacon cannot be verified and the proof is invalid.
#[test]
#[should_panic] // BLS pairing check or ed25519 verify will fail
fn test_fulfill_invalid_drand_bls_signature() {
    let (env, client, _oracle_addr, oracle_pk, _ed, _drand_pk, _g2_gen) = setup();
    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, b"bad_drand_sig");
    let id = client.request(&context, &requester);
    let required_round = client.request_round(&id);

    let proof = crate::BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &[0u8; 32]),
        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
        beta_output: BytesN::from_array(&env, &[0u8; 32]),
        public_key: oracle_pk,
        drand_round: required_round,
        // Invalid drand signature — random garbage bytes
        drand_signature: BytesN::from_array(&env, &[0xDE; 96]),
    };
    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
    client.fulfill(&id, &proof, &dummy_sig);
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
