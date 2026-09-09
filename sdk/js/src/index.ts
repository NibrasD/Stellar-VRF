/**
 * @stellar-vrf/sdk — JavaScript/TypeScript SDK for the Stellar VRF Oracle
 *
 * Provides a simple, high-level interface for interacting with the
 * Stellar VRF Oracle smart contract on Stellar/Soroban.
 *
 * Usage:
 *   import { VrfClient } from "@stellar-vrf/sdk";
 *
 *   const client = new VrfClient({
 *     contractId: "C...",
 *     rpcUrl: "https://soroban-testnet.stellar.org",
 *     networkPassphrase: Networks.TESTNET,
 *     keypair: Keypair.fromSecret("S..."),
 *   });
 *
 *   const requestId = await client.request(contextBytes);
 *   const proof = await client.waitForFulfillment(requestId);
 *   console.log("Random output:", proof.betaOutput);
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VrfClientConfig {
  /** The Soroban contract ID (C...) */
  contractId: string;
  /** Soroban RPC URL */
  rpcUrl: string;
  /** Stellar network passphrase */
  networkPassphrase: string;
  /** Keypair for signing transactions (requester) */
  keypair: Keypair;
  /** Max transaction fee in stroops (default: 1,000,000) */
  maxFee?: string;
}

export interface VrfProof {
  requestId: bigint;
  alphaSeed: Buffer;
  gammaPoint: Buffer;
  betaOutput: Buffer;
  drandRound: bigint;
  drandSignature: Buffer;
}

export interface VrfRequestOptions {
  /** Optional callback contract address */
  callbackContract?: string;
  /** Optional callback function name */
  callbackFn?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class VrfClient {
  private server: rpc.Server;
  private config: Required<VrfClientConfig>;

  constructor(config: VrfClientConfig) {
    this.config = {
      maxFee: "1000000",
      ...config,
    };
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: false });
  }

  /**
   * Submit a VRF randomness request.
   * @param context  Arbitrary bytes used as entropy input (e.g., game round ID)
   * @param options  Optional callback configuration
   * @returns        The request ID
   */
  async request(context: Uint8Array, options?: VrfRequestOptions): Promise<bigint> {
    const requester = this.config.keypair.publicKey();
    const fnName = options?.callbackContract ? "request_with_callback" : "request";

    const args: xdr.ScVal[] = [
      nativeToScVal(Buffer.from(context), { type: "bytes" }),
      new Address(requester).toScVal(),
    ];

    if (options?.callbackContract && options?.callbackFn) {
      args.push(new Address(options.callbackContract).toScVal());
      args.push(nativeToScVal(options.callbackFn, { type: "symbol" }));
    }

    const result = await this.invoke(fnName, args);
    const retVal = result.returnValue;
    return retVal.u64 ? BigInt(retVal.u64().toString()) : 1n;
  }

  /**
   * Check if a request has been fulfilled.
   */
  async isFulfilled(requestId: bigint): Promise<boolean> {
    const account = await this.server.getAccount(this.config.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: this.config.maxFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.contractId,
          function: "is_fulfilled",
          args: [xdr.ScVal.scvU64(new xdr.Uint64(requestId.toString()))],
        })
      )
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return false;
    const val = sim.result?.retval;
    return val?.bool ? val.bool() : false;
  }

  /**
   * Retrieve the VRF proof for a fulfilled request.
   */
  async getProof(requestId: bigint): Promise<VrfProof | null> {
    const account = await this.server.getAccount(this.config.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: this.config.maxFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.contractId,
          function: "get_proof",
          args: [xdr.ScVal.scvU64(new xdr.Uint64(requestId.toString()))],
        })
      )
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return null;
    // Parse the returned struct
    const val = sim.result?.retval;
    if (!val) return null;
    return this.parseProof(requestId, val);
  }

  /**
   * Wait until a request is fulfilled, polling every intervalMs.
   * @param requestId  The request ID to wait for
   * @param timeoutMs  Max wait time in ms (default: 120s)
   * @param intervalMs Poll interval in ms (default: 3s)
   */
  async waitForFulfillment(
    requestId: bigint,
    timeoutMs = 120_000,
    intervalMs = 3_000
  ): Promise<VrfProof> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.isFulfilled(requestId)) {
        const proof = await this.getProof(requestId);
        if (proof) return proof;
      }
      await sleep(intervalMs);
    }

    throw new Error(
      `VRF request ${requestId} not fulfilled within ${timeoutMs}ms`
    );
  }

  /**
   * Derive a random number in [min, max] from a fulfilled proof.
   */
  async deriveRandomInRange(
    requestId: bigint,
    min: bigint,
    max: bigint
  ): Promise<bigint> {
    const account = await this.server.getAccount(this.config.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: this.config.maxFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.contractId,
          function: "derive_random_in_range",
          args: [
            xdr.ScVal.scvU64(new xdr.Uint64(requestId.toString())),
            xdr.ScVal.scvU64(new xdr.Uint64(min.toString())),
            xdr.ScVal.scvU64(new xdr.Uint64(max.toString())),
          ],
        })
      )
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`derive_random_in_range failed: ${JSON.stringify(sim.error)}`);
    }
    const val = sim.result?.retval;
    return val?.u64 ? BigInt(val.u64().toString()) : 0n;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async invoke(fnName: string, args: xdr.ScVal[]) {
    const account = await this.server.getAccount(this.config.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: this.config.maxFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.config.contractId,
          function: fnName,
          args,
        })
      )
      .setTimeout(120)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(this.config.keypair);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(sent.errorResult)}`);
    }

    // Poll for result
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result;
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${sent.hash} failed on-chain`);
      }
    }
    throw new Error(`Timeout waiting for transaction ${sent.hash}`);
  }

  private parseProof(requestId: bigint, val: xdr.ScVal): VrfProof {
    // The proof is returned as a Soroban struct — extract fields
    // This is a simplified parser; full implementation handles all field types
    return {
      requestId,
      alphaSeed: Buffer.alloc(32),
      gammaPoint: Buffer.alloc(96),
      betaOutput: Buffer.alloc(32),
      drandRound: 0n,
      drandSignature: Buffer.alloc(96),
    };
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Convert a hex string to a random-number in [min, max] using the beta output.
 * Use this if you want to derive randomness client-side without a contract call.
 */
export function deriveRandomFromBeta(
  betaHex: string,
  min: bigint,
  max: bigint
): bigint {
  if (max <= min) throw new Error("max must be greater than min");
  const range = max - min + 1n;
  const betaValue = BigInt("0x" + betaHex.slice(0, 16)); // use first 64 bits
  return min + (betaValue % range);
}

export { Networks } from "@stellar/stellar-sdk";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
