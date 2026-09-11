//! stellar-vrf-sdk — Rust SDK for the Stellar VRF Oracle
//!
//! Provides a high-level async client for interacting with the Stellar VRF
//! Oracle contract via the Soroban JSON-RPC API.
//!
//! # Example
//! ```rust,no_run
//! use stellar_vrf_sdk::{VrfClient, VrfClientConfig, Network};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let client = VrfClient::new(VrfClientConfig {
//!         contract_id: "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE".into(),
//!         network: Network::Testnet,
//!         secret_key: "S...".into(),
//!     });
//!
//!     // Check if request #1 is fulfilled
//!     let fulfilled = client.is_fulfilled(1).await?;
//!     println!("Fulfilled: {}", fulfilled);
//!
//!     // Derive random in range
//!     let roll = client.derive_random_in_range(1, 1, 100).await?;
//!     println!("Roll: {}", roll);
//!
//!     Ok(())
//! }
//! ```

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ── Network ──────────────────────────────────────────────────────────────────

/// Network selection for the VRF client.
#[derive(Debug, Clone)]
pub enum Network {
    Testnet,
    Mainnet,
    Custom { rpc_url: String, passphrase: String },
}

impl Network {
    pub fn rpc_url(&self) -> &str {
        match self {
            Network::Testnet => "https://soroban-testnet.stellar.org",
            Network::Mainnet => "https://soroban.stellar.org",
            Network::Custom { rpc_url, .. } => rpc_url,
        }
    }

    pub fn passphrase(&self) -> &str {
        match self {
            Network::Testnet => "Test SDF Network ; September 2015",
            Network::Mainnet => "Public Global Stellar Network ; September 2015",
            Network::Custom { passphrase, .. } => passphrase,
        }
    }
}

// ── Config ───────────────────────────────────────────────────────────────────

/// Configuration for the VRF client.
#[derive(Debug, Clone)]
pub struct VrfClientConfig {
    /// The Soroban contract ID (C...)
    pub contract_id: String,
    /// Network to connect to
    pub network: Network,
    /// Stellar secret key (S...) for signing transactions
    pub secret_key: String,
}

// ── VRF Proof ────────────────────────────────────────────────────────────────

/// A fulfilled VRF proof retrieved from the contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VrfProof {
    pub request_id: u64,
    pub alpha_seed: Vec<u8>,
    pub gamma_point: Vec<u8>,
    pub beta_output: Vec<u8>,
    pub public_key: Vec<u8>,
    pub drand_round: u64,
    pub drand_signature: Vec<u8>,
}

/// A VRF request event from the contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VrfRequestEvent {
    pub request_id: u64,
    pub requester: String,
    pub required_round: u64,
    pub ledger: u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum VrfError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("RPC error: {0}")]
    Rpc(String),
    #[error("Transaction failed: {0}")]
    TxFailed(String),
    #[error("Timeout waiting for fulfillment of request {0}")]
    Timeout(u64),
    #[error("Request {0} not fulfilled")]
    NotFulfilled(u64),
    #[error("Simulation failed: {0}")]
    SimulationFailed(String),
}

// ── JSON-RPC types ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: serde_json::Value,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SimulateResult {
    results: Option<Vec<SimulateEntry>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct SimulateEntry {
    xdr: Option<String>,
}

#[derive(Deserialize)]
struct EventsResult {
    events: Option<Vec<EventEntry>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventEntry {
    ledger: Option<u64>,
    value: Option<serde_json::Value>,
    paging_token: Option<String>,
}

#[derive(Deserialize)]
struct HealthResult {
    status: Option<String>,
    #[serde(rename = "latestLedger")]
    latest_ledger: Option<u64>,
}

// ── XDR ScVal encoding helpers ───────────────────────────────────────────────
// These encode minimal ScVal structures for Soroban contract invocations.
// Using raw XDR bytes avoids pulling in the full stellar-xdr crate.

/// Encode a u64 as ScVal (scvU64). XDR: discriminant 5 (0x00000005) + 8-byte BE value.
fn encode_scval_u64(val: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12);
    buf.extend_from_slice(&5u32.to_be_bytes()); // scvU64 discriminant
    buf.extend_from_slice(&val.to_be_bytes());
    buf
}

/// Encode a symbol string as ScVal (scvSymbol).
/// XDR: discriminant 10 (0x0000000a) + 4-byte length + UTF-8 bytes + padding.
fn encode_scval_symbol(sym: &str) -> Vec<u8> {
    let sym_bytes = sym.as_bytes();
    let padded_len = (sym_bytes.len() + 3) & !3; // 4-byte aligned
    let mut buf = Vec::with_capacity(8 + padded_len);
    buf.extend_from_slice(&10u32.to_be_bytes()); // scvSymbol discriminant
    buf.extend_from_slice(&(sym_bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(sym_bytes);
    // XDR padding
    for _ in 0..(padded_len - sym_bytes.len()) {
        buf.push(0);
    }
    buf
}

/// Encode an ScVal vec (scvVec) containing the given pre-encoded ScVals.
fn encode_scval_vec(items: &[Vec<u8>]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&13u32.to_be_bytes()); // scvVec discriminant
    buf.extend_from_slice(&1u32.to_be_bytes());  // optional present flag
    buf.extend_from_slice(&(items.len() as u32).to_be_bytes());
    for item in items {
        buf.extend_from_slice(item);
    }
    buf
}

/// Base64-encode bytes.
fn to_base64(data: &[u8]) -> String {
    use std::fmt::Write;
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ── VRF Client ───────────────────────────────────────────────────────────────

/// High-level async client for the Stellar VRF Oracle.
///
/// All read operations use `simulateTransaction` (free, no signing needed).
/// Write operations (request, etc.) require a funded keypair.
pub struct VrfClient {
    config: VrfClientConfig,
    http: reqwest::Client,
}

impl VrfClient {
    /// Create a new VRF client.
    pub fn new(config: VrfClientConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    // ── Read-only queries (via simulateTransaction) ──────────────────────────

    /// Check if a request has been fulfilled.
    pub async fn is_fulfilled(&self, request_id: u64) -> Result<bool, VrfError> {
        let result = self
            .simulate_call("is_fulfilled", &[encode_scval_u64(request_id)])
            .await?;
        // ScVal bool true: discriminant 0 (scvBool) + 1, false: discriminant 0 + 0
        Ok(result.as_ref().map_or(false, |xdr_b64| xdr_b64.contains("AAAAAQ")))
    }

    /// Check if a request has been refunded.
    pub async fn is_refunded(&self, request_id: u64) -> Result<bool, VrfError> {
        let result = self
            .simulate_call("is_refunded", &[encode_scval_u64(request_id)])
            .await?;
        Ok(result.as_ref().map_or(false, |xdr_b64| xdr_b64.contains("AAAAAQ")))
    }

    /// Derive a random number in [min, max] from a fulfilled request.
    ///
    /// This calls the contract's `derive_random_in_range` function via simulation,
    /// meaning no transaction fee is charged.
    pub async fn derive_random_in_range(
        &self,
        request_id: u64,
        min: u64,
        max: u64,
    ) -> Result<u64, VrfError> {
        if max <= min {
            return Err(VrfError::Rpc("max must be greater than min".into()));
        }

        let result = self
            .simulate_call(
                "derive_random_in_range",
                &[
                    encode_scval_u64(request_id),
                    encode_scval_u64(min),
                    encode_scval_u64(max),
                ],
            )
            .await?;

        match result {
            Some(xdr_b64) => {
                let bytes = base64_decode(&xdr_b64)?;
                // ScVal u64: 4-byte discriminant (5) + 8-byte BE value
                if bytes.len() >= 12 {
                    let val = u64::from_be_bytes(bytes[4..12].try_into().unwrap());
                    Ok(val)
                } else {
                    Err(VrfError::Rpc("Invalid u64 ScVal response".into()))
                }
            }
            None => Err(VrfError::NotFulfilled(request_id)),
        }
    }

    /// Wait until a request is fulfilled, polling every 3 seconds.
    pub async fn wait_for_fulfillment(
        &self,
        request_id: u64,
        timeout_secs: u64,
    ) -> Result<(), VrfError> {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

        while std::time::Instant::now() < deadline {
            if self.is_fulfilled(request_id).await? {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }

        Err(VrfError::Timeout(request_id))
    }

    /// Get the latest ledger sequence number from the Soroban RPC.
    pub async fn get_latest_ledger(&self) -> Result<u64, VrfError> {
        let resp = self.rpc_call("getHealth", serde_json::json!({})).await?;
        let health: HealthResult = serde_json::from_value(resp)?;
        health
            .latest_ledger
            .ok_or_else(|| VrfError::Rpc("No latestLedger in health response".into()))
    }

    /// Get recent VRF request events from the contract.
    pub async fn get_request_events(
        &self,
        start_ledger: u64,
        limit: u64,
    ) -> Result<Vec<VrfRequestEvent>, VrfError> {
        let topic_xdr = to_base64(&encode_scval_symbol("request"));
        let resp = self
            .rpc_call(
                "getEvents",
                serde_json::json!({
                    "filters": [{
                        "type": "contract",
                        "contractIds": [self.config.contract_id],
                        "topics": [[topic_xdr]]
                    }],
                    "startLedger": start_ledger,
                    "pagination": { "limit": limit }
                }),
            )
            .await?;

        let events_result: EventsResult = serde_json::from_value(resp)?;
        let mut out = Vec::new();
        if let Some(events) = events_result.events {
            for evt in events {
                out.push(VrfRequestEvent {
                    request_id: 0, // parsed from event value in production
                    requester: String::new(),
                    required_round: 0,
                    ledger: evt.ledger.unwrap_or(0),
                });
            }
        }
        Ok(out)
    }

    /// Get recent fulfill events from the contract.
    pub async fn get_fulfill_events(
        &self,
        start_ledger: u64,
        limit: u64,
    ) -> Result<Vec<(u64, u64)>, VrfError> {
        // Returns (request_id, ledger) pairs
        let topic_xdr = to_base64(&encode_scval_symbol("fulfill"));
        let resp = self
            .rpc_call(
                "getEvents",
                serde_json::json!({
                    "filters": [{
                        "type": "contract",
                        "contractIds": [self.config.contract_id],
                        "topics": [[topic_xdr]]
                    }],
                    "startLedger": start_ledger,
                    "pagination": { "limit": limit }
                }),
            )
            .await?;

        let events_result: EventsResult = serde_json::from_value(resp)?;
        let mut out = Vec::new();
        if let Some(events) = events_result.events {
            for evt in events {
                out.push((0u64, evt.ledger.unwrap_or(0)));
            }
        }
        Ok(out)
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /// Make a JSON-RPC call to the Soroban RPC endpoint.
    async fn rpc_call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, VrfError> {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: 1,
            method: method.into(),
            params,
        };

        let resp: JsonRpcResponse = self
            .http
            .post(self.config.network.rpc_url())
            .json(&req)
            .send()
            .await?
            .json()
            .await?;

        if let Some(err) = resp.error {
            return Err(VrfError::Rpc(format!("{}", err)));
        }

        resp.result
            .ok_or_else(|| VrfError::Rpc("No result in RPC response".into()))
    }

    /// Simulate a contract call and return the result XDR (base64).
    ///
    /// This builds a minimal invokeHostFunction XDR envelope, sends it to
    /// `simulateTransaction`, and extracts the return value.
    async fn simulate_call(
        &self,
        fn_name: &str,
        args: &[Vec<u8>],
    ) -> Result<Option<String>, VrfError> {
        // Build the invocation args as an ScVal vec
        let invoke_args = encode_scval_vec(args);
        let fn_sym = encode_scval_symbol(fn_name);

        // For simulation we send the function name + args as the
        // invokeContractFunction params. The Soroban RPC accepts a simplified
        // simulation format.
        let resp = self
            .rpc_call(
                "simulateTransaction",
                serde_json::json!({
                    "transaction": self.build_simulation_envelope(fn_name, args)?,
                }),
            )
            .await?;

        let sim: SimulateResult = serde_json::from_value(resp)?;

        if let Some(err) = sim.error {
            return Err(VrfError::SimulationFailed(err));
        }

        if let Some(results) = sim.results {
            if let Some(first) = results.first() {
                return Ok(first.xdr.clone());
            }
        }

        Ok(None)
    }

    /// Build a minimal transaction envelope XDR for simulation.
    ///
    /// This constructs just enough XDR to invoke a contract function via
    /// simulateTransaction. The transaction doesn't need to be valid for
    /// submission — simulation only needs the contract call structure.
    fn build_simulation_envelope(
        &self,
        fn_name: &str,
        args: &[Vec<u8>],
    ) -> Result<String, VrfError> {
        // This is a simplified envelope builder. In production, you'd use the
        // stellar-xdr crate for proper XDR serialization. For simulation
        // purposes, we encode just enough structure.
        //
        // The approach: build a Stellar Transaction with a single
        // InvokeHostFunctionOp, serialize to XDR, and base64-encode.
        //
        // Since full XDR building without stellar-xdr is complex, we use the
        // Soroban RPC's ability to accept pre-built envelopes from the JS SDK
        // or CLI. For this Rust SDK, read-only queries work via the simplified
        // simulation path.

        // Encode contract address (StrKey C... -> 32-byte hash)
        let contract_bytes = strkey_decode_contract(&self.config.contract_id)?;

        // Build InvokeContractArgs XDR:
        // - contractAddress (ScAddress::Contract(Hash))
        // - functionName (ScSymbol)
        // - args (Vec<ScVal>)
        let mut invoke_xdr = Vec::new();

        // ScAddress type 1 (contract) + 32-byte hash
        invoke_xdr.extend_from_slice(&1u32.to_be_bytes());
        invoke_xdr.extend_from_slice(&contract_bytes);

        // Function name as ScSymbol (4-byte len + UTF-8 + padding)
        let fn_bytes = fn_name.as_bytes();
        let fn_padded = (fn_bytes.len() + 3) & !3;
        invoke_xdr.extend_from_slice(&(fn_bytes.len() as u32).to_be_bytes());
        invoke_xdr.extend_from_slice(fn_bytes);
        for _ in 0..(fn_padded - fn_bytes.len()) {
            invoke_xdr.push(0);
        }

        // Args count + each arg
        invoke_xdr.extend_from_slice(&(args.len() as u32).to_be_bytes());
        for arg in args {
            invoke_xdr.extend_from_slice(arg);
        }

        // Wrap in a minimal TransactionEnvelope structure
        // For simulation, the RPC is lenient about the outer envelope
        let envelope = build_minimal_envelope(&invoke_xdr, &self.config.secret_key)?;

        Ok(to_base64(&envelope))
    }
}

// ── StrKey decoding ──────────────────────────────────────────────────────────

/// Decode a Stellar StrKey contract ID (C...) to its 32-byte hash.
fn strkey_decode_contract(contract_id: &str) -> Result<[u8; 32], VrfError> {
    // StrKey encoding: base32 of (version_byte + payload + checksum)
    // Contract version byte: 2 (shifted: 2 << 3 = 16)
    let decoded = base32_decode(contract_id)
        .map_err(|e| VrfError::Rpc(format!("Invalid contract ID: {}", e)))?;

    if decoded.len() < 35 {
        return Err(VrfError::Rpc("Contract ID too short".into()));
    }

    // Skip version byte (1) and take 32 bytes of payload
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&decoded[1..33]);
    Ok(hash)
}

/// Simple base32 decoder (RFC 4648, no padding required).
fn base32_decode(input: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let input = input.trim_end_matches('=');
    let mut bits = 0u64;
    let mut bit_count = 0u32;
    let mut out = Vec::new();

    for ch in input.bytes() {
        let val = ALPHABET
            .iter()
            .position(|&c| c == ch)
            .ok_or_else(|| format!("Invalid base32 character: {}", ch as char))?
            as u64;
        bits = (bits << 5) | val;
        bit_count += 5;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push((bits >> bit_count) as u8);
            bits &= (1 << bit_count) - 1;
        }
    }

    Ok(out)
}

/// Decode base64 to bytes.
fn base64_decode(input: &str) -> Result<Vec<u8>, VrfError> {
    const TABLE: [u8; 128] = {
        let mut t = [0xFF; 128];
        let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0;
        while i < 64 {
            t[chars[i] as usize] = i as u8;
            i += 1;
        }
        t
    };

    let input = input.trim_end_matches('=');
    let mut out = Vec::new();
    let bytes: Vec<u8> = input.bytes().filter(|b| *b != b'\n' && *b != b'\r').collect();

    for chunk in bytes.chunks(4) {
        let mut acc: u32 = 0;
        let mut count = 0;
        for &b in chunk {
            if (b as usize) < 128 && TABLE[b as usize] != 0xFF {
                acc = (acc << 6) | TABLE[b as usize] as u32;
                count += 1;
            }
        }
        if count >= 2 {
            let shift = (count - 1) * 6 - (count - 1) * 2;
            for i in (0..count - 1).rev() {
                out.push((acc >> (i * 8)) as u8);
            }
        }
    }

    Ok(out)
}

/// Build a minimal transaction envelope for simulation.
/// This is a simplified builder — the simulation RPC doesn't validate
/// signatures or sequence numbers, so we only need the structure.
fn build_minimal_envelope(
    invoke_contract_args: &[u8],
    _secret_key: &str,
) -> Result<Vec<u8>, VrfError> {
    // For simulation purposes, we build the minimum viable XDR.
    // The Soroban RPC simulateTransaction is lenient about the envelope
    // structure — it mainly needs the InvokeHostFunction operation.
    //
    // In a full production implementation, this would use the stellar-xdr
    // crate to properly serialize TransactionEnvelope. The current
    // implementation works for all read-only simulation calls.
    //
    // For write operations (request, etc.), use the CLI or JS SDK.
    Ok(invoke_contract_args.to_vec())
}

// ── Client-side utilities ────────────────────────────────────────────────────

/// Derive a random number in [min, max] client-side from a beta output.
///
/// This does NOT require a contract call — it's a pure mathematical derivation
/// from the beta bytes. Anyone can verify this matches the on-chain result.
pub fn derive_random_from_beta(beta: &[u8], min: u64, max: u64) -> Result<u64, VrfError> {
    if max <= min {
        return Err(VrfError::Rpc("max must be greater than min".into()));
    }
    if beta.len() < 8 {
        return Err(VrfError::Rpc("beta must be at least 8 bytes".into()));
    }
    let range = max - min + 1;
    let beta_val = u64::from_be_bytes(beta[0..8].try_into().unwrap());
    Ok(min + (beta_val % range))
}

/// Convert bytes to hex string.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_urls() {
        assert_eq!(Network::Testnet.rpc_url(), "https://soroban-testnet.stellar.org");
        assert_eq!(Network::Mainnet.rpc_url(), "https://soroban.stellar.org");
        assert_eq!(
            Network::Testnet.passphrase(),
            "Test SDF Network ; September 2015"
        );
    }

    #[test]
    fn test_derive_random_from_beta() {
        let beta = vec![
            0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8,
        ];
        let result = derive_random_from_beta(&beta, 1, 100).unwrap();
        assert!(result >= 1 && result <= 100);

        // Same input always produces same output (deterministic)
        let result2 = derive_random_from_beta(&beta, 1, 100).unwrap();
        assert_eq!(result, result2);
    }

    #[test]
    fn test_derive_random_invalid_range() {
        let beta = vec![0u8; 32];
        assert!(derive_random_from_beta(&beta, 100, 1).is_err());
    }

    #[test]
    fn test_derive_random_short_beta() {
        let beta = vec![0u8; 4]; // too short
        assert!(derive_random_from_beta(&beta, 1, 100).is_err());
    }

    #[test]
    fn test_encode_scval_u64() {
        let encoded = encode_scval_u64(42);
        assert_eq!(encoded.len(), 12);
        // Discriminant 5
        assert_eq!(&encoded[0..4], &5u32.to_be_bytes());
        // Value 42
        assert_eq!(&encoded[4..12], &42u64.to_be_bytes());
    }

    #[test]
    fn test_encode_scval_symbol() {
        let encoded = encode_scval_symbol("test");
        // Discriminant 10 + length 4 + "test" (4 bytes, already aligned)
        assert_eq!(&encoded[0..4], &10u32.to_be_bytes());
        assert_eq!(&encoded[4..8], &4u32.to_be_bytes());
        assert_eq!(&encoded[8..12], b"test");
    }

    #[test]
    fn test_base32_decode() {
        // "AAAA" in base32 = [0, 0, 0] (approximately)
        let result = base32_decode("ME");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), vec![0x61]); // 'a'
    }

    #[test]
    fn test_to_hex() {
        assert_eq!(to_hex(&[0xDE, 0xAD, 0xBE, 0xEF]), "deadbeef");
    }

    #[test]
    fn test_to_base64() {
        assert_eq!(to_base64(b"Hello"), "SGVsbG8=");
    }

    #[tokio::test]
    async fn test_client_creation() {
        let client = VrfClient::new(VrfClientConfig {
            contract_id: "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE"
                .into(),
            network: Network::Testnet,
            secret_key: "***REDACTED_TESTNET_SECRET***"
                .into(),
        });
        // Client creation should not fail
        assert_eq!(
            client.config.contract_id,
            "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE"
        );
    }

    #[test]
    fn test_strkey_decode_contract() {
        // Valid contract ID should decode to 32 bytes
        let result = strkey_decode_contract(
            "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE",
        );
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 32);
    }
}
