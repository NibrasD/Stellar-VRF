#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};
use soroban_vrf_oracle::testkeys::{TEST_G2_TIMES_2, TEST_G2_TIMES_3};
use soroban_vrf_oracle::{BlsVrfProof, DataKey, VRFOracleContract, VRFOracleContractClient};

// Target structure: at least 32 + 96 + 32 + 192 + 96 + 64 + 8 + 8 + 2 = 530 bytes
// If less, we expand/cycle bytes to synthesize full cryptographic structures.
fuzz_target!(|data: &[u8]| {
    if data.is_empty() {
        return;
    }

    let env = Env::default();
    env.mock_all_auths();

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);

    // Atomic construction: configuration is set at deploy time, there is
    // no separate init() call to race.
    let contract_id = env.register(
        VRFOracleContract,
        (
            &oracle_pk,
            &oracle_addr,
            &oracle_ed25519,
            &drand_pk,
            &1_692_803_367u64,
            &3u32,
            &2u32,
            &fee_token,
            &0i128,
        ),
    );
    let client = VRFOracleContractClient::new(&env, &contract_id);

    // Create 1 valid baseline request so there is always a real request in state
    let requester = Address::generate(&env);
    let ctx = Bytes::from_slice(&env, b"fuzz_baseline_context");
    let valid_req_id = client.request(&ctx, &requester);
    let valid_round = client.request_round(&valid_req_id);

    // Parse fuzzer entropy
    let mut iter = data.iter().copied().cycle();
    let mut take_bytes =
        |n: usize| -> std::vec::Vec<u8> { (0..n).map(|_| iter.next().unwrap()).collect() };

    let flags = data[0];
    let pick_req_id_mode = flags & 0x07; // 0..7
    let target_req_id = match pick_req_id_mode {
        0 => 0u64,
        1 => valid_req_id,
        2 => valid_req_id.wrapping_add(1),
        3 => u64::MAX,
        4 => u64::MAX - 1,
        _ => {
            let b = take_bytes(8);
            u64::from_le_bytes(b.try_into().unwrap())
        }
    };

    let target_round = if (flags & 0x08) != 0 {
        valid_round
    } else {
        let b = take_bytes(8);
        u64::from_le_bytes(b.try_into().unwrap())
    };

    let target_pk = if (flags & 0x10) != 0 {
        oracle_pk.clone()
    } else {
        let b = take_bytes(192);
        BytesN::from_array(&env, &b.try_into().unwrap())
    };

    // Pre-state mutation (test duplicate fulfillment and refund replay)
    if (flags & 0x20) != 0 {
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::Fulfilled(valid_req_id), &true);
        });
    } else if (flags & 0x40) != 0 {
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::Refunded(valid_req_id), &true);
        });
    } else if (flags & 0x80) != 0 {
        env.as_contract(&client.address, || {
            env.storage()
                .persistent()
                .set(&DataKey::Fulfilling(valid_req_id), &true);
        });
    }

    let alpha_b = take_bytes(32);
    let gamma_b = take_bytes(96);
    let beta_b = take_bytes(32);
    let drand_sig_b = take_bytes(96);
    let ed25519_sig_b = take_bytes(64);

    let proof = BlsVrfProof {
        alpha_seed: BytesN::from_array(&env, &alpha_b.try_into().unwrap()),
        gamma_point: BytesN::from_array(&env, &gamma_b.try_into().unwrap()),
        beta_output: BytesN::from_array(&env, &beta_b.try_into().unwrap()),
        public_key: target_pk,
        drand_round: target_round,
        drand_signature: BytesN::from_array(&env, &drand_sig_b.try_into().unwrap()),
    };
    let signature = BytesN::from_array(&env, &ed25519_sig_b.try_into().unwrap());

    // Record initial invariant state
    let initially_fulfilled = client.is_fulfilled(&valid_req_id);
    let initially_refunded = client.is_refunded(&valid_req_id);

    // Call try_fulfill directly — Soroban host returns Ok(()) or Err(Error)
    let res = client.try_fulfill(&target_req_id, &proof, &signature);

    // Invariant verifications:
    // 1. If initially refunded, fulfill MUST NEVER succeed
    if initially_refunded && target_req_id == valid_req_id {
        assert!(
            res.is_err(),
            "Replay attack invariant violated: fulfilled after refund"
        );
    }

    // 2. If initially fulfilled, duplicate fulfillment MUST NEVER succeed
    if initially_fulfilled && target_req_id == valid_req_id {
        assert!(
            res.is_err(),
            "Duplicate fulfillment invariant violated: fulfilled twice"
        );
    }

    // 3. If target_req_id == 0 or non-existent, MUST NEVER succeed
    if target_req_id == 0 || target_req_id > valid_req_id {
        assert!(
            res.is_err(),
            "Non-existent request fulfillment invariant violated"
        );
    }

    // 4. Contract invariants: a request can NEVER be both fulfilled and refunded
    let post_fulfilled = client.is_fulfilled(&valid_req_id);
    let post_refunded = client.is_refunded(&valid_req_id);
    assert!(
        !(post_fulfilled && post_refunded),
        "State mutual exclusion invariant violated!"
    );
});
