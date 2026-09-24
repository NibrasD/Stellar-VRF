#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger as _, Address, Bytes, BytesN, Env, Symbol,
};
use soroban_vrf_oracle::testkeys::{TEST_G2_TIMES_2, TEST_G2_TIMES_3};
use soroban_vrf_oracle::{BlsVrfProof, VRFOracleContract, VRFOracleContractClient};

fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }

    let env = Env::default();
    env.mock_all_auths();

    let oracle_addr = Address::generate(&env);
    let oracle_pk = BytesN::from_array(&env, &TEST_G2_TIMES_2);
    let oracle_ed25519 = BytesN::from_array(&env, &[0x11; 32]);
    let drand_pk = BytesN::from_array(&env, &TEST_G2_TIMES_3);
    let fee_token = Address::generate(&env);

    let genesis: u64 = 1_000_000;
    let period: u32 = 3;
    let round_offset: u32 = 2;
    let fee_amount: i128 = 0;

    env.ledger().set_timestamp(genesis);

    // Atomic construction: configuration is set at deploy time, there is
    // no separate init() call to race.
    let contract_id = env.register(
        VRFOracleContract,
        (
            &oracle_pk,
            &oracle_addr,
            &oracle_ed25519,
            &drand_pk,
            &genesis,
            &period,
            &round_offset,
            &fee_token,
            &fee_amount,
        ),
    );
    let client = VRFOracleContractClient::new(&env, &contract_id);

    let mut requests: std::vec::Vec<u64> = std::vec::Vec::new();
    let mut current_time = genesis;

    // Process chunked actions from fuzzer input
    for chunk in data.chunks(8) {
        if chunk.len() < 2 {
            break;
        }
        let action = chunk[0] % 6;
        let param = chunk[1];

        match action {
            0 => {
                // Action 0: request()
                let requester = Address::generate(&env);
                let context_len = (param as usize).min(1024);
                let ctx_buf = std::vec![param; context_len];
                let ctx = Bytes::from_slice(&env, &ctx_buf);

                let id = client.request(&ctx, &requester);
                assert_eq!(
                    id,
                    (requests.len() as u64) + 1,
                    "Sequential ID invariant violated"
                );
                requests.push(id);
            }
            1 => {
                // Action 1: request_with_callback()
                let callback_contract = Address::generate(&env);
                let callback_fn = Symbol::new(&env, "on_vrf");
                let context_len = (param as usize).min(1024);
                let ctx_buf = std::vec![param; context_len];
                let ctx = Bytes::from_slice(&env, &ctx_buf);

                // Note: callback_contract must match requester
                let id = client.request_with_callback(
                    &ctx,
                    &callback_contract,
                    &callback_contract,
                    &callback_fn,
                );
                assert_eq!(
                    id,
                    (requests.len() as u64) + 1,
                    "Sequential ID invariant violated"
                );
                requests.push(id);
            }
            2 => {
                // Action 2: Mock Fulfill
                if !requests.is_empty() {
                    let target_id = requests[(param as usize) % requests.len()];
                    let initially_refunded = client.is_refunded(&target_id);
                    let initially_fulfilled = client.is_fulfilled(&target_id);

                    let dummy_proof = BlsVrfProof {
                        alpha_seed: BytesN::from_array(&env, &[param; 32]),
                        gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                        beta_output: BytesN::from_array(&env, &[param.wrapping_mul(7); 32]),
                        public_key: oracle_pk.clone(),
                        drand_round: 2,
                        drand_signature: BytesN::from_array(&env, &[0u8; 96]),
                    };
                    let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
                    let res = client.try_fulfill(&target_id, &dummy_proof, &dummy_sig);

                    if initially_refunded || initially_fulfilled {
                        assert!(
                            res.is_err(),
                            "Duplicate fulfill or fulfill-after-refund allowed!"
                        );
                    }
                }
            }
            3 => {
                // Action 3: timeout_refund()
                if !requests.is_empty() {
                    let target_id = requests[(param as usize) % requests.len()];
                    let initially_fulfilled = client.is_fulfilled(&target_id);
                    let initially_refunded = client.is_refunded(&target_id);

                    let res = client.try_timeout_refund(&target_id);

                    if initially_fulfilled || initially_refunded {
                        assert!(
                            res.is_err(),
                            "Refund on fulfilled or duplicate refund allowed!"
                        );
                    }
                }
            }
            4 => {
                // Action 4: advance time (test time windows and timeouts)
                let advance_seconds = (param as u64) * 3;
                current_time += advance_seconds;
                env.ledger().set_timestamp(current_time);
            }
            5 => {
                // Action 5: cleanup_proof()
                if !requests.is_empty() {
                    let target_id = requests[(param as usize) % requests.len()];
                    let initially_fulfilled = client.is_fulfilled(&target_id);

                    let res = client.try_cleanup_proof(&target_id, &oracle_addr);

                    if !initially_fulfilled {
                        assert!(res.is_err(), "Cleanup allowed on unfulfilled request!");
                    }
                }
            }
            _ => unreachable!(),
        }

        // Global invariant check after EVERY operation:
        for &id in &requests {
            let fulfilled = client.is_fulfilled(&id);
            let refunded = client.is_refunded(&id);
            assert!(
                !(fulfilled && refunded),
                "Critical invariant violated: Request #{} is both fulfilled and refunded!",
                id
            );
        }
    }
});
