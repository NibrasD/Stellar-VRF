use ark_bls12_381::G2Affine;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use std::ops::Neg;
use ark_ec::AffineRepr;

#[test]
fn test_print_g2() {
    let compressed_pk_hex = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
    let bytes = hex::decode(compressed_pk_hex).unwrap();
    let pk = G2Affine::deserialize_compressed(&*bytes).unwrap();
    
    // Negate it
    let pk_neg = pk.neg();
    
    // Uncompressed bytes
    let mut uncompressed_pk = Vec::new();
    pk_neg.serialize_uncompressed(&mut uncompressed_pk).unwrap();
    
    let mut uncompressed_gen = Vec::new();
    let gen = G2Affine::generator();
    gen.serialize_uncompressed(&mut uncompressed_gen).unwrap();
    
    println!("PK_NEG: {}", hex::encode(uncompressed_pk));
    println!("GEN: {}", hex::encode(uncompressed_gen));
}
