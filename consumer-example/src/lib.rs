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
#![allow(unknown_lints)]
#![allow(deprecated)]
#![allow(unnecessary_admin_parameter)]
#![allow(missing_new_admin_auth)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal,
    Symbol,
};

const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND: u32 = 518_400;
const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;
const PERSISTENT_TTL_EXTEND: u32 = 518_400;

/// Storage keys for the consumer contract.
#[contracttype]
#[derive(Clone)]
pub enum ConsumerKey {
    /// Contract administrator
    Admin,
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
    /// Initialize with the trusted VRF contract address and admin.
    /// Only the deployer (admin) should call this.
    pub fn init(env: Env, admin: Address, vrf_contract: Address) {
        admin.require_auth();
        if env.storage().instance().has(&ConsumerKey::VrfContract) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&ConsumerKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&ConsumerKey::VrfContract, &vrf_contract);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (symbol_short!("init"),),
            (admin, vrf_contract),
        );
    }

    /// Request a verifiable random sample in the range [0, range_max).
    ///
    /// # Authorization
    /// Restricted to the contract `admin` to prevent unauthorized callers from
    /// triggering paid requests funded by this contract's balance.
    pub fn request_sample(env: Env, caller: Address, range_max: u64) -> u64 {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"));
        if caller != admin {
            panic!("not authorized");
        }
        if range_max == 0 {
            panic!("range_max must be greater than zero");
        }

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
        env.storage().persistent().extend_ttl(
            &ConsumerKey::PendingSample(sample_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        env.events().publish(
            (symbol_short!("req_smpl"),),
            (sample_id, caller, range_max),
        );

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

        // Derive a random value in [0, range_max) with negligible bias, using the
        // same "extra bits" reduction as the VRF contract's `derive_random_in_range()`
        // (NIST SP 800-90A B.5.1.3 style).
        //
        // Reducing only 64 bits (`raw % range_max`) is biased unless `range_max`
        // divides 2^64: the deviation between residue classes is bounded by
        // range_max / 2^64, which approaches a 50% skew as range_max approaches 2^63.
        //
        // Taking **128 bits** of beta instead bounds that deviation by
        // range_max / 2^128 <= 2^-64 — cryptographically negligible. Note this is
        // deliberately NOT a rejection loop: an unbounded loop inside a callback can
        // blow the instruction budget and make `fulfill()` revert, and a *bounded*
        // loop needs a fallback that reintroduces the very bias it set out to avoid.
        // This form is constant-cost and has no biased path at all.
        let beta_arr = beta_output.to_array();
        let mut wide = [0u8; 16];
        wide.copy_from_slice(&beta_arr[0..16]);
        let sample = (u128::from_be_bytes(wide) % (range_max as u128)) as u64;

        // Store the result.
        env.storage()
            .persistent()
            .set(&ConsumerKey::SampleResult(sample_id), &sample);
        env.storage().persistent().extend_ttl(
            &ConsumerKey::SampleResult(sample_id),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Clean up pending marker.
        env.storage()
            .persistent()
            .remove(&ConsumerKey::PendingSample(sample_id));

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);

        // Emit event with the sample result.
        env.events().publish(
            (symbol_short!("sample"),),
            (sample_id, sample, range_max),
        );
    }

    /// Query the random sample result for a fulfilled request.
    ///
    /// Returns the random value ∈ [0, range_max) for the given `sample_id`.
    /// Does not extend TTL on read to prevent unprivileged callers from pinning state.
    pub fn get_sample(env: Env, sample_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&ConsumerKey::SampleResult(sample_id))
            .unwrap_or_else(|| panic!("sample not available"))
    }

    /// Delete a fulfilled sample result to reclaim contract storage rent.
    /// Restricted to the admin.
    pub fn cleanup_sample(env: Env, caller: Address, sample_id: u64) {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"));
        if caller != admin {
            panic!("not authorized");
        }

        if env
            .storage()
            .persistent()
            .has(&ConsumerKey::SampleResult(sample_id))
        {
            env.storage()
                .persistent()
                .remove(&ConsumerKey::SampleResult(sample_id));
        }
    }

    /// Query the admin address.
    pub fn admin(env: Env) -> Address {
        let admin_addr: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        admin_addr
    }

    /// Query the VRF contract address.
    pub fn vrf_contract(env: Env) -> Address {
        let vrf: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::VrfContract)
            .unwrap_or_else(|| panic!("not initialized"));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
        vrf
    }
}
