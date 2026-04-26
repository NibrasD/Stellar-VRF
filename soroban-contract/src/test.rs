#![cfg(test)]
extern crate alloc;
use alloc::format;

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};

use crate::{VRFOracleContract, VRFOracleContractClient};

/// Helper: deploy and initialize the contract.
fn setup() -> (Env, VRFOracleContractClient<'static>, Address, BytesN<33>, BytesN<32>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, VRFOracleContract);
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &[0x02; 33]);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);

    client.init(&oracle_pk, &oracle_addr, &oracle_ed25519);

    (env, client, oracle_addr, oracle_pk, oracle_ed25519)
}

// ── init tests ──────────────────────────────────────────────────────────────

#[test]
fn test_init_stores_oracle_pk() {
    let (_env, client, _addr, oracle_pk, _ed) = setup();
    let stored_pk = client.oracle_pk();
    assert_eq!(stored_pk, oracle_pk);
}

#[test]
fn test_init_stores_oracle_address() {
    let (_env, client, oracle_addr, _pk, _ed) = setup();
    let stored_addr = client.oracle_address();
    assert_eq!(stored_addr, oracle_addr);
}

// ── request tests ───────────────────────────────────────────────────────────

#[test]
fn test_request_returns_incremented_ids() {
    let (env, client, _addr, _pk, _ed) = setup();
    let requester = Address::generate(&env);
    let seed1 = Bytes::from_slice(&env, b"seed_one");
    let seed2 = Bytes::from_slice(&env, b"seed_two");

    let id1 = client.request(&seed1, &requester);
    let id2 = client.request(&seed2, &requester);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_request_is_initially_unfulfilled() {
    let (env, client, _addr, _pk, _ed) = setup();
    let requester = Address::generate(&env);
    let seed = Bytes::from_slice(&env, b"test_seed");

    let id = client.request(&seed, &requester);
    let fulfilled = client.is_fulfilled(&id);

    assert!(!fulfilled);
}

// ── is_fulfilled tests ──────────────────────────────────────────────────────

#[test]
fn test_is_fulfilled_nonexistent_returns_false() {
    let (_env, client, _addr, _pk, _ed) = setup();
    let result = client.is_fulfilled(&999u64);
    assert!(!result);
}

// ── multiple requests are independent ───────────────────────────────────────

#[test]
fn test_multiple_requests_independent() {
    let (env, client, _addr, _pk, _ed) = setup();
    let requester1 = Address::generate(&env);
    let requester2 = Address::generate(&env);

    let seed1 = Bytes::from_slice(&env, b"alpha_1");
    let seed2 = Bytes::from_slice(&env, b"alpha_2");

    let id1 = client.request(&seed1, &requester1);
    let id2 = client.request(&seed2, &requester2);

    assert_ne!(id1, id2);
    assert!(!client.is_fulfilled(&id1));
    assert!(!client.is_fulfilled(&id2));
}

// ── oracle_pk getter test ───────────────────────────────────────────────────

#[test]
fn test_oracle_pk_getter() {
    let (env, client, _addr, _pk, _ed) = setup();
    let expected_pk = BytesN::from_array(&env, &[0x02; 33]);
    assert_eq!(client.oracle_pk(), expected_pk);
}

// ── request counter starts at zero and increments correctly ─────────────────

#[test]
fn test_request_counter_sequential() {
    let (env, client, _addr, _pk, _ed) = setup();
    let requester = Address::generate(&env);

    for expected_id in 1u64..=5 {
        let seed = Bytes::from_slice(&env, format!("seed_{}", expected_id).as_bytes());
        let id = client.request(&seed, &requester);
        assert_eq!(id, expected_id);
    }
}

// Note: Tests that trigger contract panics (double init, double fulfill,
// wrong PK, wrong alpha seed, get_proof before fulfill, derive_random
// before fulfill) cannot be tested in-process because the Soroban SDK
// uses non-unwinding panics (panic=abort). These error paths are covered
// by the TypeScript integration tests in artifacts/api-server/test/integration/.
