#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, String,
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

    pub fn fulfill(env: Env, request_id: u64, proof: EcvrfProof, signature: BytesN<64>) {
        // 1. Access control: only the registered oracle address can call fulfill
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap();
        oracle_addr.require_auth();

        // 2. Verify request exists
        if !env.storage().persistent().has(&DataKey::RequestSeed(request_id)) {
            panic!("request not found");
        }

        // 3. Check not already fulfilled
        let already: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if already {
            panic!("already fulfilled");
        }

        // 4. Verify proof.public_key matches the stored oracle secp256k1 PK
        let stored_pk: BytesN<33> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap();
        if proof.public_key != stored_pk {
            panic!("oracle key mismatch");
        }

        // 5. Ed25519 signature verification on proof data
        //    message = gamma_point(33) || c_scalar(16) || s_scalar(32) || beta_output(32) = 113 bytes
        let oracle_ed25519: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OracleEd25519)
            .unwrap();

        let mut message = Bytes::new(&env);
        message.append(&Bytes::from_slice(&env, &proof.gamma_point.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.c_scalar.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.s_scalar.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        env.crypto().ed25519_verify(&oracle_ed25519, &message, &signature);

        // 6. Store proof and mark fulfilled
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

    pub fn oracle_address(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap()
    }

    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false)
    }
}
