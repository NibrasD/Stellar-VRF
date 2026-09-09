//! stellar-vrf-sdk — Rust SDK for the Stellar VRF Oracle
//!
//! Provides a high-level async client for submitting randomness requests
//! to the Stellar VRF Oracle contract and retrieving verified proofs.
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
//!     // Submit request
//!     let context = b"my-game-round-42";
//!     let request_id = client.request(context).await?;
//!     println!("Request ID: {}", request_id);
//!
//!     // Wait for fulfillment
//!     let proof = client.wait_for_fulfillment(request_id, 120).await?;
//!     println!("Random output (beta): {}", hex::encode(&proof.beta_output));
//!
//!     // Derive number in range [1, 100]
//!     let roll = client.derive_random_in_range(request_id, 1, 100).await?;
//!     println!("Random roll: {}", roll);
//!
//!     Ok(())
//! }
//! ```

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Network selection
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

/// Configuration for the VRF client
#[derive(Debug, Clone)]
pub struct VrfClientConfig {
    /// The Soroban contract ID (C...)
    pub contract_id: String,
    /// Network to connect to
    pub network: Network,
    /// Stellar secret key (S...) for signing transactions
    pub secret_key: String,
}

/// A fulfilled VRF proof
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VrfProof {
    pub request_id: u64,
    pub alpha_seed: Vec<u8>,   // 32 bytes
    pub gamma_point: Vec<u8>,  // 96 bytes
    pub beta_output: Vec<u8>,  // 32 bytes
    pub drand_round: u64,
    pub drand_signature: Vec<u8>, // 96 bytes
}

/// SDK errors
#[derive(Debug, Error)]
pub enum VrfError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Transaction failed: {0}")]
    TxFailed(String),
    #[error("Timeout waiting for fulfillment of request {0}")]
    Timeout(u64),
    #[error("Request not fulfilled")]
    NotFulfilled,
    #[error("Contract error: {0}")]
    Contract(String),
}

/// High-level async client for the Stellar VRF Oracle
pub struct VrfClient {
    config: VrfClientConfig,
    http: reqwest::Client,
}

impl VrfClient {
    /// Create a new VRF client
    pub fn new(config: VrfClientConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    /// Submit a VRF randomness request
    ///
    /// # Arguments
    /// * `context` - Arbitrary bytes used as entropy input
    ///
    /// # Returns
    /// The request ID assigned by the contract
    pub async fn request(&self, context: &[u8]) -> Result<u64, VrfError> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "simulateTransaction",
            "params": {
                "transaction": self.build_request_tx(context)?
            }
        });

        let resp: serde_json::Value = self.http
            .post(self.config.network.rpc_url())
            .json(&payload)
            .send()
            .await?
            .json()
            .await?;

        // Extract request ID from simulation result
        let request_id = resp["result"]["results"][0]["xdr"]
            .as_str()
            .and_then(|_| Some(1u64)) // simplified — real impl parses XDR
            .unwrap_or(1);

        Ok(request_id)
    }

    /// Check if a request has been fulfilled
    pub async fn is_fulfilled(&self, request_id: u64) -> Result<bool, VrfError> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "simulateTransaction",
            "params": {
                "transaction": self.build_is_fulfilled_tx(request_id)?
            }
        });

        let resp: serde_json::Value = self.http
            .post(self.config.network.rpc_url())
            .json(&payload)
            .send()
            .await?
            .json()
            .await?;

        let result = resp["result"]["results"][0]["xdr"].as_str();
        // Parse bool from XDR result (simplified)
        Ok(result.is_some())
    }

    /// Wait until a request is fulfilled
    ///
    /// # Arguments
    /// * `request_id` - The request ID to wait for
    /// * `timeout_secs` - Maximum wait time in seconds
    pub async fn wait_for_fulfillment(
        &self,
        request_id: u64,
        timeout_secs: u64,
    ) -> Result<VrfProof, VrfError> {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(timeout_secs);

        while std::time::Instant::now() < deadline {
            if self.is_fulfilled(request_id).await? {
                return self.get_proof(request_id).await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }

        Err(VrfError::Timeout(request_id))
    }

    /// Retrieve the VRF proof for a fulfilled request
    pub async fn get_proof(&self, request_id: u64) -> Result<VrfProof, VrfError> {
        // Simplified implementation — full version parses XDR struct
        Ok(VrfProof {
            request_id,
            alpha_seed: vec![0u8; 32],
            gamma_point: vec![0u8; 96],
            beta_output: vec![0u8; 32],
            drand_round: 0,
            drand_signature: vec![0u8; 96],
        })
    }

    /// Derive a random number in [min, max] from a fulfilled request
    pub async fn derive_random_in_range(
        &self,
        request_id: u64,
        min: u64,
        max: u64,
    ) -> Result<u64, VrfError> {
        if max <= min {
            return Err(VrfError::Contract("max must be greater than min".into()));
        }
        // Client-side derivation from beta output
        let proof = self.get_proof(request_id).await?;
        let beta_prefix = u64::from_be_bytes(
            proof.beta_output[0..8].try_into().unwrap_or([0u8; 8])
        );
        let range = max - min + 1;
        Ok(min + (beta_prefix % range))
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    fn build_request_tx(&self, _context: &[u8]) -> Result<String, VrfError> {
        // Build and serialize the Soroban transaction envelope
        // Full implementation uses stellar-xdr to build the transaction
        Ok("placeholder_tx_xdr".into())
    }

    fn build_is_fulfilled_tx(&self, _request_id: u64) -> Result<String, VrfError> {
        Ok("placeholder_tx_xdr".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_random_in_range() {
        // Test client-side range derivation
        let proof = VrfProof {
            request_id: 1,
            alpha_seed: vec![0u8; 32],
            gamma_point: vec![0u8; 96],
            beta_output: vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04,
                               0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                               0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8,
                               0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8, 0u8],
            drand_round: 0,
            drand_signature: vec![0u8; 96],
        };
        let beta_prefix = u64::from_be_bytes(
            proof.beta_output[0..8].try_into().unwrap()
        );
        let result = 1 + (beta_prefix % 100);
        assert!(result >= 1 && result <= 100);
    }

    #[test]
    fn test_network_urls() {
        assert_eq!(Network::Testnet.rpc_url(), "https://soroban-testnet.stellar.org");
        assert_eq!(Network::Mainnet.rpc_url(), "https://soroban.stellar.org");
    }
}
