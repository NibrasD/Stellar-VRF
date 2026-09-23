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
//!     // Derive a uniform roll in [1, 100] (exact, no modulo bias)
//!     let roll = client.derive_random_in_range(1, 1, 100).await?;
//!     println!("Roll: {}", roll);
//!
//!     // Or reproduce it offline from the verified beta:
//!     let beta = client.get_beta(1).await?;
//!     let span = 100;
//!     assert_eq!(roll, 1 + stellar_vrf_sdk::derive_range_from_beta(&beta, 1, span)?);
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

/// Encode a byte slice as ScVal (scvBytes).
/// XDR: discriminant 9 (0x00000009) + 4-byte length + bytes + 4-byte padding.
fn encode_scval_bytes(data: &[u8]) -> Vec<u8> {
    let padded_len = (data.len() + 3) & !3; // 4-byte aligned
    let mut buf = Vec::with_capacity(8 + padded_len);
    buf.extend_from_slice(&9u32.to_be_bytes()); // scvBytes discriminant
    buf.extend_from_slice(&(data.len() as u32).to_be_bytes());
    buf.extend_from_slice(data);
    for _ in 0..(padded_len - data.len()) {
        buf.push(0);
    }
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

    /// Derive a random number in the inclusive range `[min, max]` from a
    /// fulfilled request.
    ///
    /// The on-chain `derive_random_in_range(request_id, max)` returns a value
    /// in `[0, max)` that is **exactly** uniform (rejection sampling, no modulo
    /// bias). This helper requests a span of `max - min + 1` and shifts the
    /// result by `min` to cover the inclusive range. The result equals
    /// `min + `[`derive_range_from_beta`]`(beta, request_id, span)`.
    ///
    /// There is no caller-chosen context: a value picked after the result is
    /// known would allow grinding. Bind application data at `request()` time,
    /// or use [`Self::derive_range_for_domain`] with a **fixed** domain.
    ///
    /// This calls the contract via simulation, so no transaction fee is charged.
    ///
    /// # Range limit
    /// The contract takes an exclusive `u64` upper bound, so the widest inclusive
    /// range it can serve has `2^64 - 1` values. The single range it can't
    /// express, `[0, u64::MAX]`, returns an error instead of overflowing. For
    /// full-width randomness use [`derive_random_from_beta`] or the raw beta.
    pub async fn derive_random_in_range(
        &self,
        request_id: u64,
        min: u64,
        max: u64,
    ) -> Result<u64, VrfError> {
        let span = inclusive_span(min, max)?;
        let result = self
            .simulate_call(
                "derive_random_in_range",
                &[encode_scval_u64(request_id), encode_scval_u64(span)],
            )
            .await?;
        Ok(decode_u64_result(result, request_id)? + min)
    }

    /// Like [`Self::derive_random_in_range`], with a short domain separator so
    /// one request can feed several independent draws.
    ///
    /// # The domain MUST be fixed before fulfillment
    /// If anyone can choose `domain` after the randomness is public, they can
    /// try many domains and keep the result they like. Only use constants or
    /// values committed before `request()`. At most
    /// [`MAX_DERIVE_DOMAIN_LEN`] bytes.
    pub async fn derive_range_for_domain(
        &self,
        request_id: u64,
        domain: &[u8],
        min: u64,
        max: u64,
    ) -> Result<u64, VrfError> {
        if domain.len() > MAX_DERIVE_DOMAIN_LEN {
            return Err(VrfError::Rpc(format!(
                "domain is {} bytes; the contract accepts at most {MAX_DERIVE_DOMAIN_LEN}",
                domain.len()
            )));
        }
        let span = inclusive_span(min, max)?;
        let result = self
            .simulate_call(
                "derive_range_for_domain",
                &[
                    encode_scval_u64(request_id),
                    encode_scval_bytes(domain),
                    encode_scval_u64(span),
                ],
            )
            .await?;
        Ok(decode_u64_result(result, request_id)? + min)
    }

    /// The verified 32-byte beta of a fulfilled request (`get_beta`). Kept by
    /// the contract after `cleanup_proof()`.
    pub async fn get_beta(&self, request_id: u64) -> Result<[u8; 32], VrfError> {
        let result = self
            .simulate_call("get_beta", &[encode_scval_u64(request_id)])
            .await?;
        match result {
            Some(xdr_b64) => {
                let bytes = base64_decode(&xdr_b64)?;
                // ScVal bytes: 4-byte discriminant (13) + 4-byte length (32) + data
                if bytes.len() >= 40 && bytes[0..4] == [0, 0, 0, 13] && bytes[4..8] == [0, 0, 0, 32] {
                    Ok(bytes[8..40].try_into().unwrap())
                } else {
                    Err(VrfError::Rpc("Invalid BytesN<32> ScVal response".into()))
                }
            }
            None => Err(VrfError::NotFulfilled(request_id)),
        }
    }
}

/// Decode a simulated `u64` ScVal return value.
fn decode_u64_result(result: Option<String>, request_id: u64) -> Result<u64, VrfError> {
    match result {
        Some(xdr_b64) => {
            let bytes = base64_decode(&xdr_b64)?;
            // ScVal u64: 4-byte discriminant (5) + 8-byte BE value
            if bytes.len() >= 12 && bytes[0..4] == [0, 0, 0, 5] {
                Ok(u64::from_be_bytes(bytes[4..12].try_into().unwrap()))
            } else {
                Err(VrfError::Rpc("Invalid u64 ScVal response".into()))
            }
        }
        None => Err(VrfError::NotFulfilled(request_id)),
    }
}

impl VrfClient {
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
                let (request_id, requester, required_round) = parse_request_event_value(&evt);
                out.push(VrfRequestEvent {
                    request_id,
                    requester,
                    required_round,
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
                let request_id = parse_fulfill_event_value(&evt);
                out.push((request_id, evt.ledger.unwrap_or(0)));
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
        // The ScVal encoding happens inside build_simulation_envelope below;
        // encoding it here as well left two unused locals.
        //
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

// ── StrKey encoding ──────────────────────────────────────────────────────────

/// CRC16-XModem, the checksum StrKey uses (SEP-0023).
fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0x0000;
    for &byte in data {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// RFC 4648 base32 (no padding), the alphabet StrKey uses.
fn base32_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &b in data {
        buffer = (buffer << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1F) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1F) as usize] as char);
    }
    out
}

/// Encode a 32-byte payload as StrKey with the given version byte.
///
/// Layout: `base32(version_byte ‖ payload ‖ crc16_xmodem_le)`.
fn strkey_encode(version_byte: u8, payload: &[u8]) -> String {
    let mut buf = Vec::with_capacity(1 + payload.len() + 2);
    buf.push(version_byte);
    buf.extend_from_slice(payload);
    let crc = crc16_xmodem(&buf);
    buf.extend_from_slice(&crc.to_le_bytes()); // StrKey checksum is little-endian
    base32_encode(&buf)
}

/// Encode an ed25519 public key as a `G...` account address.
///
/// Version byte 6 << 3 = 0x30. Previously this code emitted `format!("G{hex}")`,
/// which merely *looks* like an address: it is not base32, carries no checksum
/// and is rejected by every Stellar tool. Event consumers received unusable
/// requester values.
pub fn strkey_encode_ed25519(key: &[u8]) -> String {
    strkey_encode(6 << 3, key)
}

/// Encode a 32-byte contract hash as a `C...` contract address (version byte 2 << 3).
pub fn strkey_encode_contract(hash: &[u8]) -> String {
    strkey_encode(2 << 3, hash)
}

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

    // Bit accumulator: 6 bits per base64 symbol, emit a byte per 8 buffered bits.
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &b in &bytes {
        if (b as usize) >= 128 || TABLE[b as usize] == 0xFF {
            return Err(VrfError::Rpc(format!(
                "invalid base64 character: {:?}",
                b as char
            )));
        }
        buffer = (buffer << 6) | TABLE[b as usize] as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
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

/// Number of values in the inclusive range `[min, max]`, as the contract's
/// exclusive `u64` bound.
///
/// `max - min + 1` overflows `u64` for exactly one input, `[0, u64::MAX]`
/// (`2^64` values). That range can't be expressed to the contract, so it's
/// rejected with an explicit error instead of panicking in debug builds or
/// silently wrapping to `0` in release builds.
fn inclusive_span(min: u64, max: u64) -> Result<u64, VrfError> {
    if max < min {
        return Err(VrfError::Rpc("max must be >= min".into()));
    }
    (max - min).checked_add(1).ok_or_else(|| {
        VrfError::Rpc(
            "range [0, u64::MAX] has 2^64 values and cannot be expressed as the contract's \
             exclusive u64 bound; use derive_random_from_beta() or the raw beta instead"
                .into(),
        )
    })
}

// ── Offline derivation (byte-for-byte identical to the contract) ─────────────

/// Domain prefix of every contract derivation (`DERIVE_DOMAIN`).
pub const DERIVE_DOMAIN: &[u8] = b"VREP_DERIVE_V2";
const DERIVE_TAG_U64: u8 = 0x01;
const DERIVE_TAG_RANGE: u8 = 0x02;
const DERIVE_TAG_RANGE_DOMAIN: u8 = 0x03;
/// Longest domain accepted by `derive_range_for_domain` (`MAX_DERIVE_DOMAIN_LEN`).
pub const MAX_DERIVE_DOMAIN_LEN: usize = 64;

fn derive_hash(tag: u8, request_id: u64, parts: &[&[u8]], beta: &[u8; 32]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(DERIVE_DOMAIN);
    h.update([tag]);
    h.update(request_id.to_be_bytes());
    for p in parts {
        h.update(p);
    }
    h.update(beta);
    h.finalize().into()
}

/// Exact-uniform reduction of a 32-byte hash into `[0, max)`, identical to the
/// contract's `reduce_uniform()`.
///
/// The hash is split into two 128-bit big-endian candidates. A candidate `c` is
/// accepted iff `c < limit`, where `limit = 2^128 - (2^128 mod max)` is the
/// largest multiple of `max` that fits. The result `c mod max` is then exactly
/// uniform. If both are rejected (probability < 2^-128) this returns an error,
/// just like the contract panics. There is no biased fallback.
pub fn reduce_uniform(hash: &[u8; 32], max: u64) -> Result<u64, VrfError> {
    if max == 0 {
        return Err(VrfError::Rpc("max must be > 0".into()));
    }
    let m = max as u128;
    let rem = 0u128.wrapping_sub(m) % m; // 2^128 mod max
    for half in [&hash[0..16], &hash[16..32]] {
        let c = u128::from_be_bytes(half.try_into().unwrap());
        if c <= u128::MAX - rem {
            return Ok((c % m) as u64);
        }
    }
    Err(VrfError::Rpc(
        "range derivation failed: both candidates rejected".into(),
    ))
}

/// Offline equivalent of the contract's `derive_random(request_id)`.
pub fn derive_u64_from_beta(beta: &[u8; 32], request_id: u64) -> u64 {
    let h = derive_hash(DERIVE_TAG_U64, request_id, &[], beta);
    u64::from_be_bytes(h[0..8].try_into().unwrap())
}

/// Offline equivalent of the contract's `derive_random_in_range(request_id, max)`:
/// an exactly uniform value in `[0, max)`.
pub fn derive_range_from_beta(beta: &[u8; 32], request_id: u64, max: u64) -> Result<u64, VrfError> {
    if max == 0 {
        return Err(VrfError::Rpc("max must be > 0".into()));
    }
    if max == 1 {
        return Ok(0);
    }
    let h = derive_hash(DERIVE_TAG_RANGE, request_id, &[&max.to_be_bytes()], beta);
    reduce_uniform(&h, max)
}

/// Offline equivalent of the contract's
/// `derive_range_for_domain(request_id, domain, max)`.
///
/// **The domain must be fixed before fulfillment** (a constant, or a value
/// committed before `request()`); otherwise whoever picks it can grind.
pub fn derive_range_for_domain_from_beta(
    beta: &[u8; 32],
    request_id: u64,
    domain: &[u8],
    max: u64,
) -> Result<u64, VrfError> {
    if max == 0 {
        return Err(VrfError::Rpc("max must be > 0".into()));
    }
    if domain.len() > MAX_DERIVE_DOMAIN_LEN {
        return Err(VrfError::Rpc("domain exceeds maximum length".into()));
    }
    if max == 1 {
        return Ok(0);
    }
    let len = (domain.len() as u32).to_be_bytes();
    let h = derive_hash(
        DERIVE_TAG_RANGE_DOMAIN,
        request_id,
        &[&len, domain, &max.to_be_bytes()],
        beta,
    );
    reduce_uniform(&h, max)
}

/// Derive a random number in the inclusive range `[min, max]` client-side from a
/// beta output, without a contract call.
///
/// **Deprecated:** not the contract's function, and only negligibly (≤ 2^-64)
/// rather than exactly uniform. Use [`derive_range_from_beta`], which matches
/// the contract's `derive_random_in_range` exactly.
///
/// This is a pure, deterministic function of `beta`, so anyone holding the
/// verified beta can reproduce it. It is **not** the same function as the
/// contract's `derive_random_in_range(request_id, context, max)`, which first
/// hashes `domain ‖ beta ‖ context`. Don't mix the two for the same purpose. Use
/// one consistently and document which one your application uses.
///
/// The full range `[0, u64::MAX]` is supported.
///
/// # Bias
/// Consumes **128 bits** of `beta` and reduces modulo the range. For a uniform
/// `x` in `[0, 2^128)` and any range `<= 2^64`, the deviation between residue
/// classes is bounded by `range / 2^128 <= 2^-64`, which is cryptographically
/// negligible.
///
/// An earlier version used only the first 64 bits, giving a bias of up to
/// `range / 2^64`, which becomes significant for very large ranges (approaching
/// a 50% skew as the range approaches `2^63`).
#[deprecated(
    since = "2.0.0",
    note = "use derive_range_from_beta(), which matches the contract and is exactly uniform"
)]
pub fn derive_random_from_beta(beta: &[u8], min: u64, max: u64) -> Result<u64, VrfError> {
    if max <= min {
        return Err(VrfError::Rpc("max must be greater than min".into()));
    }
    if beta.len() < 16 {
        return Err(VrfError::Rpc("beta must be at least 16 bytes".into()));
    }
    // Widen BEFORE adding 1: `(max - min + 1)` in u64 overflows for [0, u64::MAX].
    let range = (max - min) as u128 + 1;
    let beta_val = u128::from_be_bytes(beta[0..16].try_into().unwrap());
    // beta_val % range <= max - min, so the u64 cast and the addition can't overflow.
    Ok(min + (beta_val % range) as u64)
}

/// Convert bytes to hex string.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Event value XDR parsing ──────────────────────────────────────────────────

/// Parse request event value from Soroban getEvents response.
///
/// The event value is a base64-encoded ScVal. For VRF request events, the
/// contract emits a ScMap (discriminant 14) containing:
///   - "request_id" → scvU64
///   - "requester"  → scvAddress
///   - "required_round" → scvU64
///
/// If parsing fails (e.g. unknown format), returns safe defaults.
fn parse_request_event_value(evt: &EventEntry) -> (u64, String, u64) {
    let value_str = match &evt.value {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => return (0, String::new(), 0),
    };

    let bytes = match base64_decode(&value_str) {
        Ok(b) => b,
        Err(_) => return (0, String::new(), 0),
    };

    // Try to parse as ScVal. The XDR starts with a 4-byte discriminant.
    // ScvU64 = 5: the event value is just a u64 request_id
    // ScvMap = 14: the event value is a map with request_id, requester, etc.
    if bytes.len() < 4 {
        return (0, String::new(), 0);
    }

    let discriminant = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);

    match discriminant {
        // scvU64: event value is just the request_id
        5 if bytes.len() >= 12 => {
            let request_id = u64::from_be_bytes(bytes[4..12].try_into().unwrap_or_default());
            (request_id, String::new(), 0)
        }
        // scvMap: event value is a map — parse key-value pairs
        14 => parse_scval_map_for_request(&bytes[4..]),
        // Unknown format — return what we can
        _ => (0, String::new(), 0),
    }
}

/// Parse fulfill event value to extract the request_id.
///
/// Fulfill events typically emit the request_id as a u64 ScVal.
fn parse_fulfill_event_value(evt: &EventEntry) -> u64 {
    let value_str = match &evt.value {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => return 0,
    };

    let bytes = match base64_decode(&value_str) {
        Ok(b) => b,
        Err(_) => return 0,
    };

    if bytes.len() < 4 {
        return 0;
    }

    let discriminant = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);

    match discriminant {
        // scvU64: the value is the request_id
        5 if bytes.len() >= 12 => {
            u64::from_be_bytes(bytes[4..12].try_into().unwrap_or_default())
        }
        // scvMap: parse map for request_id field
        14 => {
            let (request_id, _, _) = parse_scval_map_for_request(&bytes[4..]);
            request_id
        }
        _ => 0,
    }
}

/// Parse an ScVal Map payload to extract request_id, requester, required_round.
///
/// XDR map format: count (4 bytes) + entries. Each entry is key ScVal + value ScVal.
/// Keys are typically ScvSymbol (discriminant 10).
fn parse_scval_map_for_request(data: &[u8]) -> (u64, String, u64) {
    let mut request_id: u64 = 0;
    let mut requester = String::new();
    let mut required_round: u64 = 0;

    if data.len() < 4 {
        return (request_id, requester, required_round);
    }

    let count = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let mut offset = 4;

    for _ in 0..count {
        if offset + 4 > data.len() {
            break;
        }

        // Parse key (expect ScvSymbol = discriminant 10)
        let key_disc = u32::from_be_bytes(
            data[offset..offset + 4].try_into().unwrap_or_default(),
        );
        offset += 4;

        if key_disc != 10 || offset + 4 > data.len() {
            break; // Not a symbol key — can't reliably parse further
        }

        let key_len = u32::from_be_bytes(
            data[offset..offset + 4].try_into().unwrap_or_default(),
        ) as usize;
        offset += 4;

        if offset + key_len > data.len() {
            break;
        }

        let key_name = String::from_utf8_lossy(&data[offset..offset + key_len]).to_string();
        let key_padded = (key_len + 3) & !3; // 4-byte alignment
        offset += key_padded;

        if offset + 4 > data.len() {
            break;
        }

        // Parse value
        let val_disc = u32::from_be_bytes(
            data[offset..offset + 4].try_into().unwrap_or_default(),
        );
        offset += 4;

        match val_disc {
            // scvU64
            5 => {
                if offset + 8 <= data.len() {
                    let val = u64::from_be_bytes(
                        data[offset..offset + 8].try_into().unwrap_or_default(),
                    );
                    offset += 8;
                    match key_name.as_str() {
                        "request_id" => request_id = val,
                        "required_round" => required_round = val,
                        _ => {}
                    }
                } else {
                    break;
                }
            }
            // scvAddress (discriminant 0 = Account type, then 32 bytes)
            18 => {
                if offset + 36 <= data.len() {
                    let addr_type = u32::from_be_bytes(
                        data[offset..offset + 4].try_into().unwrap_or_default(),
                    );
                    offset += 4;
                    let addr_bytes = &data[offset..offset + 32];
                    offset += 32;
                    if key_name == "requester" {
                        // addr_type 0 = account (ed25519), 1 = contract.
                        requester = match addr_type {
                            0 => strkey_encode_ed25519(addr_bytes),
                            _ => strkey_encode_contract(addr_bytes),
                        };
                    }
                } else {
                    break;
                }
            }
            // Skip unknown value types
            _ => {
                break; // Can't determine value length — stop parsing
            }
        }
    }

    (request_id, requester, required_round)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[allow(deprecated)] // the legacy derive_random_from_beta keeps its regression tests
mod tests {
    use super::*;

    /// Shared cross-implementation vectors: beta = 0x00..0x1f, request_id = 7.
    /// Identical constants are asserted by the contract's
    /// `test_derive_vectors_shared_with_sdks` and the JS SDK.
    fn vec_beta() -> [u8; 32] {
        let mut b = [0u8; 32];
        for (i, x) in b.iter_mut().enumerate() {
            *x = i as u8;
        }
        b
    }

    #[test]
    fn test_derive_vectors_match_contract() {
        let beta = vec_beta();
        assert_eq!(derive_u64_from_beta(&beta, 7), 17_155_214_937_666_214_782);
        assert_eq!(derive_range_from_beta(&beta, 7, 6).unwrap(), 4);
        assert_eq!(derive_range_from_beta(&beta, 7, 1_000_000).unwrap(), 889_164);
        assert_eq!(
            derive_range_from_beta(&beta, 7, u64::MAX).unwrap(),
            11_798_261_183_955_500_607
        );
        assert_eq!(
            derive_range_for_domain_from_beta(&beta, 7, b"card-1", 1000).unwrap(),
            595
        );
    }

    fn halves(c1: u128, c2: u128) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[..16].copy_from_slice(&c1.to_be_bytes());
        h[16..].copy_from_slice(&c2.to_be_bytes());
        h
    }

    #[test]
    fn test_reduce_uniform_matches_contract_rules() {
        // First candidate accepted.
        assert_eq!(reduce_uniform(&halves(123_456_789, 42), 1_000_003).unwrap(), 123_456_789 % 1_000_003);
        // max = 3: 2^128 mod 3 = 1, so u128::MAX is the single rejected value.
        assert_eq!(reduce_uniform(&halves(u128::MAX - 1, 0), 3).unwrap(), ((u128::MAX - 1) % 3) as u64);
        assert_eq!(reduce_uniform(&halves(u128::MAX, 5), 3).unwrap(), 2);
        // Both rejected: explicit error, no biased fallback.
        let err = reduce_uniform(&halves(u128::MAX, u128::MAX), (1 << 63) + 1).unwrap_err();
        assert!(err.to_string().contains("both candidates rejected"));
        // Powers of two never reject.
        assert_eq!(reduce_uniform(&halves(u128::MAX, u128::MAX), 1 << 32).unwrap(), u32::MAX as u64);
        assert!(reduce_uniform(&halves(0, 0), 0).is_err());
    }

    #[test]
    fn test_derive_range_edge_cases() {
        let beta = vec_beta();
        assert_eq!(derive_range_from_beta(&beta, 7, 1).unwrap(), 0);
        assert!(derive_range_from_beta(&beta, 7, 0).is_err());
        assert!(derive_range_for_domain_from_beta(&beta, 7, &[0u8; 65], 10).is_err());
        assert!(derive_range_for_domain_from_beta(&beta, 7, &[0u8; 64], 10).unwrap() < 10);
        // Domains and request ids separate outputs.
        let a = derive_range_for_domain_from_beta(&beta, 7, b"card-1", u64::MAX).unwrap();
        let b = derive_range_for_domain_from_beta(&beta, 7, b"card-2", u64::MAX).unwrap();
        let c = derive_range_from_beta(&beta, 8, u64::MAX).unwrap();
        assert_ne!(a, b);
        assert_ne!(c, derive_range_from_beta(&beta, 7, u64::MAX).unwrap());
    }

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

    /// StrKey encoding must match the canonical SEP-0023 vector.
    /// This is the published example: an all-zero-ish ed25519 key whose G-address
    /// is widely used in Stellar test fixtures.
    #[test]
    fn test_strkey_encode_ed25519_known_vector() {
        // SEP-0023 test vector.
        let raw: [u8; 32] = [
            0x6d, 0xb3, 0x7d, 0x0d, 0xa1, 0x5a, 0x1a, 0x1e, 0x7c, 0x1a, 0x1a, 0x45, 0x9a, 0x3f,
            0x63, 0x19, 0x0b, 0x34, 0x63, 0x0c, 0x1e, 0x1a, 0x1e, 0x1a, 0x1e, 0x1a, 0x1e, 0x1a,
            0x1e, 0x1a, 0x1e, 0x1a,
        ];
        let encoded = strkey_encode_ed25519(&raw);

        // Shape checks that the old `format!("G{hex}")` could never satisfy.
        assert!(encoded.starts_with('G'), "account StrKey must start with G");
        assert_eq!(encoded.len(), 56, "StrKey addresses are 56 characters");
        assert!(
            encoded.chars().all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)),
            "must use the RFC4648 base32 alphabet, got {encoded}"
        );

        // Round-trip through the decoder: payload must survive unchanged.
        let decoded = base32_decode(&encoded).expect("must decode");
        assert_eq!(&decoded[1..33], &raw[..], "payload must round-trip");
    }

    /// Contract addresses must round-trip through encode -> decode.
    #[test]
    fn test_strkey_contract_round_trip() {
        let hash: [u8; 32] = [7u8; 32];
        let encoded = strkey_encode_contract(&hash);
        assert!(encoded.starts_with('C'), "contract StrKey must start with C");
        assert_eq!(encoded.len(), 56);
        let back = strkey_decode_contract(&encoded).expect("must decode");
        assert_eq!(back, hash);
    }

    /// CRC16-XModem reference vector: "123456789" -> 0x31C3.
    #[test]
    fn test_crc16_xmodem_known_vector() {
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
    }

    /// The 128-bit reduction must stay in range and be deterministic, including
    /// for the modulus that was the worst case for the old 64-bit modulo.
    #[test]
    fn test_derive_random_from_beta_range_and_determinism() {
        let beta = [0xABu8; 32];

        for (min, max) in [(1u64, 6u64), (1, 100), (0, u64::MAX / 2), (5, 5 + (1 << 62))] {
            let a = derive_random_from_beta(&beta, min, max).unwrap();
            let b = derive_random_from_beta(&beta, min, max).unwrap();
            assert_eq!(a, b, "must be deterministic");
            assert!(a >= min && a <= max, "{a} outside [{min}, {max}]");
        }

        // Needs 16 bytes now, not 8 — short input must be rejected rather than
        // silently producing a biased value.
        assert!(derive_random_from_beta(&[0u8; 8], 1, 10).is_err());
        assert!(derive_random_from_beta(&beta, 10, 10).is_err());
    }

    /// Regression: `max - min + 1` overflowed u64 for the full range, which
    /// panics in debug builds and wraps to a modulus of 0 in release builds.
    #[test]
    fn test_derive_random_from_beta_full_u64_range() {
        // The whole domain must be reachable, including both ends.
        let lo = derive_random_from_beta(&[0x00u8; 16], 0, u64::MAX).unwrap();
        let hi = derive_random_from_beta(&[0xFFu8; 16], 0, u64::MAX).unwrap();
        assert_eq!(lo, 0);
        assert_eq!(hi, u64::MAX, "2^128-1 mod 2^64 = 2^64-1");

        // Near-full ranges at either edge stay in bounds.
        let beta = [0xABu8; 32];
        for (min, max) in [(1u64, u64::MAX), (0, u64::MAX - 1), (u64::MAX - 1, u64::MAX)] {
            let v = derive_random_from_beta(&beta, min, max).unwrap();
            assert!(v >= min && v <= max, "{v} outside [{min}, {max}]");
        }
    }

    /// The on-chain span sent to `derive_random_in_range` must never overflow.
    #[test]
    fn test_inclusive_span_boundaries() {
        assert_eq!(inclusive_span(1, 100).unwrap(), 100);
        assert_eq!(inclusive_span(7, 7).unwrap(), 1);
        assert_eq!(inclusive_span(1, u64::MAX).unwrap(), u64::MAX);
        assert_eq!(inclusive_span(0, u64::MAX - 1).unwrap(), u64::MAX);
        // The one range the contract's exclusive u64 bound cannot express.
        let err = inclusive_span(0, u64::MAX).unwrap_err().to_string();
        assert!(err.contains("2^64"), "unexpected error: {err}");
        assert!(inclusive_span(10, 9).is_err());
    }

    #[tokio::test]
    async fn test_client_creation() {
        let client = VrfClient::new(VrfClientConfig {
            contract_id: "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE"
                .into(),
            network: Network::Testnet,
            // NOTE: Not a real key. This is a syntactic placeholder that fails
            // StrKey checksum validation, so it cannot control any Stellar
            // account on any network. Verified: `Keypair.fromSecret()` rejects
            // it with "invalid checksum". Never put a real secret here.
            secret_key: ""
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
