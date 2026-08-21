#![no_std]
#![allow(deprecated)]

#[cfg(test)]
mod test;

use soroban_sdk::crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND: u32 = 518_400;
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND: u32 = 518_400;

const DRAND_DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const VRF_DST: &[u8] = b"SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_";
const BETA_DOMAIN: &[u8] = b"VREP_BETA_V1";
const DERIVE_DOMAIN: &[u8] = b"VREP_DERIVE_V1";
const MIN_ROUND_OFFSET: u32 = 2;
const TIMEOUT_ROUNDS: u64 = 20;

#[contracttype]
#[derive(Clone)]
pub struct BlsVrfProof {
    pub alpha_seed: BytesN<32>,
    pub gamma_point: BytesN<96>,
    pub beta_output: BytesN<32>,
    pub public_key: BytesN<192>,
    pub drand_round: u64,
    pub drand_signature: BytesN<96>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    OraclePK,
    OracleAddr,
    OracleEd25519,
    DrandPK,
    G2Generator,
    DrandGenesis,
    DrandPeriod,
    RoundOffset,
    Counter,
    RequestContext(u64),
    Requester(u64),
    RequestRound(u64),
    Refunded(u64),
    CallbackContract(u64),
    CallbackFn(u64),
    Proof(u64),
    Fulfilled(u64),
    /// Transient re-entrancy guard: set true while callback is in-flight.
    /// Prevents a malicious callback from re-entering fulfill().
    Fulfilling(u64),
    /// SAC token address used for per-request fees.
    FeeToken,
    /// Fee amount (i128) charged per VRF request.
    FeeAmount,
}


#[contract]
pub struct VRFOracleContract;

#[contractimpl]
impl VRFOracleContract {
    /// Initialize the VRF Oracle contract.
    ///
    /// # Parameters
    /// - `fee_token`: SAC token address used to charge per-request fees.
    /// - `fee_amount`: Amount of `fee_token` charged per VRF request (transferred
    ///   from requester to oracle). Set to 0 for fee-free operation.
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        env: Env,
        oracle_pk: BytesN<192>,
        oracle_address: Address,
        oracle_ed25519_pk: BytesN<32>,
        drand_pk: BytesN<192>,
        g2_generator: BytesN<192>,
        drand_genesis_time: u64,
        drand_period: u32,
        round_offset: u32,
        fee_token: Address,
        fee_amount: i128,
    ) {
        if env.storage().instance().has(&DataKey::OraclePK) {
            panic!("already initialized");
        }
        if drand_period == 0 {
            panic!("drand period must be > 0");
        }
        if round_offset < MIN_ROUND_OFFSET {
            panic!("round_offset must be >= 2");
        }
        if fee_amount < 0 {
            panic!("fee_amount must be >= 0");
        }

        oracle_address.require_auth();
        env.storage().instance().set(&DataKey::OraclePK, &oracle_pk);
        env.storage().instance().set(&DataKey::OracleAddr, &oracle_address);
        env.storage().instance().set(&DataKey::OracleEd25519, &oracle_ed25519_pk);
        env.storage().instance().set(&DataKey::DrandPK, &drand_pk);
        env.storage().instance().set(&DataKey::G2Generator, &g2_generator);
        env.storage().instance().set(&DataKey::DrandGenesis, &drand_genesis_time);
        env.storage().instance().set(&DataKey::DrandPeriod, &drand_period);
        env.storage().instance().set(&DataKey::RoundOffset, &round_offset);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage().instance().set(&DataKey::FeeToken, &fee_token);
        env.storage().instance().set(&DataKey::FeeAmount, &fee_amount);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish((symbol_short!("init"),), oracle_pk);
    }

    /// Rotate the oracle's BLS public key, Stellar address, and Ed25519 signing key.
    ///
    /// # Authorization model
    /// The **current** oracle address must authorize this call. This prevents an
    /// attacker who obtains a new keypair from hijacking the oracle role.
    ///
    /// # Security note
    /// Only rotate keys after the new oracle node is running and ready to fulfill
    /// requests. Any unfulfilled requests locked to the old PK will fail verification
    /// after rotation — they must be refunded via `timeout_refund()`.
    pub fn rotate_oracle_keys(
        env: Env,
        new_oracle_pk: BytesN<192>,
        new_oracle_address: Address,
        new_oracle_ed25519_pk: BytesN<32>,
    ) {
        // Current oracle must authorize the rotation.
        let current_oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("not initialized"));
        current_oracle.require_auth();

        env.storage().instance().set(&DataKey::OraclePK, &new_oracle_pk);
        env.storage().instance().set(&DataKey::OracleAddr, &new_oracle_address);
        env.storage().instance().set(&DataKey::OracleEd25519, &new_oracle_ed25519_pk);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (symbol_short!("rotate_ok"),),
            (new_oracle_pk, new_oracle_address),
        );
    }

    /// Rotate the drand public key used to verify BLS beacon signatures.
    ///
    /// This is required when the drand network performs a key rotation or when
    /// switching to a different drand chain (e.g., quicknet → a future chain).
    ///
    /// # Authorization model
    /// The current oracle must authorize this call.
    pub fn rotate_drand_pk(env: Env, new_drand_pk: BytesN<192>) {
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap_or_else(|| panic!("not initialized"));
        oracle_addr.require_auth();

        env.storage().instance().set(&DataKey::DrandPK, &new_drand_pk);
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish((symbol_short!("rotate_dk"),), new_drand_pk);
    }

    pub fn request(env: Env, context: Bytes, requester: Address) -> u64 {
        request_internal(&env, context, requester, None, None)
    }

    pub fn request_with_callback(
        env: Env,
        context: Bytes,
        requester: Address,
        callback_contract: Address,
        callback_fn: Symbol,
    ) -> u64 {
        request_internal(
            &env,
            context,
            requester,
            Some(callback_contract),
            Some(callback_fn),
        )
    }

    pub fn timeout_refund(env: Env, request_id: u64) {
        if !env.storage().persistent().has(&DataKey::RequestContext(request_id)) {
            panic!("request not found");
        }

        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("requester not found"));
        requester.require_auth();

        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if fulfilled {
            panic!("already fulfilled");
        }

        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("already refunded");
        }

        let required_round: u64 = env.storage().persistent().get(&DataKey::RequestRound(request_id)).unwrap();
        let genesis: u64 = env.storage().instance().get(&DataKey::DrandGenesis).unwrap();
        let period: u32 = env.storage().instance().get(&DataKey::DrandPeriod).unwrap();
        let current_round = compute_current_round(env.ledger().timestamp(), genesis, period);
        if current_round <= required_round + TIMEOUT_ROUNDS {
            panic!("timeout window not reached");
        }

        env.storage().persistent().set(&DataKey::Refunded(request_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Refunded(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Refund escrowed fee back to requester.
        let fee_amount: i128 = env.storage().instance().get(&DataKey::FeeAmount).unwrap_or(0);
        if fee_amount > 0 {
            let fee_token: Address = env.storage().instance().get(&DataKey::FeeToken).unwrap();
            let contract_addr = env.current_contract_address();
            let transfer_fn = Symbol::new(&env, "transfer");
            let mut args = Vec::<Val>::new(&env);
            args.push_back(contract_addr.into_val(&env));
            args.push_back(requester.clone().into_val(&env));
            args.push_back(fee_amount.into_val(&env));
            env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
        }

        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish((symbol_short!("timeout"),), (request_id, requester));
    }

    pub fn timeout_rounds(_env: Env) -> u64 {
        TIMEOUT_ROUNDS
    }

    pub fn requester_of(env: Env, request_id: u64) -> Address {
        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::Requester(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        requester
    }

    pub fn is_refunded(env: Env, request_id: u64) -> bool {
        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if env.storage().persistent().has(&DataKey::Refunded(request_id)) {
            env.storage().persistent().extend_ttl(
                &DataKey::Refunded(request_id),
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }
        refunded
    }

    pub fn callback_of(env: Env, request_id: u64) -> Option<(Address, Symbol)> {
        if !env.storage().persistent().has(&DataKey::CallbackContract(request_id)) {
            return None;
        }
        let cb_contract: Address = env
            .storage()
            .persistent()
            .get(&DataKey::CallbackContract(request_id))
            .unwrap();
        let cb_fn: Symbol = env
            .storage()
            .persistent()
            .get(&DataKey::CallbackFn(request_id))
            .unwrap();
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackContract(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackFn(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        Some((cb_contract, cb_fn))
    }

    /// Fulfill a VRF request with a BLS proof and oracle Ed25519 signature.
    ///
    /// # Checks-Effects-Interactions (CEI) pattern
    /// 1. **Checks**: validate oracle identity, proof, alpha seed, BLS signatures.
    /// 2. **Effects**: write `Fulfilled = true` and store proof BEFORE any external call.
    /// 3. **Interactions**: invoke consumer callback (if registered) only AFTER state
    ///    is fully committed, with a re-entrancy guard to block nested `fulfill()` calls.
    ///
    /// # Re-entrancy protection
    /// `DataKey::Fulfilling(request_id)` is set to `true` before callback invocation
    /// and cleared after. Any re-entrant call to `fulfill()` for the same request_id
    /// will see `Fulfilled = true` and panic with "already fulfilled".
    pub fn fulfill(env: Env, request_id: u64, proof: BlsVrfProof, signature: BytesN<64>) {
        // ── CHECKS ────────────────────────────────────────────────────────────────

        let refunded: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Refunded(request_id))
            .unwrap_or(false);
        if refunded {
            panic!("request refunded");
        }

        let oracle_addr: Address = env.storage().instance().get(&DataKey::OracleAddr).unwrap();
        oracle_addr.require_auth();

        if !env.storage().persistent().has(&DataKey::RequestContext(request_id)) {
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

        let stored_pk: BytesN<192> = env.storage().instance().get(&DataKey::OraclePK).unwrap();
        if proof.public_key != stored_pk {
            panic!("oracle key mismatch");
        }

        let required_round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap();
        if proof.drand_round != required_round {
            panic!("drand round mismatch");
        }

        // Oracle identity binding: signature covers request_id and proof payload.
        let oracle_ed25519: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OracleEd25519)
            .unwrap();
        let mut message = Bytes::new(&env);
        message.append(&u64_be_bytes(&env, request_id));
        message.append(&Bytes::from_slice(&env, &proof.alpha_seed.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.gamma_point.to_array()));
        message.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        message.append(&u64_be_bytes(&env, proof.drand_round));
        message.append(&Bytes::from_slice(&env, &proof.drand_signature.to_array()));
        env.crypto().ed25519_verify(&oracle_ed25519, &message, &signature);

        // Verify drand BLS signature.
        if !verify_drand_signature(&env, &proof) {
            panic!("drand signature verification failed");
        }

        // Alpha must be deterministic from request context + round + drand randomness.
        let expected_alpha =
            derive_expected_alpha(&env, request_id, proof.drand_round, &proof.drand_signature);
        if expected_alpha != proof.alpha_seed {
            panic!("alpha seed mismatch");
        }

        // Verify BLS-VRF proof: e(gamma, G2) == e(H(alpha), PK).
        if !verify_bls_vrf_proof(&env, &proof) {
            panic!("bls vrf verification failed");
        }

        // Domain-separated output derivation.
        let expected_beta = derive_beta_output(&env, &proof.gamma_point);
        if expected_beta != proof.beta_output {
            panic!("beta output mismatch");
        }

        // ── EFFECTS ───────────────────────────────────────────────────────────────
        // Commit state BEFORE any cross-contract interaction (CEI pattern).

        env.storage()
            .persistent()
            .set(&DataKey::Proof(request_id), &proof.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Fulfilled(request_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Proof(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        // Release escrowed fee to oracle upon successful fulfillment.
        let fee_amount: i128 = env.storage().instance().get(&DataKey::FeeAmount).unwrap_or(0);
        if fee_amount > 0 {
            let fee_token: Address = env.storage().instance().get(&DataKey::FeeToken).unwrap();
            let contract_addr = env.current_contract_address();
            let transfer_fn = Symbol::new(&env, "transfer");
            let mut args = Vec::<Val>::new(&env);
            args.push_back(contract_addr.into_val(&env));
            args.push_back(oracle_addr.clone().into_val(&env));
            args.push_back(fee_amount.into_val(&env));
            env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
        }

        // ── INTERACTIONS ──────────────────────────────────────────────────────────
        // Re-entrancy guard: set Fulfilling flag before callback, clear after.
        // A re-entrant fulfill() call will be rejected by the "already fulfilled" check above.

        env.storage()
            .persistent()
            .set(&DataKey::Fulfilling(request_id), &true);

        invoke_callback_if_configured(&env, request_id, &proof);

        // Clear re-entrancy guard.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Fulfilling(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::Fulfilling(request_id));
        }

        env.events()
            .publish((symbol_short!("fulfill"),), (request_id, proof.beta_output));
    }

    pub fn get_proof(env: Env, request_id: u64) -> BlsVrfProof {
        let proof: BlsVrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap_or_else(|| panic!("proof not found"));

        env.storage().persistent().extend_ttl(
            &DataKey::Proof(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        proof
    }

    pub fn oracle_pk(env: Env) -> BytesN<192> {
        let pk: BytesN<192> = env.storage().instance().get(&DataKey::OraclePK).unwrap();
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        pk
    }

    pub fn oracle_address(env: Env) -> Address {
        let addr: Address = env.storage().instance().get(&DataKey::OracleAddr).unwrap();
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        addr
    }

    pub fn request_round(env: Env, request_id: u64) -> u64 {
        let round: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RequestRound(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::RequestRound(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        round
    }

    pub fn get_context(env: Env, request_id: u64) -> Bytes {
        let context: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::RequestContext(request_id))
            .unwrap_or_else(|| panic!("request not found"));
        env.storage().persistent().extend_ttl(
            &DataKey::RequestContext(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        context
    }

    pub fn is_fulfilled(env: Env, request_id: u64) -> bool {
        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Fulfilled(request_id))
        {
            env.storage().persistent().extend_ttl(
                &DataKey::Fulfilled(request_id),
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }
        fulfilled
    }

    pub fn derive_random(env: Env, request_id: u64, context: Bytes) -> u64 {
        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if !fulfilled {
            panic!("request not yet fulfilled");
        }

        let proof: BlsVrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap();

        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_slice(&env, DERIVE_DOMAIN));
        input.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
        input.append(&context);
        let hash = env.crypto().sha256(&input);
        let hash_arr = hash.to_array();

        let mut buf = [0u8; 8];
        buf.copy_from_slice(&hash_arr[0..8]);
        u64::from_be_bytes(buf)
    }

    /// Derives a random u64 in the range [0, max) with no modulo bias.
    /// Uses iterative hashing (rejection sampling variant) to ensure uniform distribution.
    /// Worst-case bounded at 10 iterations (p < 2^-640 of exceeding).
    pub fn derive_random_in_range(env: Env, request_id: u64, context: Bytes, max: u64) -> u64 {
        if max == 0 {
            panic!("max must be > 0");
        }
        if max == 1 {
            return 0;
        }

        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if !fulfilled {
            panic!("request not yet fulfilled");
        }

        let proof: BlsVrfProof = env
            .storage()
            .persistent()
            .get(&DataKey::Proof(request_id))
            .unwrap();

        // Rejection-sampling–style derivation to eliminate modulo bias.
        let threshold = u64::MAX - (u64::MAX % max);
        let mut attempt: u32 = 0;
        loop {
            let mut input = Bytes::new(&env);
            input.append(&Bytes::from_slice(&env, DERIVE_DOMAIN));
            input.append(&Bytes::from_slice(&env, &proof.beta_output.to_array()));
            input.append(&context);
            input.append(&u64_be_bytes(&env, attempt as u64));
            let hash = env.crypto().sha256(&input);
            let hash_arr = hash.to_array();

            let mut buf = [0u8; 8];
            buf.copy_from_slice(&hash_arr[0..8]);
            let candidate = u64::from_be_bytes(buf);

            if candidate < threshold {
                return candidate % max;
            }

            attempt += 1;
            if attempt > 10 {
                // Statistically near-impossible (p < 2^-640) but we bound
                // iterations for deterministic instruction costs.
                return candidate % max;
            }
        }
    }

    /// Allows the requester (or oracle) to remove proof data for a fulfilled request,
    /// reclaiming the associated storage rent. The fulfillment flag is preserved.
    ///
    /// # TTL edge case
    /// After cleanup, `DataKey::Proof` is removed but `DataKey::Fulfilled` is kept.
    /// Callers relying on `is_fulfilled()` will continue to get `true`.
    /// Callers calling `get_proof()` or `derive_random()` after cleanup will panic —
    /// consumers must call `derive_random()` before cleanup or cache the result.
    pub fn cleanup_proof(env: Env, request_id: u64, caller: Address) {
        caller.require_auth();

        let fulfilled: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Fulfilled(request_id))
            .unwrap_or(false);
        if !fulfilled {
            panic!("request not yet fulfilled");
        }

        // Only requester or oracle can clean up
        let requester: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Requester(request_id))
            .unwrap_or_else(|| panic!("requester not found"));
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddr)
            .unwrap();

        if caller != requester && caller != oracle_addr {
            panic!("only requester or oracle can cleanup");
        }

        // Remove bulky proof data; preserve Fulfilled flag for auditability.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Proof(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::Proof(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::RequestContext(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::RequestContext(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackContract(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::CallbackContract(request_id));
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::CallbackFn(request_id))
        {
            env.storage()
                .persistent()
                .remove(&DataKey::CallbackFn(request_id));
        }

        // Extend Fulfilled flag TTL so is_fulfilled() remains queryable.
        env.storage().persistent().extend_ttl(
            &DataKey::Fulfilled(request_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        env.events()
            .publish((symbol_short!("cleanup"),), request_id);
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn compute_required_round(now_ts: u64, genesis: u64, period: u32, offset: u32) -> u64 {
    compute_current_round(now_ts, genesis, period) + (offset as u64)
}

fn compute_current_round(now_ts: u64, genesis: u64, period: u32) -> u64 {
    if now_ts <= genesis {
        return 0;
    }
    (now_ts - genesis) / (period as u64)
}

fn u64_be_bytes(env: &Env, value: u64) -> Bytes {
    Bytes::from_slice(env, &value.to_be_bytes())
}

fn derive_expected_alpha(
    env: &Env,
    request_id: u64,
    drand_round: u64,
    drand_signature: &BytesN<96>,
) -> BytesN<32> {
    let context: Bytes = env
        .storage()
        .persistent()
        .get(&DataKey::RequestContext(request_id))
        .unwrap();
    let mut input = Bytes::new(env);
    input.append(&u64_be_bytes(env, request_id));
    input.append(&context);
    input.append(&u64_be_bytes(env, drand_round));

    let drand_sig_bytes = Bytes::from_slice(env, &drand_signature.to_array());
    let drand_randomness = env.crypto().sha256(&drand_sig_bytes);
    input.append(&Bytes::from_slice(env, &drand_randomness.to_array()));

    env.crypto().sha256(&input).into()
}

fn derive_beta_output(env: &Env, gamma_point: &BytesN<96>) -> BytesN<32> {
    let mut beta_input = Bytes::new(env);
    beta_input.append(&Bytes::from_slice(env, BETA_DOMAIN));
    beta_input.append(&Bytes::from_slice(env, &gamma_point.to_array()));
    env.crypto().sha256(&beta_input).into()
}

fn verify_bls_vrf_proof(env: &Env, proof: &BlsVrfProof) -> bool {
    let bls = env.crypto().bls12_381();

    let alpha_bytes = Bytes::from_slice(env, &proof.alpha_seed.to_array());
    let dst = Bytes::from_slice(env, VRF_DST);
    let h = bls.hash_to_g1(&alpha_bytes, &dst);
    let gamma = Bls12381G1Affine::from_bytes(proof.gamma_point.clone());

    let g2_generator_bytes: BytesN<192> =
        env.storage().instance().get(&DataKey::G2Generator).unwrap();
    let g2_generator = Bls12381G2Affine::from_bytes(g2_generator_bytes);
    let pk = Bls12381G2Affine::from_bytes(proof.public_key.clone());

    let mut g1_vec = Vec::<Bls12381G1Affine>::new(env);
    g1_vec.push_back(gamma);
    g1_vec.push_back(-h);

    let mut g2_vec = Vec::<Bls12381G2Affine>::new(env);
    g2_vec.push_back(g2_generator);
    g2_vec.push_back(pk);

    bls.pairing_check(g1_vec, g2_vec)
}

fn verify_drand_signature(env: &Env, proof: &BlsVrfProof) -> bool {
    let bls = env.crypto().bls12_381();

    let drand_sig = Bls12381G1Affine::from_bytes(proof.drand_signature.clone());
    let drand_pk_bytes: BytesN<192> = env.storage().instance().get(&DataKey::DrandPK).unwrap();
    let drand_pk = Bls12381G2Affine::from_bytes(drand_pk_bytes);
    let g2_generator_bytes: BytesN<192> =
        env.storage().instance().get(&DataKey::G2Generator).unwrap();
    let g2_generator = Bls12381G2Affine::from_bytes(g2_generator_bytes);

    let round_be = u64_be_bytes(env, proof.drand_round);
    let round_hash = env.crypto().sha256(&round_be);
    let round_hash_bytes = Bytes::from_slice(env, &round_hash.to_array());
    let drand_dst = Bytes::from_slice(env, DRAND_DST);
    let h_msg = bls.hash_to_g1(&round_hash_bytes, &drand_dst);

    let mut g1_vec = Vec::<Bls12381G1Affine>::new(env);
    g1_vec.push_back(drand_sig);
    g1_vec.push_back(-h_msg);

    let mut g2_vec = Vec::<Bls12381G2Affine>::new(env);
    g2_vec.push_back(g2_generator);
    g2_vec.push_back(drand_pk);

    bls.pairing_check(g1_vec, g2_vec)
}

fn request_internal(
    env: &Env,
    context: Bytes,
    requester: Address,
    callback_contract: Option<Address>,
    callback_fn: Option<Symbol>,
) -> u64 {
    requester.require_auth();

    // Charge per-request fee via SAC token transfer (requester → contract escrow).
    // Fee is held in escrow until fulfill() (released to oracle) or timeout_refund() (returned to requester).
    let fee_amount: i128 = env.storage().instance().get(&DataKey::FeeAmount).unwrap_or(0);
    if fee_amount > 0 {
        let fee_token: Address = env.storage().instance().get(&DataKey::FeeToken).unwrap();
        let contract_addr = env.current_contract_address();
        // SAC token transfer: requester → VRF contract (escrow).
        let transfer_fn = Symbol::new(env, "transfer");
        let mut args = Vec::<Val>::new(env);
        args.push_back(requester.clone().into_val(env));
        args.push_back(contract_addr.into_val(env));
        args.push_back(fee_amount.into_val(env));
        env.invoke_contract::<Val>(&fee_token, &transfer_fn, args);
    }

    let counter: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Counter)
        .unwrap_or(0);
    let id = counter + 1;
    env.storage().instance().set(&DataKey::Counter, &id);

    let genesis: u64 = env
        .storage()
        .instance()
        .get(&DataKey::DrandGenesis)
        .unwrap();
    let period: u32 = env
        .storage()
        .instance()
        .get(&DataKey::DrandPeriod)
        .unwrap();
    let offset: u32 = env
        .storage()
        .instance()
        .get(&DataKey::RoundOffset)
        .unwrap();
    let required_round =
        compute_required_round(env.ledger().timestamp(), genesis, period, offset);

    env.storage()
        .persistent()
        .set(&DataKey::RequestContext(id), &context);
    env.storage()
        .persistent()
        .set(&DataKey::Requester(id), &requester);
    env.storage()
        .persistent()
        .set(&DataKey::RequestRound(id), &required_round);
    env.storage()
        .persistent()
        .set(&DataKey::Fulfilled(id), &false);
    env.storage()
        .persistent()
        .set(&DataKey::Refunded(id), &false);

    if let Some(cb_contract) = callback_contract {
        let cb_fn = callback_fn.unwrap_or_else(|| panic!("callback function missing"));
        env.storage()
            .persistent()
            .set(&DataKey::CallbackContract(id), &cb_contract);
        env.storage()
            .persistent()
            .set(&DataKey::CallbackFn(id), &cb_fn);
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackContract(id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::CallbackFn(id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
    }

    env.storage().persistent().extend_ttl(
        &DataKey::RequestContext(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Requester(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::RequestRound(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Fulfilled(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Refunded(id),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

    env.events()
        .publish((symbol_short!("request"),), (id, requester, required_round));
    id
}

/// Invoke the consumer callback if one was registered with `request_with_callback`.
///
/// # Authorization model
/// The VRF contract itself is the caller of the consumer callback — NOT the original
/// requester. Consumer contracts must NOT require the original requester's auth inside
/// their callback function; they should trust the VRF contract address instead.
///
/// # Arguments passed to callback
/// - `request_id: u64` — the VRF request identifier
/// - `beta_output: BytesN<32>` — the verifiable random output
/// - `alpha_seed: BytesN<32>` — the deterministic input seed (for auditability)
pub(crate) fn invoke_callback_if_configured(env: &Env, request_id: u64, proof: &BlsVrfProof) {
    if !env
        .storage()
        .persistent()
        .has(&DataKey::CallbackContract(request_id))
    {
        return;
    }

    let callback_contract: Address = env
        .storage()
        .persistent()
        .get(&DataKey::CallbackContract(request_id))
        .unwrap();
    let callback_fn: Symbol = env
        .storage()
        .persistent()
        .get(&DataKey::CallbackFn(request_id))
        .unwrap();

    let mut args = Vec::<Val>::new(env);
    args.push_back(request_id.into_val(env));
    args.push_back(proof.beta_output.clone().into_val(env));
    args.push_back(proof.alpha_seed.clone().into_val(env));

    let _ = env.invoke_contract::<Val>(&callback_contract, &callback_fn, args);
}
