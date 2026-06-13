# Soroban Verifiable Randomness Oracle (Soroban-VRF)

**Cryptographically provable, tamper-proof randomness for Soroban smart contracts.**

## What is it?
Soroban-VRF is a production-grade oracle that provides unbiasable and unpredictable randomness to dApps on the Stellar network. It is built to ensure fairness in on-chain gaming, NFT minting, lotteries, and governance mechanisms.

## How it works (Quick Overview)
The protocol combines two independent cryptographic layers to guarantee security, verified entirely on-chain using Soroban's native host functions:

1. **drand (League of Entropy):** Every randomness request is strictly bound to a *future* drand round. This ensures **Input Unpredictability**—neither the oracle nor the user can predict or influence the input entropy.
2. **BLS-VRF (Pairing-based VRF):** Once the future drand round is published, the oracle generates a unique BLS signature (the VRF proof) over the input. This ensures **Output Secrecy & Uniqueness**—the result remains hidden until on-chain fulfillment, and the oracle cannot grind or produce multiple valid outcomes.

### The Lifecycle
1. **Request:** A dApp requests randomness on-chain. The contract locks a fee and commits to a future drand round.
2. **Wait:** The oracle waits for the required future drand round to be published globally.
3. **Fulfill:** The oracle generates a BLS-VRF proof and submits it to the contract.
4. **Verify & Callback:** The contract verifies the drand threshold signature and the VRF pairing on-chain (~58M CPU instructions). If valid, it safely delivers the randomness to the dApp via a cross-contract callback.

For full technical details, please see our [Technical Architecture Document](docs/TECHNICAL_ARCHITECTURE_V2.md) and our [SCF Grant Application](docs/SCF_GRANT_APPLICATION.md).
