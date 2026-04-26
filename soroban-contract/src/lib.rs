#![no_std]
mod ecvrf;
#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env,
};

const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND: u32 = 518_400;
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND: u32 = 518_400;

#[contracttype]
#[derive(Clone)]
pub struct EcvrfProof {
    pub alpha_seed:  Bytes,
    pub gamma_point: BytesN<33>,
    pub c_scalar:    BytesN<16>,
    pub s_scalar:    BytesN<32>,
    pub beta_output: BytesN<32>,
    pub public_key:  BytesN<33>,
}

#[contracttype]
pub enum DataKey {
    OraclePK,
    OracleAddr,
    OracleEd25519,
    Counter,
    RequestSeed(u64),
    Proof(u64),
    Fulfilled(u64),
}

#[contract]
pub struct VRFOracleContract;

#[contractimpl]
impl VRFOracleContract {
    pub fn init(
        env: Env,
        oracle_pk: BytesN<33>,
        oracle_address: Address,
        oracle_ed25519_pk: BytesN<32>,
    ) {
        if env.storage().instance().has(&DataKey::OraclePK) {
            panic!("already initialized");
        }
        oracle_address.require_auth();
        env.storage().instance().set(&DataKey::OraclePK, &oracle_pk);
        env.storage().instance().set(&DataKey::OracleAddr, &oracle_address);
        env.storage().instance().set(&DataKey::OracleEd25519, &oracle_ed25519_pk);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        env.events().publish(
            (symbol_short!("init"),),
            oracle_pk,
        );
    }

    pub fn request(env: Env, alpha_seed: Bytes, requester: Address) -> u64 {
        requester.require_auth();

        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0);
        let id = counter + 1;
        env.storage().instance().set(&DataKey::Counter, &id);
        env.storage()
            .persistent()
            .set(&DataKey::RequestSeed(id), &alpha_seed);
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(id), &false);

        env.storage().persistent().extend_ttl(
            &DataKey::RequestSeed(id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
        );
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (symbol_short!("request"),),
            (id, requester),
        );
        id
    }

    pub fn fulfill(env: Env, request_id: u64, proof: EcvrfProof, signature: BytesN<64>) {
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap();
        oracle_addr.require_auth();

        if !env.storage().persistent().has(&DataKey::RequestSeed(request_id)) {
            panic!("request not found");
        }

        let already: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if already {
            panic!("already fulfilled");
        }

        let stored_pk: BytesN<33> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap();
        if proof.public_key != stored_pk {
            panic!("oracle key mismatch");
        }

        let oracle_ed25519: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OracleEd25519)
            .unwrap();

        let mut message = Bytes::new(&env);
        let mut rid_bytes = [0u8; 8];
        rid_bytes[0] = (request_id >> 56) as u8;
        rid_bytes[1] = (request_id >> 48) as u8;
        rid_bytes[2] = (request_id >> 40) as u8;
        rid_bytes[3] = (request_id >> 32) as u8;
        rid_bytes[4] = (request_id >> 24) as u8;
        rid_bytes[5] = (request_id >> 16) as u8;
        rid_bytes[6] = (request_id >> 8) as u8;
        rid_bytes[7] = request_id as u8;
        message.append(&Bytes::from_slice(&env, &rid_bytes));
        message.append(&Bytes::from_slice(&env, &proof.gamma_point.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.c_scalar.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.s_scalar.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        env.crypto().ed25519_verify(&oracle_ed25519, &message, &signature);

        // ── 6. Alpha seed integrity: proof.alpha_seed must match stored seed ──
        let stored_seed: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::RequestSeed(request_id))
            .unwrap();
        if proof.alpha_seed != stored_seed {
            panic!("alpha seed mismatch");
        }

        // ── 7. On-chain ECVRF cryptographic verification (feature-gated) ──
        #[cfg(feature = "ecvrf")]
        {
            let gamma_arr = proof.gamma_point.to_array();
            let c_arr = proof.c_scalar.to_array();
            let s_arr = proof.s_scalar.to_array();
            let pk_arr = proof.public_key.to_array();
            match ecvrf::onchain::verify_ecvrf(
                &proof.alpha_seed,
                &gamma_arr,
                &c_arr,
                &s_arr,
                &pk_arr,
            ) {
                Ok(true) => { /* proof is valid */ }
                Ok(false) => panic!("ECVRF proof verification failed: challenge mismatch"),
                Err(e) => panic!("ECVRF proof verification error: {}", e),
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proof(request_id), &proof.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(request_id), &true);

        env.storage().persistent().extend_ttl(
            &DataKey::Proof(request_id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
        );
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (symbol_short!("fulfill"),),
            (request_id, proof.beta_output),
        );
    }

    pub fn get_proof(env: Env, request_id: u64) -> EcvrfProof {
        let proof: EcvrfProof = env.storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::Proof(request_id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
        );
        proof
    }

    pub fn oracle_pk(env: Env) -> BytesN<33> {
        let pk: BytesN<33> = env.storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap();
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        pk
    }

    pub fn oracle_address(env: Env) -> Address {
        let addr: Address = env.storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap();
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        addr
    }

    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        let fulfilled: bool = env.storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if env.storage().persistent().has(&DataKey::Fulfilled(request_id)) {
            env.storage().persistent().extend_ttl(
                &DataKey::Fulfilled(request_id), PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND,
            );
        }
        fulfilled
    }

    /// Derive a deterministic random u64 from a fulfilled proof.
    /// Consumer contracts call this to get randomness scoped by `context`.
    /// The same (request_id, context) always returns the same value.
    pub fn derive_random(env: Env, request_id: u64, context: Bytes) -> u64 {
        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if !fulfilled {
            panic!("request not yet fulfilled");
        }

        let proof: EcvrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap();

        // Deterministic: SHA256(beta_output || context) → first 8 bytes → u64
        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        input.append(&context);
        let hash = env.crypto().sha256(&input);
        let hash_arr = hash.to_array();

        let mut buf = [0u8; 8];
        buf[0] = hash_arr[0];
        buf[1] = hash_arr[1];
        buf[2] = hash_arr[2];
        buf[3] = hash_arr[3];
        buf[4] = hash_arr[4];
        buf[5] = hash_arr[5];
        buf[6] = hash_arr[6];
        buf[7] = hash_arr[7];
        u64::from_be_bytes(buf)
    }
}
