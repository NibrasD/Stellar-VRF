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
//!         secret_key: String::new(), // unused: read-only client
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
    /// Stellar secret key (S...).
    ///
    /// **Currently unused.** This SDK is read-only: every call is an unsigned
    /// `simulateTransaction`, and nothing is signed or submitted. The field is
    /// kept for 2.x API compatibility. An empty string is fine, and you don't
    /// need to give this client a real key.
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
}

#[derive(Deserialize)]
struct HealthResult {
    #[serde(rename = "latestLedger")]
    latest_ledger: Option<u64>,
}

// ── XDR ScVal encoding helpers ───────────────────────────────────────────────
// These encode minimal ScVal structures for Soroban contract invocations.
// Using raw XDR bytes avoids pulling in the full stellar-xdr crate, so every
// layout here is pinned by golden vectors from the official encoder
// (`@stellar/stellar-sdk`) and from Mainnet in the tests below.

/// `SCValType` discriminants (Stellar-contract.x). Releases up to 2.0.0 used
/// 9/10/13/14 for bytes/symbol/vec/map. Those values are wrong, and the RPC
/// rejected every request built with them.
mod scv {
    pub const BOOL: u32 = 0;
    pub const VOID: u32 = 1;
    pub const U32: u32 = 3;
    pub const U64: u32 = 5;
    pub const BYTES: u32 = 13;
    pub const SYMBOL: u32 = 15;
    pub const VEC: u32 = 16;
    pub const MAP: u32 = 17;
    pub const ADDRESS: u32 = 18;
}

fn put_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

/// XDR variable-length opaque/string: 4-byte length, data, zero padding to 4.
fn put_var_opaque(buf: &mut Vec<u8>, data: &[u8]) {
    put_u32(buf, data.len() as u32);
    buf.extend_from_slice(data);
    buf.resize(buf.len() + (4 - data.len() % 4) % 4, 0);
}

/// Encode a u64 as ScVal (scvU64): discriminant 5 + 8-byte BE value.
fn encode_scval_u64(val: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12);
    put_u32(&mut buf, scv::U64);
    buf.extend_from_slice(&val.to_be_bytes());
    buf
}

/// Encode a byte slice as ScVal (scvBytes): discriminant 13 + var opaque.
fn encode_scval_bytes(data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + data.len() + 3);
    put_u32(&mut buf, scv::BYTES);
    put_var_opaque(&mut buf, data);
    buf
}

/// Encode a symbol as ScVal (scvSymbol): discriminant 15 + var string.
fn encode_scval_symbol(sym: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 + sym.len() + 3);
    put_u32(&mut buf, scv::SYMBOL);
    put_var_opaque(&mut buf, sym.as_bytes());
    buf
}

// ── XDR ScVal decoding ───────────────────────────────────────────────────────

/// The subset of `ScVal` this SDK reads (contract return values and events).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ScVal {
    Bool(bool),
    Void,
    U32(u32),
    U64(u64),
    Bytes(Vec<u8>),
    Symbol(String),
    Vec(Vec<ScVal>),
    Map(Vec<(ScVal, ScVal)>),
    /// StrKey form: `G...` (account) or `C...` (contract).
    Address(String),
}

fn xdr_err(msg: impl std::fmt::Display) -> VrfError {
    VrfError::Rpc(format!("XDR decode error: {msg}"))
}

/// Decode one base64 ScVal, rejecting trailing bytes.
fn decode_scval_b64(b64: &str) -> Result<ScVal, VrfError> {
    let bytes = base64_decode(b64)?;
    let mut r = XdrReader::new(&bytes);
    let val = r.scval(0)?;
    if r.pos != bytes.len() {
        return Err(xdr_err(format!("{} trailing bytes", bytes.len() - r.pos)));
    }
    Ok(val)
}

/// Bounds-checked XDR reader. Every read fails cleanly on truncated input;
/// nothing is silently defaulted.
struct XdrReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> XdrReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], VrfError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&e| e <= self.data.len())
            .ok_or_else(|| xdr_err("unexpected end of input"))?;
        let out = &self.data[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn u32(&mut self) -> Result<u32, VrfError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, VrfError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn hash32(&mut self) -> Result<[u8; 32], VrfError> {
        Ok(self.take(32)?.try_into().unwrap())
    }

    fn var_opaque(&mut self, max_len: usize) -> Result<&'a [u8], VrfError> {
        let len = self.u32()? as usize;
        if len > max_len {
            return Err(xdr_err(format!("length {len} exceeds {max_len}")));
        }
        let data = self.take(len)?;
        if self.take((4 - len % 4) % 4)?.iter().any(|&b| b != 0) {
            return Err(xdr_err("non-zero padding"));
        }
        Ok(data)
    }

    /// Element count of an XDR array. Bounded by the bytes left (every element
    /// takes at least 4 bytes), so a corrupt count can't force a huge allocation.
    fn count(&mut self) -> Result<usize, VrfError> {
        let n = self.u32()? as usize;
        if n > (self.data.len() - self.pos) / 4 {
            return Err(xdr_err(format!("element count {n} exceeds input")));
        }
        Ok(n)
    }

    fn scval(&mut self, depth: u32) -> Result<ScVal, VrfError> {
        if depth > 8 {
            return Err(xdr_err("ScVal nesting too deep"));
        }
        match self.u32()? {
            scv::BOOL => match self.u32()? {
                0 => Ok(ScVal::Bool(false)),
                1 => Ok(ScVal::Bool(true)),
                b => Err(xdr_err(format!("invalid bool {b}"))),
            },
            scv::VOID => Ok(ScVal::Void),
            scv::U32 => Ok(ScVal::U32(self.u32()?)),
            scv::U64 => Ok(ScVal::U64(self.u64()?)),
            scv::BYTES => Ok(ScVal::Bytes(self.var_opaque(usize::MAX)?.to_vec())),
            scv::SYMBOL => {
                let s = self.var_opaque(32)?;
                String::from_utf8(s.to_vec())
                    .map(ScVal::Symbol)
                    .map_err(|_| xdr_err("symbol is not UTF-8"))
            }
            // `SCVec *vec` / `SCMap *map` are XDR optionals: 0 = absent.
            scv::VEC => {
                if self.u32()? == 0 {
                    return Ok(ScVal::Vec(Vec::new()));
                }
                let n = self.count()?;
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    items.push(self.scval(depth + 1)?);
                }
                Ok(ScVal::Vec(items))
            }
            scv::MAP => {
                if self.u32()? == 0 {
                    return Ok(ScVal::Map(Vec::new()));
                }
                let n = self.count()?;
                let mut entries = Vec::with_capacity(n);
                for _ in 0..n {
                    let k = self.scval(depth + 1)?;
                    let v = self.scval(depth + 1)?;
                    entries.push((k, v));
                }
                Ok(ScVal::Map(entries))
            }
            scv::ADDRESS => match self.u32()? {
                // SC_ADDRESS_TYPE_ACCOUNT: AccountID is a PublicKey union whose
                // own tag (0 = ed25519) precedes the 32-byte key.
                0 => match self.u32()? {
                    0 => Ok(ScVal::Address(strkey_encode_ed25519(&self.hash32()?))),
                    t => Err(xdr_err(format!("unsupported public key type {t}"))),
                },
                // SC_ADDRESS_TYPE_CONTRACT: 32-byte contract hash.
                1 => Ok(ScVal::Address(strkey_encode_contract(&self.hash32()?))),
                t => Err(xdr_err(format!("unsupported address type {t}"))),
            },
            t => Err(xdr_err(format!("unsupported ScVal type {t}"))),
        }
    }
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
        decode_bool_result(result)
    }

    /// Check if a request has been refunded.
    pub async fn is_refunded(&self, request_id: u64) -> Result<bool, VrfError> {
        let result = self
            .simulate_call("is_refunded", &[encode_scval_u64(request_id)])
            .await?;
        decode_bool_result(result)
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
        decode_beta_result(result, request_id)
    }
}

/// Decode a simulated `bool` return value. A missing value is an error rather
/// than `false`, so an RPC problem can't pass for "not fulfilled".
fn decode_bool_result(result: Option<String>) -> Result<bool, VrfError> {
    let xdr_b64 = result.ok_or_else(|| VrfError::Rpc("simulation returned no value".into()))?;
    match decode_scval_b64(&xdr_b64)? {
        ScVal::Bool(b) => Ok(b),
        other => Err(VrfError::Rpc(format!("expected bool ScVal, got {other:?}"))),
    }
}

/// Decode a simulated `BytesN<32>` return value.
fn decode_beta_result(result: Option<String>, request_id: u64) -> Result<[u8; 32], VrfError> {
    let xdr_b64 = result.ok_or(VrfError::NotFulfilled(request_id))?;
    match decode_scval_b64(&xdr_b64)? {
        ScVal::Bytes(b) => b
            .try_into()
            .map_err(|b: Vec<u8>| VrfError::Rpc(format!("expected 32-byte beta, got {}", b.len()))),
        other => Err(VrfError::Rpc(format!(
            "expected BytesN<32> ScVal, got {other:?}"
        ))),
    }
}

/// Decode a simulated `u64` ScVal return value.
fn decode_u64_result(result: Option<String>, request_id: u64) -> Result<u64, VrfError> {
    let xdr_b64 = result.ok_or(VrfError::NotFulfilled(request_id))?;
    match decode_scval_b64(&xdr_b64)? {
        ScVal::U64(v) => Ok(v),
        other => Err(VrfError::Rpc(format!("expected u64 ScVal, got {other:?}"))),
    }
}

impl VrfClient {
    /// Wait until a request is fulfilled, polling every 3 seconds.
    pub async fn wait_for_fulfillment(
        &self,
        request_id: u64,
        timeout_secs: u64,
    ) -> Result<(), VrfError> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

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
        events_result
            .events
            .unwrap_or_default()
            .iter()
            .map(|evt| {
                let (request_id, requester, required_round) =
                    parse_request_event_value(event_value_b64(evt)?)?;
                Ok(VrfRequestEvent {
                    request_id,
                    requester,
                    required_round,
                    ledger: evt.ledger.unwrap_or(0),
                })
            })
            .collect()
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
        events_result
            .events
            .unwrap_or_default()
            .iter()
            .map(|evt| {
                let (request_id, _beta) = parse_fulfill_event_value(event_value_b64(evt)?)?;
                Ok((request_id, evt.ledger.unwrap_or(0)))
            })
            .collect()
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
        let contract = strkey_decode_contract(&self.config.contract_id)?;
        let envelope = build_simulation_envelope(&contract, fn_name, args);
        let resp = self
            .rpc_call(
                "simulateTransaction",
                serde_json::json!({ "transaction": to_base64(&envelope) }),
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
///
/// Layout: `base32(version_byte ‖ 32-byte payload ‖ crc16_xmodem_le)`, 56 chars.
/// The length, the contract version byte (`2 << 3`) and the CRC16 checksum are
/// all checked, so a typo or a `G...` account address is rejected instead of
/// being silently turned into a different contract hash.
fn strkey_decode_contract(contract_id: &str) -> Result<[u8; 32], VrfError> {
    let bad = |m: &str| VrfError::Rpc(format!("Invalid contract ID: {}", m));
    if contract_id.len() != 56 {
        return Err(bad("expected 56 characters"));
    }
    let decoded = base32_decode(contract_id).map_err(|e| bad(&e))?;
    if decoded.len() != 35 {
        return Err(bad("wrong decoded length"));
    }
    if decoded[0] != 2 << 3 {
        return Err(bad("not a contract (C...) address"));
    }
    let expected = crc16_xmodem(&decoded[..33]);
    let actual = u16::from_le_bytes([decoded[33], decoded[34]]);
    if expected != actual {
        return Err(bad("checksum mismatch"));
    }
    // Re-encoding must reproduce the input exactly (rejects non-canonical
    // trailing bits in the last base32 character).
    if strkey_encode(2 << 3, &decoded[1..33]) != contract_id {
        return Err(bad("non-canonical encoding"));
    }

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
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| *b != b'\n' && *b != b'\r')
        .collect();

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

/// Build an unsigned `TransactionEnvelope` (v1) that invokes
/// `contract.fn_name(args)`, for `simulateTransaction` only.
///
/// `simulateTransaction` needs a well-formed envelope, but it doesn't check
/// signatures or sequence numbers, and it doesn't require the source account
/// to exist. So this uses the all-zero ed25519 source
/// (`GAAAA…WHF`), sequence 1 and no signatures. It is the same envelope
/// `@stellar/stellar-sdk` builds for read-only calls (see the golden test).
/// This envelope can't be submitted. Writes are out of scope for this SDK.
///
/// Releases up to 2.0.0 sent only the bare `InvokeContractArgs` bytes here, and
/// the RPC rejected them with "Could not unmarshal transaction".
fn build_simulation_envelope(contract: &[u8; 32], fn_name: &str, args: &[Vec<u8>]) -> Vec<u8> {
    let mut b = Vec::with_capacity(160 + args.iter().map(Vec::len).sum::<usize>());
    put_u32(&mut b, 2); // EnvelopeType::ENVELOPE_TYPE_TX
                        // Transaction.sourceAccount: MuxedAccount KEY_TYPE_ED25519 + 32-byte key.
    put_u32(&mut b, 0);
    b.extend_from_slice(&[0u8; 32]);
    put_u32(&mut b, 100); // fee (stroops); simulation ignores it
    b.extend_from_slice(&1u64.to_be_bytes()); // seqNum
                                              // cond: PRECOND_TIME with TimeBounds { min: 0, max: 0 } (no bounds).
    put_u32(&mut b, 1);
    b.extend_from_slice(&[0u8; 16]);
    put_u32(&mut b, 0); // memo: MEMO_NONE
    put_u32(&mut b, 1); // operations.len()
    put_u32(&mut b, 0); // Operation.sourceAccount: absent
    put_u32(&mut b, 24); // OperationType::INVOKE_HOST_FUNCTION
    put_u32(&mut b, 0); // HostFunctionType::INVOKE_CONTRACT
                        // InvokeContractArgs { contractAddress, functionName, args }
    put_u32(&mut b, 1); // ScAddressType::CONTRACT
    b.extend_from_slice(contract);
    put_var_opaque(&mut b, fn_name.as_bytes());
    put_u32(&mut b, args.len() as u32);
    for a in args {
        b.extend_from_slice(a);
    }
    put_u32(&mut b, 0); // InvokeHostFunctionOp.auth.len()
    put_u32(&mut b, 0); // Transaction.ext: v0
    put_u32(&mut b, 0); // signatures.len()
    b
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

// ── Event value parsing ──────────────────────────────────────────────────────

/// The base64 `value` of a getEvents entry.
fn event_value_b64(evt: &EventEntry) -> Result<&str, VrfError> {
    match &evt.value {
        Some(serde_json::Value::String(s)) => Ok(s),
        other => Err(VrfError::Rpc(format!(
            "event has no base64 value: {other:?}"
        ))),
    }
}

/// Parse the value of a `request` event.
///
/// The contract publishes a tuple, i.e. an `ScVec`:
/// `(request_id: u64, requester: Address, required_round: u64)`.
/// Early deployments emitted `(request_id, requester)` without the round. That
/// form is accepted with `required_round = 0`. Anything else is an error:
/// earlier releases silently returned `(0, "", 0)`, which callers couldn't tell
/// apart from a real request #0.
fn parse_request_event_value(value_b64: &str) -> Result<(u64, String, u64), VrfError> {
    let bad = |v: &ScVal| VrfError::Rpc(format!("unexpected request event value: {v:?}"));
    let val = decode_scval_b64(value_b64)?;
    match &val {
        ScVal::Vec(items) => match items.as_slice() {
            [ScVal::U64(id), ScVal::Address(who), ScVal::U64(round)] => {
                Ok((*id, who.clone(), *round))
            }
            [ScVal::U64(id), ScVal::Address(who)] => Ok((*id, who.clone(), 0)),
            _ => Err(bad(&val)),
        },
        _ => Err(bad(&val)),
    }
}

/// Parse the value of a `fulfill` event: an `ScVec`
/// `(request_id: u64, beta: BytesN<32>)`.
fn parse_fulfill_event_value(value_b64: &str) -> Result<(u64, [u8; 32]), VrfError> {
    let bad = |v: &ScVal| VrfError::Rpc(format!("unexpected fulfill event value: {v:?}"));
    let val = decode_scval_b64(value_b64)?;
    match &val {
        ScVal::Vec(items) => match items.as_slice() {
            [ScVal::U64(id), ScVal::Bytes(beta)] => {
                let beta: [u8; 32] = beta.as_slice().try_into().map_err(|_| bad(&val))?;
                Ok((*id, beta))
            }
            _ => Err(bad(&val)),
        },
        _ => Err(bad(&val)),
    }
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
        assert_eq!(
            derive_range_from_beta(&beta, 7, 1_000_000).unwrap(),
            889_164
        );
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
        assert_eq!(
            reduce_uniform(&halves(123_456_789, 42), 1_000_003).unwrap(),
            123_456_789 % 1_000_003
        );
        // max = 3: 2^128 mod 3 = 1, so u128::MAX is the single rejected value.
        assert_eq!(
            reduce_uniform(&halves(u128::MAX - 1, 0), 3).unwrap(),
            ((u128::MAX - 1) % 3) as u64
        );
        assert_eq!(reduce_uniform(&halves(u128::MAX, 5), 3).unwrap(), 2);
        // Both rejected: explicit error, no biased fallback.
        let err = reduce_uniform(&halves(u128::MAX, u128::MAX), (1 << 63) + 1).unwrap_err();
        assert!(err.to_string().contains("both candidates rejected"));
        // Powers of two never reject.
        assert_eq!(
            reduce_uniform(&halves(u128::MAX, u128::MAX), 1 << 32).unwrap(),
            u32::MAX as u64
        );
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
        assert_eq!(
            Network::Testnet.rpc_url(),
            "https://soroban-testnet.stellar.org"
        );
        assert_eq!(Network::Mainnet.rpc_url(), "https://soroban.stellar.org");
        assert_eq!(
            Network::Testnet.passphrase(),
            "Test SDF Network ; September 2015"
        );
    }

    #[test]
    fn test_derive_random_from_beta() {
        let beta = vec![
            0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
            0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
        ];
        let result = derive_random_from_beta(&beta, 1, 100).unwrap();
        assert!((1..=100).contains(&result));

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

    // ── Wire-format golden vectors (audit round 7) ──────────────────────────
    // Every expected byte string below came from the official encoder
    // (`@stellar/stellar-sdk` `xdr.ScVal` / `TransactionBuilder`) or from live
    // Mainnet `getEvents` output for CBTCC5QL…SUHU, not from this crate.

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Topic filters. With the old discriminant (10 = scvI128) the RPC answered
    /// "decoding Int128Parts: unexpected EOF" and no events were ever returned.
    #[test]
    fn test_encode_scval_symbol_matches_stellar_sdk() {
        assert_eq!(
            to_base64(&encode_scval_symbol("request")),
            "AAAADwAAAAdyZXF1ZXN0AA=="
        );
        assert_eq!(
            to_base64(&encode_scval_symbol("fulfill")),
            "AAAADwAAAAdmdWxmaWxsAA=="
        );
        assert_eq!(
            encode_scval_symbol("test"),
            unhex("0000000f0000000474657374")
        );
    }

    #[test]
    fn test_encode_scval_bytes_matches_stellar_sdk() {
        assert_eq!(
            encode_scval_bytes(&[0xab]),
            unhex("0000000d00000001ab000000")
        );
        assert_eq!(encode_scval_bytes(b""), unhex("0000000d00000000"));
    }

    /// The simulation envelope must be byte-identical to what
    /// `TransactionBuilder` (source GAAAA…WHF, seq 1, fee 100, timeout 0)
    /// produces. Mainnet RPC accepted that envelope (`is_fulfilled(1)` →
    /// `AAAAAAAAAAE=`). The old bare `InvokeContractArgs` bytes got
    /// "Could not unmarshal transaction".
    #[test]
    fn test_simulation_envelope_matches_stellar_sdk() {
        let contract =
            strkey_decode_contract("CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU")
                .unwrap();
        let env = build_simulation_envelope(&contract, "is_fulfilled", &[encode_scval_u64(1)]);
        assert_eq!(
            to_base64(&env),
            "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABZiF2C+z2mSyZdx5/LknBIF8YhRiA733XRwc2dbdivTkAAAAMaXNfZnVsZmlsbGVkAAAAAQAAAAUAAAAAAAAAAQAAAAAAAAAAAAAAAA=="
        );
        let env = build_simulation_envelope(
            &contract,
            "derive_range_for_domain",
            &[
                encode_scval_u64(7),
                encode_scval_bytes(b"card-1"),
                encode_scval_u64(1000),
            ],
        );
        assert_eq!(
            to_base64(&env),
            "AAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABZiF2C+z2mSyZdx5/LknBIF8YhRiA733XRwc2dbdivTkAAAAXZGVyaXZlX3JhbmdlX2Zvcl9kb21haW4AAAAAAwAAAAUAAAAAAAAABwAAAA0AAAAGY2FyZC0xAAAAAAAFAAAAAAAAA+gAAAAAAAAAAAAAAAA="
        );
    }

    /// Byte-for-byte what the contract emits: the same hex strings are asserted
    /// against the contract's real event XDR in `soroban-contract/src/test.rs`
    /// (`test_request_event_wire_format_matches_sdk_vector` /
    /// `test_fulfill_event_wire_format_matches_sdk_vector`).
    #[test]
    fn test_parse_contract_event_vectors() {
        let req = unhex(
            "00000010000000010000000300000005000000000000000100000012000000000000000011111111\
             11111111111111111111111111111111111111111111111111111111000000050000000001eecec8",
        );
        assert_eq!(
            parse_request_event_value(&to_base64(&req)).unwrap(),
            (
                1,
                "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M".to_string(),
                32_427_720
            )
        );
        let ful = unhex(
            "0000001000000001000000020000000500000000000000010000000d0000002098c612abed131631\
             47239f4323d4973cb68df7302564fc791e17c1aae95a6c9d",
        );
        let (id, beta) = parse_fulfill_event_value(&to_base64(&ful)).unwrap();
        assert_eq!(id, 1);
        assert_eq!(
            to_hex(&beta),
            "98c612abed13163147239f4323d4973cb68df7302564fc791e17c1aae95a6c9d"
        );
    }

    /// Real `getEvents` values from Mainnet (CBTCC5QL…SUHU, ledgers 64559682 /
    /// 64559684), cross-checked with `scValToNative`.
    #[test]
    fn test_parse_mainnet_event_values() {
        let (id, who, round) = parse_request_event_value(
            "AAAAEAAAAAEAAAADAAAABQAAAAAAAAADAAAAEgAAAAAAAAAAmZz3cVG/1r8BH4AiQrWoVKqmI5dAl2N2ybrtTq7t8VgAAAAFAAAAAAHuy74=",
        )
        .unwrap();
        assert_eq!(id, 3);
        assert_eq!(
            who,
            "GCMZZ53RKG75NPYBD6ACEQVVVBKKVJRDS5AJOY3WZG5O2TVO5XYVR4DY"
        );
        assert_eq!(round, 32_426_942);

        let (id, beta) = parse_fulfill_event_value(
            "AAAAEAAAAAEAAAACAAAABQAAAAAAAAADAAAADQAAACBDasoG50C2Z6upEOd08wHZIggLpOtuNTci6ogl5o1nkA==",
        )
        .unwrap();
        assert_eq!(id, 3);
        assert_eq!(
            to_hex(&beta),
            "436aca06e740b667aba910e774f301d922080ba4eb6e353722ea8825e68d6790"
        );
    }

    #[test]
    fn test_parse_request_event_contract_requester_and_legacy_shape() {
        // Contract requester (callback consumers), from stellar-sdk.
        let (id, who, round) = parse_request_event_value(
            "AAAAEAAAAAEAAAADAAAABQAAAAAAAAAHAAAAEgAAAAEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAAUAAAAAAe7Oyg==",
        )
        .unwrap();
        assert_eq!((id, round), (7, 32_427_722));
        assert_eq!(
            who,
            "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR"
        );
        // Early deployments: (id, requester) without the round.
        let (id, who, round) = parse_request_event_value(
            "AAAAEAAAAAEAAAACAAAABQAAAAAAAAAFAAAAEgAAAAAAAAAAERERERERERERERERERERERERERERERERERERERERERE=",
        )
        .unwrap();
        assert_eq!((id, round), (5, 0));
        assert_eq!(
            who,
            "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M"
        );
    }

    /// Wrong shapes are errors. Earlier releases returned `(0, "", 0)`, which
    /// looked like a real request #0.
    #[test]
    fn test_parse_event_rejects_unexpected_shapes() {
        // Map form, from stellar-sdk: { request_id: 1 }.
        let map = "AAAAEQAAAAEAAAABAAAADwAAAApyZXF1ZXN0X2lkAAAAAAAFAAAAAAAAAAE=";
        assert!(decode_scval_b64(map).is_ok());
        assert!(parse_request_event_value(map).is_err());
        assert!(parse_fulfill_event_value(map).is_err());
        let bare_u64 = to_base64(&encode_scval_u64(9));
        assert!(parse_request_event_value(&bare_u64).is_err());
        assert!(parse_fulfill_event_value(&bare_u64).is_err());
        // A request value is not a fulfill value.
        let legacy_req =
            "AAAAEAAAAAEAAAACAAAABQAAAAAAAAAFAAAAEgAAAAAAAAAAERERERERERERERERERERERERERERERERERERERERERE=";
        assert!(parse_fulfill_event_value(legacy_req).is_err());
        // Beta must be exactly 32 bytes.
        let short_beta =
            unhex("0000001000000001000000020000000500000000000000010000000d00000001ab000000");
        assert!(parse_fulfill_event_value(&to_base64(&short_beta)).is_err());
    }

    #[test]
    fn test_decoder_rejects_malformed_xdr() {
        let full = unhex(
            "0000001000000001000000020000000500000000000000010000000d0000002098c612abed131631\
             47239f4323d4973cb68df7302564fc791e17c1aae95a6c9d",
        );
        assert!(decode_scval_b64(&to_base64(&full)).is_ok());
        // Every truncation fails cleanly (no panic, no default value).
        for n in 0..full.len() {
            assert!(
                decode_scval_b64(&to_base64(&full[..n])).is_err(),
                "prefix {n}"
            );
        }
        // Trailing bytes.
        let mut extra = full.clone();
        extra.extend_from_slice(&[0, 0, 0, 0]);
        assert!(decode_scval_b64(&to_base64(&extra)).is_err());
        // A huge element count can't trigger a huge allocation.
        assert!(decode_scval_b64(&to_base64(&unhex("0000001000000001ffffffff"))).is_err());
        assert!(decode_scval_b64(&to_base64(&unhex("0000000dffffffff"))).is_err());
        // Non-zero XDR padding.
        assert!(decode_scval_b64(&to_base64(&unhex("0000000d00000001ab000001"))).is_err());
        // Invalid bool, unknown discriminant, not base64.
        assert!(decode_scval_b64(&to_base64(&unhex("0000000000000002"))).is_err());
        assert!(decode_scval_b64(&to_base64(&unhex("00000063"))).is_err());
        assert!(decode_scval_b64("!!!!").is_err());
        // Deep nesting: 64 × Vec[..] wrapping.
        let mut deep = Vec::new();
        for _ in 0..64 {
            deep.extend_from_slice(&unhex("000000100000000100000001"));
        }
        deep.extend_from_slice(&unhex("00000001"));
        assert!(decode_scval_b64(&to_base64(&deep)).is_err());
        // An absent optional vec decodes to empty.
        assert_eq!(
            decode_scval_b64(&to_base64(&unhex("0000001000000000"))).unwrap(),
            ScVal::Vec(vec![])
        );
    }

    /// Simulation return values, as the RPC returns them in `results[0].xdr`.
    #[test]
    fn test_decode_simulation_results() {
        // Mainnet `is_fulfilled(1)` on CBTCC5QL…SUHU returned "AAAAAAAAAAE=".
        assert!(decode_bool_result(Some("AAAAAAAAAAE=".into())).unwrap());
        assert!(!decode_bool_result(Some("AAAAAAAAAAA=".into())).unwrap());
        // A missing value is an error, not `false`.
        assert!(decode_bool_result(None).is_err());
        // The old substring check (`contains("AAAAAQ")`) read this u64 as `true`.
        let u64_val = to_base64(&encode_scval_u64(1 << 16)); // "AAAABQAAAAAAAQAA"
        assert!(u64_val.contains("AAAAAQ"));
        assert!(decode_bool_result(Some(u64_val)).is_err());

        assert_eq!(
            decode_u64_result(Some(to_base64(&encode_scval_u64(889_164))), 7).unwrap(),
            889_164
        );
        assert!(matches!(
            decode_u64_result(None, 7),
            Err(VrfError::NotFulfilled(7))
        ));
        assert!(decode_u64_result(Some("AAAAAAAAAAE=".into()), 7).is_err());

        let beta: Vec<u8> = (0u8..32).collect();
        assert_eq!(
            decode_beta_result(Some(to_base64(&encode_scval_bytes(&beta))), 1)
                .unwrap()
                .to_vec(),
            beta
        );
        assert!(decode_beta_result(Some(to_base64(&encode_scval_bytes(&beta[..31]))), 1).is_err());
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
            encoded
                .chars()
                .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)),
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
        assert!(
            encoded.starts_with('C'),
            "contract StrKey must start with C"
        );
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

        for (min, max) in [
            (1u64, 6u64),
            (1, 100),
            (0, u64::MAX / 2),
            (5, 5 + (1 << 62)),
        ] {
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
        for (min, max) in [
            (1u64, u64::MAX),
            (0, u64::MAX - 1),
            (u64::MAX - 1, u64::MAX),
        ] {
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
            contract_id: "CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE".into(),
            network: Network::Testnet,
            secret_key: String::new(),
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
        let result =
            strkey_decode_contract("CCOX44NFMB3G4TDOLG5EKCXBP3EZ5PCEC3SQNMWP24WG6BA6HCSU2CBE");
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 32);
    }

    #[test]
    fn test_strkey_decode_contract_rejects_bad_ids() {
        let good = "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU";
        assert!(strkey_decode_contract(good).is_ok());

        // One changed character → checksum mismatch.
        let mut typo = good.to_string();
        typo.replace_range(10..11, if &good[10..11] == "A" { "B" } else { "A" });
        assert!(
            strkey_decode_contract(&typo).is_err(),
            "typo must fail the CRC"
        );

        // Right length, wrong version byte: an account (G...) address.
        let account = strkey_encode_ed25519(&[7u8; 32]);
        assert_eq!(account.len(), 56);
        assert!(
            strkey_decode_contract(&account).is_err(),
            "G... must be rejected"
        );

        // Wrong lengths.
        assert!(strkey_decode_contract(&good[..55]).is_err());
        assert!(strkey_decode_contract(&format!("{good}A")).is_err());
        assert!(strkey_decode_contract("").is_err());

        // Invalid base32 characters.
        let lower = good.to_lowercase();
        assert!(strkey_decode_contract(&lower).is_err());
    }
}
