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

    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &1_692_803_367u64,
        &3u32,
        &2u32,
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

    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &1_692_803_367u64,
        &3u32,
        &0u32,
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

    client.init(
        &oracle_pk,
        &oracle_addr,
        &oracle_ed25519,
        &drand_pk,
        &g2_generator,
        &1_692_803_367u64,
        &3u32,
        &1u32, // Should fail: round_offset must be >= 2
    );
}

