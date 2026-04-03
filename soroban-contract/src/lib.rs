#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Bytes, BytesN, Env, String,
};

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
    Counter,
    RequestSeed(u64),
    Proof(u64),
    Fulfilled(u64),
}

#[contract]
pub struct VRFOracleContract;

#[contractimpl]
impl VRFOracleContract {
    pub fn init(env: Env, oracle_pk: BytesN<33>) {
        if env.storage().instance().has(&DataKey::OraclePK) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::OraclePK, &oracle_pk);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.events().publish(
            (symbol_short!("init"),),
            oracle_pk,
        );
    }

    pub fn request(env: Env, alpha_seed: Bytes, requester: String) -> u64 {
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
        env.events().publish(
            (symbol_short!("request"),),
            (id, requester),
        );
        id
    }

    pub fn fulfill(env: Env, request_id: u64, proof: EcvrfProof) {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::RequestSeed(request_id))
        {
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
        env.storage()
            .persistent()
            .set(&DataKey::Proof(request_id), &proof.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(request_id), &true);
        env.events().publish(
            (symbol_short!("fulfill"),),
            (request_id, proof.beta_output),
        );
    }

    pub fn get_proof(env: Env, request_id: u64) -> EcvrfProof {
        env.storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"))
    }

    pub fn oracle_pk(env: Env) -> BytesN<33> {
        env.storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap()
    }

    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false)
    }
}
