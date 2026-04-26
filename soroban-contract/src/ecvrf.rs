// On‑chain ECVRF verification helper (feature gated)
// This module is compiled only when the Cargo feature `ecvrf` is enabled.

#[cfg(feature = "ecvrf")]
#[allow(non_snake_case)]
pub mod onchain {
    use soroban_sdk::Bytes;
    use sha2::{Digest, Sha256};
    use k256::{AffinePoint, ProjectivePoint, Scalar, FieldBytes};
    use k256::elliptic_curve::sec1::ToEncodedPoint;
    use core::convert::TryFrom;

    // Suite constants mirroring the off-chain implementation
    const SUITE_STRING: u8 = 0xfe;

    // Try-and-increment hash_to_curve implementation (TAI)
    pub fn hash_to_curve(pk_bytes: &[u8], alpha: &Bytes) -> Option<AffinePoint> {
        for ctr in 0u8..=255u8 {
            for &prefix in &[0x02u8, 0x03u8] {
                let mut hasher = Sha256::new();
                hasher.update(&[SUITE_STRING]);
                hasher.update(&[0x01]);
                hasher.update(pk_bytes);
                let mut i: u32 = 0;
                while i < alpha.len() {
                    hasher.update(&[alpha.get(i).unwrap()]);
                    i += 1;
                }
                hasher.update(&[ctr]);
                hasher.update(&[0x00]);
                let digest = hasher.finalize();
                let mut candidate = [0u8; 33];
                candidate[0] = prefix;
                candidate[1..].copy_from_slice(&digest[..32]);
                if let Ok(ep) = k256::elliptic_curve::sec1::EncodedPoint::<k256::Secp256k1>::from_bytes(&candidate) {
                    if let Ok(aff) = AffinePoint::try_from(&ep) {
                        return Some(aff);
                    }
                }
            }
        }
        None
    }

    pub fn verify_ecvrf(alpha: &Bytes, gamma_bytes: &[u8], c_bytes: &[u8], s_bytes: &[u8], pk_bytes: &[u8]) -> Result<bool, &'static str> {
        if pk_bytes.is_empty() || gamma_bytes.is_empty() || c_bytes.is_empty() || s_bytes.is_empty() {
            return Err("invalid input lengths");
        }

        // Parse public key and gamma points
        let ep_pk = k256::elliptic_curve::sec1::EncodedPoint::<k256::Secp256k1>::from_bytes(pk_bytes).map_err(|_| "invalid public key bytes")?;
        let pk_aff = AffinePoint::try_from(&ep_pk).map_err(|_| "invalid public key point")?;
        let pk_point = ProjectivePoint::from(pk_aff);

        let ep_gamma = k256::elliptic_curve::sec1::EncodedPoint::<k256::Secp256k1>::from_bytes(gamma_bytes).map_err(|_| "invalid gamma bytes")?;
        let gamma_aff = AffinePoint::try_from(&ep_gamma).map_err(|_| "invalid gamma point")?;
        let gamma = ProjectivePoint::from(gamma_aff);

        // Scalars: c is 16 bytes, s is 32 bytes
        if c_bytes.len() != 16 || s_bytes.len() != 32 { return Err("invalid scalar lengths"); }
        let mut c_padded = [0u8; 32];
        c_padded[16..32].copy_from_slice(&c_bytes);
        let mut s_arr = [0u8; 32];
        s_arr.copy_from_slice(&s_bytes);

        // Convert to FieldBytes then to Scalars (with range-check)
        let c_field: FieldBytes = c_padded.into();
        let s_field: FieldBytes = s_arr.into();
        let c_scalar = Option::from(<Scalar as k256::elliptic_curve::ff::PrimeField>::from_repr(c_field)).ok_or("invalid c scalar")?;
        let s_scalar = Option::from(<Scalar as k256::elliptic_curve::ff::PrimeField>::from_repr(s_field)).ok_or("invalid s scalar")?;

        // H = hash_to_curve(pk, alpha)
        let pk_comp_ep = pk_aff.to_encoded_point(true);
        let pk_comp_bytes = pk_comp_ep.as_bytes();
        let H_aff = hash_to_curve(pk_comp_bytes, alpha).ok_or("hash_to_curve failed")?;
        let H = ProjectivePoint::from(H_aff);

        // U' = s*G - c*PK    and   V' = s*H - c*Gamma
        let G = ProjectivePoint::GENERATOR;
        let U_prime = (G * &s_scalar) - (pk_point * &c_scalar);
        let V_prime = (H * &s_scalar) - (gamma * &c_scalar);

        // Recompute challenge c' = Hash(SUITE||0x02||PK||H||Gamma||U'||V') first 16 bytes
        let mut hasher = Sha256::new();
        hasher.update(&[SUITE_STRING]);
        hasher.update(&[0x02]);
        hasher.update(pk_comp_bytes);
        let H_ep = H.to_affine().to_encoded_point(false);
        let gamma_ep = gamma.to_affine().to_encoded_point(false);
        let U_ep = U_prime.to_affine().to_encoded_point(false);
        let V_ep = V_prime.to_affine().to_encoded_point(false);
        hasher.update(H_ep.as_bytes());
        hasher.update(gamma_ep.as_bytes());
        hasher.update(U_ep.as_bytes());
        hasher.update(V_ep.as_bytes());
        let digest = hasher.finalize();
        let c_prime = &digest[0..16];

        Ok(c_prime == c_bytes)
    }
}

#[cfg(not(feature = "ecvrf"))]
pub mod onchain {
    // Feature not enabled — placeholder implementation.
    pub fn verify_ecvrf(_alpha: &soroban_sdk::Bytes, _gamma: &[u8], _c: &[u8], _s: &[u8], _pk: &[u8]) -> Result<bool, &'static str> {
        Err("ecvrf feature not enabled at compile time")
    }
}
