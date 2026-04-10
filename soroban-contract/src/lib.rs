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
    Counter,
    RequestSeed(u64),
    Proof(u64),
    Fulfilled(u64),
}

#[contract]
pub struct VRFOracleContract;

#[contractimpl]
impl VRFOracleContract {
    /// Initialize the contract with the oracle's Stellar address and secp256k1 public key.
    /// Can only be called once. The oracle address is used for access control on fulfill().
    pub fn init(env: Env, oracle_addr: Address, oracle_pk: BytesN<33>) {
        if env.storage().instance().has(&DataKey::OraclePK) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::OraclePK, &oracle_pk);
        env.storage().instance().set(&DataKey::OracleAddr, &oracle_addr);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.events().publish(
            (symbol_short!("init"),),
            oracle_pk,
        );
    }

    /// Record a new VRF request with the given alpha seed. Returns the request ID.
    /// Anyone can submit a request — the oracle will fulfill it later.
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

    /// Fulfill a VRF request with a cryptographic proof.
    ///
    /// Security checks performed:
    ///   1. Access control — only the registered oracle address can call this
    ///   2. Request existence — the request ID must exist
    ///   3. Idempotency — the request must not already be fulfilled
    ///   4. Public key integrity — proof.public_key must match the stored oracle PK
    ///   5. Alpha seed integrity — proof.alpha_seed must match the original request seed
    pub fn fulfill(env: Env, oracle: Address, request_id: u64, proof: EcvrfProof) {
        // ── 1. Access control: require signature from the oracle address ─────
        oracle.require_auth();
        let stored_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("not initialized"));
        if oracle != stored_addr {
            panic!("unauthorized: caller is not the registered oracle");
        }

        // ── 2. Verify request exists ─────────────────────────────────────────
        let stored_seed: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::RequestSeed(request_id))
            .unwrap_or_else(|| panic!("request not found"));

        // ── 3. Prevent double fulfillment ────────────────────────────────────
        let already: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if already {
            panic!("already fulfilled");
        }

        // ── 4. Verify proof public key matches stored oracle PK ──────────────
        let stored_pk: BytesN<33> = env
            .storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap();
        if proof.public_key != stored_pk {
            panic!("public key mismatch: proof PK does not match registered oracle PK");
        }

        // ── 5. Verify proof alpha_seed matches the original request seed ─────
        if proof.alpha_seed != stored_seed {
            panic!("alpha seed mismatch: proof seed does not match request seed");
        }

        // ── All checks passed — store proof and mark fulfilled ───────────────
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

    /// Derive a deterministic random u64 from a fulfilled proof's beta output
    /// and a caller-provided context string.
    ///
    /// Different contexts yield different numbers from the same proof,
    /// enabling multiple independent random values per VRF round.
    ///
    /// Formula: SHA256(beta_output || context) → first 8 bytes as big-endian u64
    pub fn derive_random(env: Env, request_id: u64, context: Bytes) -> u64 {
        let already: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if !already {
            panic!("request not yet fulfilled");
        }

        let proof: EcvrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"));

        // Concatenate beta_output + context and hash
        let beta_as_bytes: Bytes = proof.beta_output.into();
        let mut input = Bytes::new(&env);
        input.append(&beta_as_bytes);
        input.append(&context);

        let hash: BytesN<32> = env.crypto().sha256(&input);
        let hash_bytes: Bytes = hash.into();

        // Take first 8 bytes as big-endian u64
        let mut result: u64 = 0;
        let mut i: u32 = 0;
        while i < 8 {
            result = (result << 8) | (hash_bytes.get(i).unwrap() as u64);
            i += 1;
        }

        result
    }

    /// Read the stored ECVRF proof for a given request ID.
    pub fn get_proof(env: Env, request_id: u64) -> EcvrfProof {
        env.storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"))
    }

    /// Return the stored oracle secp256k1 public key.
    pub fn oracle_pk(env: Env) -> BytesN<33> {
        env.storage()
            .instance()
            .get(&DataKey::OraclePK)
            .unwrap()
    }

    /// Return the stored oracle Stellar address (used for access control).
    pub fn oracle_addr(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap()
    }

    /// Check whether a given request has been fulfilled.
    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false)
    }
}
