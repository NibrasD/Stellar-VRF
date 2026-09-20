#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};
use soroban_vrf_oracle::{VRFOracleContract, VRFOracleContractClient};

fuzz_target!(|data: &[u8]| {
    if data.len() < 8 {
        return;
    }

    // Extract range max from first 8 bytes
    let mut max_bytes = [0u8; 8];
    max_bytes.copy_from_slice(&data[0..8]);
    let max = u64::from_le_bytes(max_bytes);

    if max == 0 {
        return;
    }

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
        &2u32,
        &fee_token,
        &0i128,
    );

    let requester = Address::generate(&env);
    let context_slice = if data.len() > 8 { &data[8..] } else { b"" };
    let bounded_context_len = context_slice.len().min(1024);
    let context = Bytes::from_slice(&env, &context_slice[..bounded_context_len]);

    let id = client.request(&context, &requester);

    // Mock fulfilled state with fuzzer entropy
    let mut beta_bytes = [0u8; 32];
    for (i, b) in data.iter().cycle().take(32).enumerate() {
        beta_bytes[i] = *b;
    }

    use soroban_vrf_oracle::DataKey;
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Fulfilled(id), &true);
        env.storage().persistent().set(
            &DataKey::Proof(id),
            &soroban_vrf_oracle::BlsVrfProof {
                alpha_seed: BytesN::from_array(&env, &[0xAA; 32]),
                gamma_point: BytesN::from_array(&env, &[0u8; 96]),
                beta_output: BytesN::from_array(&env, &beta_bytes),
                public_key: BytesN::from_array(&env, &[0u8; 192]),
                drand_round: 2,
                drand_signature: BytesN::from_array(&env, &[0u8; 96]),
            },
        );
    });

    let result = client.derive_random_in_range(&id, &context, &max);
    assert!(result < max, "Invariant violated: result {} >= max {}", result, max);
});
