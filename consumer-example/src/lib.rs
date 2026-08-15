//! # VRF Consumer Example Contract
//!
//! Demonstrates consuming verifiable randomness from the Soroban VRF Oracle.
//! This example implements a **scientific random sampling** use-case:
//! a contract that requests cryptographically verifiable random samples
//! for use in statistical simulations, Monte Carlo methods, or fair selection.
//!
//! ## Usage pattern
//!
//! ```text
//! 1. Consumer calls: request_sample(requester, range_max) → sample_id
//! 2. Internally:     VRF.request_with_callback(ctx, self_address, Symbol::new("on_vrf"))
//! 3. Oracle fulfills: VRF.fulfill(sample_id, proof, sig)
//! 4. VRF calls back: Consumer.on_vrf(sample_id, beta_output, alpha_seed)
//! 5. Consumer stores: random_value ∈ [0, range_max)
//! ```
//!
//! ## Authorization model
//!
//! The VRF contract is the **caller** of `on_vrf`, NOT the original requester.
//! Consumer contracts MUST call `vrf_contract.require_auth()` inside the callback.
//!
//! ## Security notes
//!
//! - Validate `sample_id` belongs to a pending request your contract initiated.
//! - Implement idempotency: reject duplicate on_vrf calls for the same sample_id.
//! - The `beta_output` is deterministic given the same `alpha_seed` and oracle key.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal,
    Symbol,
};

/// Storage keys for the consumer contract.
#[contracttype]
#[derive(Clone)]
pub enum ConsumerKey {
    /// The trusted VRF oracle contract address (set at initialization).
    VrfContract,
    /// Pending sample requests: sample_id → range_max.
    PendingSample(u64),
    /// Fulfilled random samples: sample_id → random_value ∈ [0, range_max).
    SampleResult(u64),
}

/// VRF Random Sampling Consumer Contract
///
/// Requests verifiable random samples for scientific/statistical applications.
/// Each sample is cryptographically verifiable and bias-resistant.
#[contract]
pub struct VrfSamplingContract;

#[contractimpl]
impl VrfSamplingContract {
    /// Initialize with the trusted VRF contract address.
    pub fn init(env: Env, vrf_contract: Address) {
        if env.storage().instance().has(&ConsumerKey::VrfContract) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&ConsumerKey::VrfContract, &vrf_contract);
    }

    /// Request a verifiable random sample in the range [0, range_max).
    ///
    /// Calls `request_with_callback` on the VRF contract, which will invoke
    /// `on_vrf(sample_id, beta_output, alpha_seed)` when randomness is ready.
    ///
    /// Returns the `sample_id` for tracking the request.
    pub fn request_sample(env: Env, requester: Address, range_max: u64) -> u64 {
        requester.require_auth();

        let vrf_contract: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::VrfContract)
            .unwrap_or_else(|| panic!("not initialized"));

        // Build a unique context for this sample request.
        let mut context = Bytes::new(&env);
        context.append(&Bytes::from_slice(&env, &range_max.to_be_bytes()));
        context.append(&Bytes::from_slice(
            &env,
            &env.ledger().sequence().to_be_bytes(),
        ));

        let self_addr = env.current_contract_address();
        let sample_id: u64 = env.invoke_contract(
            &vrf_contract,
            &Symbol::new(&env, "request_with_callback"),
            soroban_sdk::vec![
                &env,
                context.into_val(&env),
                self_addr.clone().into_val(&env),
                self_addr.into_val(&env),
                Symbol::new(&env, "on_vrf").into_val(&env),
            ],
        );

        // Track the pending request with its range.
        env.storage()
            .persistent()
            .set(&ConsumerKey::PendingSample(sample_id), &range_max);

        sample_id
    }

    /// VRF callback — invoked by the VRF oracle contract after fulfillment.
    ///
    /// # Authorization model
    /// Only the trusted VRF contract may call this function.
    /// We verify by calling `vrf_contract.require_auth()`.
    ///
    /// # Arguments
    /// - `sample_id`: the VRF request this callback corresponds to
    /// - `beta_output`: the 32-byte verifiable random output
    /// - `alpha_seed`: the deterministic input seed
    pub fn on_vrf(env: Env, sample_id: u64, beta_output: BytesN<32>, _alpha_seed: BytesN<32>) {
        // Authorization: only the trusted VRF contract can invoke this callback.
        let vrf_contract: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::VrfContract)
            .unwrap_or_else(|| panic!("not initialized"));
        vrf_contract.require_auth();

        // Idempotency: reject if already processed.
        if env
            .storage()
            .persistent()
            .has(&ConsumerKey::SampleResult(sample_id))
        {
            panic!("already processed");
        }

        // Validate this is a request we initiated.
        let range_max: u64 = env
            .storage()
            .persistent()
            .get(&ConsumerKey::PendingSample(sample_id))
            .unwrap_or_else(|| panic!("unknown sample_id"));

        // Derive a random value in [0, range_max) from the VRF output.
        // Using the first 8 bytes of beta_output as a u64 seed.
        let arr = beta_output.to_array();
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&arr[0..8]);
        let raw = u64::from_be_bytes(buf);
        let sample = raw % range_max;

        // Store the result.
        env.storage()
            .persistent()
            .set(&ConsumerKey::SampleResult(sample_id), &sample);

        // Clean up pending marker.
        env.storage()
            .persistent()
            .remove(&ConsumerKey::PendingSample(sample_id));

        // Emit event with the sample result.
        env.events().publish(
            (symbol_short!("sample"),),
            (sample_id, sample, range_max),
        );
    }

    /// Query the random sample result for a fulfilled request.
    ///
    /// Returns the random value ∈ [0, range_max) for the given `sample_id`.
    pub fn get_sample(env: Env, sample_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&ConsumerKey::SampleResult(sample_id))
            .unwrap_or_else(|| panic!("sample not available"))
    }

    /// Query the VRF contract address.
    pub fn vrf_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ConsumerKey::VrfContract)
            .unwrap_or_else(|| panic!("not initialized"))
    }
}
