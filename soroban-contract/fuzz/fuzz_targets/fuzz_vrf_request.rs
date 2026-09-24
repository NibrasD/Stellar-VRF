#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};
use soroban_vrf_oracle::testkeys::{TEST_G2_TIMES_2, TEST_G2_TIMES_3};
use soroban_vrf_oracle::{VRFOracleContract, VRFOracleContractClient};

fuzz_target!(|data: &[u8]| {
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

    let requester = Address::generate(&env);
    let context = Bytes::from_slice(&env, data);

    if data.len() <= 1024 {
        // Must succeed without error
        let id = client.request(&context, &requester);
        assert_eq!(id, 1);
        assert_eq!(client.requester_of(&id), requester);
        assert!(!client.is_fulfilled(&id));
        assert!(!client.is_refunded(&id));
    } else {
        // Over 1024 bytes: Soroban environment should cleanly reject with panic
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.request(&context, &requester);
        }));
        assert!(res.is_err(), "Oversized context (>1024) must be rejected");
    }
});
