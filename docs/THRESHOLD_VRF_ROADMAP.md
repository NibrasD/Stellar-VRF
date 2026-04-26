# Threshold VRF / MPC Roadmap

This file outlines a practical roadmap to move from a single-operator design to a multi-party (threshold) VRF or MPC-based oracle.

1) Goals
- Eliminate single-operator bias and censorship.
- Ensure unpredictable, unbiased entropy that can be publicly verified.

2) Milestone-1 (deliverable on testnet: 2-of-3 mock threshold flow)
- Deliver a coordinator that accepts 3 participants and requires at least 2 partials before finalize.
- Publish participant public key set and quorum policy in repository config/docs.
- Add a testnet path that stores participant set hash and round metadata with each fulfilled request.

3) Milestone-2 (integration)
- Build production coordinator and participant signer nodes (Docker/K8s), secured with mTLS.
- Store participant verification keys on-chain and enforce quorum acceptance logic for threshold fulfill.

4) Milestone-3 (production)
- Harden key custody via HSMs per participant and run key-rotation drills.
- Add economic slashing/incentives for misbehaviour where protocol economics permit.

Notes
- Implementing threshold VRF is a large effort and requires cryptographic expertise and external review before production.
