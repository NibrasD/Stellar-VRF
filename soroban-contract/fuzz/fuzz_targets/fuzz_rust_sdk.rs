#![no_main]

use libfuzzer_sys::fuzz_target;
use stellar_vrf_sdk::internal::{
    base32_decode, base64_decode, decode_scval_b64, strkey_decode_contract,
};
use stellar_vrf_sdk::{
    derive_range_for_domain_from_beta, derive_range_from_beta, derive_u64_from_beta,
    reduce_uniform, strkey_encode_contract, strkey_encode_ed25519, to_hex,
};

fuzz_target!(|data: &[u8]| {
    if data.is_empty() {
        return;
    }

    // 1. Fuzz reduce_uniform with arbitrary 32-byte hash and u64 max
    if data.len() >= 40 {
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&data[0..32]);
        let max = u64::from_le_bytes(data[32..40].try_into().unwrap());
        match reduce_uniform(&hash, max) {
            Ok(v) => {
                assert!(max > 0, "reduce_uniform succeeded with max=0");
                assert!(v < max, "reduce_uniform result {} >= max {}", v, max);
            }
            Err(_) => {
                // Expected if max == 0 or if both 128-bit halves fall in the rejection zone
            }
        }
    }

    // 2. Fuzz derive_range_from_beta
    if data.len() >= 48 {
        let mut beta = [0u8; 32];
        beta.copy_from_slice(&data[0..32]);
        let req_id = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let max = u64::from_le_bytes(data[40..48].try_into().unwrap());

        if let Ok(v) = derive_range_from_beta(&beta, req_id, max) {
            assert!(max > 0);
            assert!(v < max);
            // Invariant: must be strictly deterministic
            let v2 = derive_range_from_beta(&beta, req_id, max).unwrap();
            assert_eq!(v, v2);
        }

        let _ = derive_u64_from_beta(&beta, req_id);
    }

    // 3. Fuzz derive_range_for_domain_from_beta
    if data.len() >= 50 {
        let mut beta = [0u8; 32];
        beta.copy_from_slice(&data[0..32]);
        let req_id = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let max = u64::from_le_bytes(data[40..48].try_into().unwrap());
        let domain = &data[48..];

        if let Ok(v) = derive_range_for_domain_from_beta(&beta, req_id, domain, max) {
            assert!(max > 0);
            assert!(v < max);
            assert!(domain.len() <= 64);
            let v2 = derive_range_for_domain_from_beta(&beta, req_id, domain, max).unwrap();
            assert_eq!(v, v2);
        }
    }

    // 4. Fuzz String decoders with arbitrary UTF-8 / arbitrary bytes
    if let Ok(s) = std::str::from_utf8(data) {
        // base64_decode
        let _ = base64_decode(s);

        // base32_decode
        let _ = base32_decode(s);

        // strkey_decode_contract
        if let Ok(contract_hash) = strkey_decode_contract(s) {
            // Roundtrip invariant: re-encoding must match the valid input
            let reencoded = strkey_encode_contract(&contract_hash);
            assert_eq!(reencoded, s);
        }

        // decode_scval_b64 (XDR decoding from base64)
        let _ = decode_scval_b64(s);
    }

    // 5. Encoding helpers must never panic on arbitrary byte inputs
    let _ = to_hex(data);
    if data.len() >= 32 {
        let _ = strkey_encode_ed25519(&data[0..32]);
        let _ = strkey_encode_contract(&data[0..32]);
    }
});
