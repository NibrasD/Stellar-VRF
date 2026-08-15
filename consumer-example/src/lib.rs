//! # VRF Consumer Example Contract
//!
//! This contract demonstrates the correct pattern for consuming randomness from the
//! Soroban VRF Oracle. It implements the `on_vrf` callback function that gets invoked
//! by the VRF contract after a request is fulfilled.
//!
//! ## Usage pattern
//!
//! ```text
//! 1. Consumer calls: VRF.request_with_callback(ctx, self_address, Symbol::new("on_vrf"))
//! 2. Oracle fulfills: VRF.fulfill(request_id, proof, sig)
//! 3. VRF contract calls back: Consumer.on_vrf(request_id, beta_output, alpha_seed)
//! 4. Consumer stores/uses the randomness
//! ```
//!
//! ## Authorization model
//!
//! The VRF contract is the **caller** of `on_vrf`, NOT the original user.
//! Consumer contracts MUST NOT require the original requester's auth inside the callback.
//! Instead, they should verify that `env.current_contract_address()` is the trusted
//! VRF contract address (stored during initialization).
//!
//! ## Security notes
//!
//! - Validate `request_id` belongs to a pending request your contract initiated.
//! - Do NOT assume `on_vrf` is called only once — implement idempotency checks.
//! - The `beta_output` is deterministic given the same `alpha_seed` and oracle key.
//!   Do not reveal `alpha_seed` in advance; it's derived from your context + drand.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, BytesN, Env, IntoVal, Symbol,
};

/// Storage keys for the consumer contract.
#[contracttype]
#[derive(Clone)]
pub enum ConsumerKey {
    /// The trusted VRF oracle contract address (set at initialization).
    VrfContract,
    /// Pending requests initiated by this contract: request_id -> context_tag.
    PendingRequest(u64),
    /// Fulfilled randomness results: request_id -> beta_output.
    RandomResult(u64),
}

/// Example: a simple dice-roll game that uses VRF randomness.
///
/// Players register a roll request, and when the oracle fulfills it,
/// `on_vrf` is called back with the randomness to determine the result (1-6).
#[contract]
pub struct VrfConsumerContract;

#[contractimpl]
impl VrfConsumerContract {
    /// Initialize with the trusted VRF contract address.
    ///
    /// The VRF contract address is stored and used to authorize callback invocations.
    pub fn init(env: Env, vrf_contract: Address) {
        if env.storage().instance().has(&ConsumerKey::VrfContract) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&ConsumerKey::VrfContract, &vrf_contract);
    }

    /// Submit a VRF randomness request for a dice roll.
    ///
    /// Calls `request_with_callback` on the VRF contract, passing this contract's
    /// address and `on_vrf` as the callback.
    ///
    /// Returns the VRF `request_id` for tracking.
    pub fn roll_dice(env: Env, player: Address, context_tag: BytesN<16>) -> u64 {
        player.require_auth();

        let vrf_contract: Address = env
            .storage()
            .instance()
            .get(&ConsumerKey::VrfContract)
            .unwrap_or_else(|| panic!("not initialized"));

        // Build a context that uniquely identifies this roll.
        let mut context = soroban_sdk::Bytes::new(&env);
        context.append(&soroban_sdk::Bytes::from_slice(
            &env,
            &context_tag.to_array(),
        ));

        // Call the VRF contract to request randomness with a callback.
        // The VRF contract will call `on_vrf(request_id, beta, alpha)` on this contract.
        let self_addr = env.current_contract_address();
        let request_id: u64 = env.invoke_contract(
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

        // Track the pending request.
        env.storage()
            .persistent()
            .set(&ConsumerKey::PendingRequest(request_id), &context_tag);

        request_id
    }

    /// VRF callback — invoked by the VRF oracle contract after fulfillment.
    ///
    /// # Authorization model
    /// This function is called by the **VRF contract**, not the original player.
    /// We verify the caller is the trusted VRF contract by requiring its auth.
    ///
    /// # Arguments
    /// - `request_id`: the VRF request this callback corresponds to
    /// - `beta_output`: the verifiable random output (32 bytes)
    /// - `alpha_seed`: the deterministic input seed used to generate `beta_output`
    pub fn on_vrf(env: Env, request_id: u64, beta_output: BytesN<32>, _alpha_seed: BytesN<32>) {
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
            .has(&ConsumerKey::RandomResult(request_id))
        {
            panic!("already processed");
        }

        // Validate this is a request we initiated.
        if !env
            .storage()
            .persistent()
            .has(&ConsumerKey::PendingRequest(request_id))
        {
            panic!("unknown request_id");
        }

        // Derive a dice roll (1-6) from beta_output.
        // Take first 8 bytes as u64 and compute modulo 6, then add 1.
        let arr = beta_output.to_array();
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&arr[0..8]);
        let raw = u64::from_be_bytes(buf);
        let roll = (raw % 6) + 1; // [1, 6]

        // Store the result.
        env.storage()
            .persistent()
            .set(&ConsumerKey::RandomResult(request_id), &roll);

        // Clean up pending marker.
        env.storage()
            .persistent()
            .remove(&ConsumerKey::PendingRequest(request_id));

        // Emit event for the dice roll result.
        env.events().publish(
            (soroban_sdk::symbol_short!("rolled"),),
            (request_id, roll),
        );
    }

    /// Query the dice roll result for a fulfilled request.
    pub fn get_result(env: Env, request_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&ConsumerKey::RandomResult(request_id))
            .unwrap_or_else(|| panic!("result not available"))
    }

    /// Query the VRF contract address.
    pub fn vrf_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&ConsumerKey::VrfContract)
            .unwrap_or_else(|| panic!("not initialized"))
    }
}
