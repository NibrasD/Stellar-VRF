/**
 * stellar-vrf-sdk — JavaScript/TypeScript SDK for the Stellar VRF Oracle
 *
 * Usage:
 *   import { VrfClient, Networks } from "stellar-vrf-sdk";
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
 *   const roll = await client.deriveRandomInRange(requestId, 1n, 6n);
 */

import {
  Keypair,
  Networks as StellarNetworks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VrfClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  keypair: Keypair;
  maxFee?: string;
}

export interface VrfProof {
  requestId: bigint;
  alphaSeed: Uint8Array;    // 32 bytes
  gammaPoint: Uint8Array;   // 96 bytes (G1 point)
  betaOutput: Uint8Array;   // 32 bytes (the random output)
  publicKey: Uint8Array;    // 192 bytes (G2 point)
  drandRound: bigint;
  drandSignature: Uint8Array; // 96 bytes
}

export interface VrfRequestOptions {
  callbackContract?: string;
  callbackFn?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class VrfClient {
  private server: rpc.Server;
  private config: Required<VrfClientConfig>;

  constructor(config: VrfClientConfig) {
    this.config = { maxFee: "1000000", ...config };
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  }

  /**
   * Submit a VRF randomness request.
   * @param context  Arbitrary bytes used as entropy input
   * @param options  Optional callback contract + function
   * @returns        The request ID assigned by the contract
   */
  async request(context: Uint8Array, options?: VrfRequestOptions): Promise<bigint> {
    const requester = this.config.keypair.publicKey();
    const fnName = options?.callbackContract ? "request_with_callback" : "request";

    const args: xdr.ScVal[] = [
      nativeToScVal(context instanceof Uint8Array ? context : new Uint8Array(context), { type: "bytes" }),
      new Address(requester).toScVal(),
    ];

    if (options?.callbackContract && options?.callbackFn) {
      args.push(new Address(options.callbackContract).toScVal());
      args.push(xdr.ScVal.scvSymbol(options.callbackFn));
    }

    const txResult = await this.submitTx(fnName, args);
    // Return value is the u64 request ID. Use the SDK's `returnValue` accessor
    // rather than reaching into `resultMetaXdr.v3()`: the meta union arm varies
    // by protocol version (v3 under Protocol 21/22, v4 under Protocol 23), so
    // hard-coding `.v3()` throws "Bad union switch" on current networks.
    const retval = txResult.returnValue;
    if (retval) {
      const native = scValToNative(retval);
      return BigInt(native as string | number | bigint);
    }
    throw new Error("No return value from request()");
  }

  /**
   * Check if a request has been fulfilled.
   */
  async isFulfilled(requestId: bigint): Promise<boolean> {
    const result = await this.simulate("is_fulfilled", [
      nativeToScVal(requestId, { type: "u64" }),
    ]);
    return result === true;
  }

  /**
   * Check if a request has been refunded.
   */
  async isRefunded(requestId: bigint): Promise<boolean> {
    const result = await this.simulate("is_refunded", [
      nativeToScVal(requestId, { type: "u64" }),
    ]);
    return result === true;
  }

  /**
   * Retrieve the VRF proof for a fulfilled request.
   */
  async getProof(requestId: bigint): Promise<VrfProof | null> {
    try {
      const raw = await this.simulate("get_proof", [
        nativeToScVal(requestId, { type: "u64" }),
      ]);
      return this.parseProofFromNative(requestId, raw);
    } catch {
      return null;
    }
  }

  /**
   * Derive a verifiable random number in the inclusive range [min, max]
   * using the contract's `derive_random_in_range(request_id, context, max)`,
   * which returns a value in [0, max). We request a span of (max - min + 1)
   * and shift the result by `min` to cover the inclusive range.
   *
   * @param requestId  The fulfilled request id.
   * @param min        Inclusive lower bound.
   * @param max        Inclusive upper bound.
   * @param context    Domain-separation bytes (must match what the consumer
   *                   used); defaults to an empty byte string.
   */
  async deriveRandomInRange(
    requestId: bigint,
    min: bigint,
    max: bigint,
    context: Uint8Array = new Uint8Array()
  ): Promise<bigint> {
    if (max < min) throw new Error("max must be >= min");
    const span = max - min + 1n;
    const result = await this.simulate("derive_random_in_range", [
      nativeToScVal(requestId, { type: "u64" }),
      nativeToScVal(context, { type: "bytes" }),
      nativeToScVal(span, { type: "u64" }),
    ]);
    return BigInt(result as string | number | bigint) + min;
  }

  /**
   * Wait until a request is fulfilled, polling every intervalMs.
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
    throw new Error(`VRF request ${requestId} not fulfilled within ${timeoutMs}ms`);
  }

  /**
   * Poll for new VRF request events from the contract.
   * @param startLedger  Starting ledger sequence number
   * @param limit        Max events to return (default 50)
   */
  async getRequestEvents(startLedger: number, limit = 50) {
    const response = await this.server.getEvents({
      filters: [{
        type: "contract",
        contractIds: [this.config.contractId],
        topics: [[xdr.ScVal.scvSymbol("request").toXDR("base64")]],
      }],
      startLedger,
      limit,
    });
    return (response.events || []).map((e) => {
      const native = scValToNative(e.value) as [bigint, string, bigint];
      return {
        requestId: BigInt(native[0]),
        requester: native[1],
        requiredRound: BigInt(native[2]),
        ledger: e.ledger,
        pagingToken: (e as any).pagingToken ?? "",
      };
    });
  }

  /**
   * Poll for fulfill events from the contract.
   */
  async getFulfillEvents(startLedger: number, limit = 50) {
    const response = await this.server.getEvents({
      filters: [{
        type: "contract",
        contractIds: [this.config.contractId],
        topics: [[xdr.ScVal.scvSymbol("fulfill").toXDR("base64")]],
      }],
      startLedger,
      limit,
    });
    return (response.events || []).map((e) => {
      const native = scValToNative(e.value) as [bigint, Uint8Array];
      return {
        requestId: BigInt(native[0]),
        betaOutput: native[1] as Uint8Array,
        ledger: e.ledger,
      };
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Run a read-only simulate call and return the native JS value */
  private async simulate(fnName: string, args: xdr.ScVal[]): Promise<unknown> {
    const account = await this.server.getAccount(this.config.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: this.config.maxFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(Operation.invokeContractFunction({
        contract: this.config.contractId,
        function: fnName,
        args,
      }))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${fnName} simulation error: ${JSON.stringify(sim.error)}`);
    }
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return null;
    return scValToNative(retval);
  }

  /** Build, simulate, sign, and submit a state-changing transaction */
  private async submitTx(
    fnName: string,
    args: xdr.ScVal[]
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const account = await this.server.getAccount(this.config.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: this.config.maxFee,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(Operation.invokeContractFunction({
        contract: this.config.contractId,
        function: fnName,
        args,
      }))
      .setTimeout(120)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${fnName} simulation error: ${JSON.stringify(sim.error)}`);
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(this.config.keypair);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`Send error: ${JSON.stringify(sent.errorResult)}`);
    }

    // Poll for confirmation
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result as rpc.Api.GetSuccessfulTransactionResponse;
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${sent.hash} failed on-chain`);
      }
    }
    throw new Error(`Timeout waiting for transaction ${sent.hash}`);
  }

  /**
   * Parse the native JS object returned by get_proof() into a VrfProof.
   * The contract returns a BlsVrfProof struct which scValToNative converts
   * to a plain object: { alpha_seed, beta_output, drand_round, drand_signature, gamma_point, public_key }
   */
  private parseProofFromNative(requestId: bigint, raw: unknown): VrfProof {
    const obj = raw as Record<string, unknown>;
    const toUint8Array = (v: unknown): Uint8Array => {
      if (v instanceof Uint8Array) return v;
      if (Array.isArray(v)) return new Uint8Array(v as number[]);
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      // scValToNative may return Buffer-like objects (which are Uint8Array subclasses)
      if (typeof v === "object" && v !== null && "length" in v) {
        return new Uint8Array(v as ArrayLike<number>);
      }
      throw new Error(`Cannot convert ${typeof v} to Uint8Array`);
    };
    return {
      requestId,
      alphaSeed: toUint8Array(obj["alpha_seed"]),
      gammaPoint: toUint8Array(obj["gamma_point"]),
      betaOutput: toUint8Array(obj["beta_output"]),
      publicKey: toUint8Array(obj["public_key"]),
      drandRound: BigInt(obj["drand_round"] as string | number | bigint),
      drandSignature: toUint8Array(obj["drand_signature"]),
    };
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Derive a random number in the inclusive range [min, max] client-side from a
 * beta output hex string. Use this when you don't want to make an extra
 * contract call.
 *
 * Bias: this consumes **128 bits** of beta and reduces modulo the range. For a
 * uniform `x` in [0, 2^128) and any range < 2^64, the deviation between residue
 * classes is bounded by `range / 2^128 <= 2^-64` — cryptographically negligible.
 *
 * An earlier version used only the first 64 bits, which gave a bias of up to
 * `range / 2^64`; that becomes significant for very large ranges (approaching
 * 50% skew as the range approaches 2^63).
 */
export function deriveRandomFromBeta(betaHex: string, min: bigint, max: bigint): bigint {
  if (max <= min) throw new Error("max must be greater than min");
  const hex = betaHex.startsWith("0x") ? betaHex.slice(2) : betaHex;
  if (hex.length < 32) throw new Error("beta must provide at least 16 bytes (32 hex chars)");
  const range = max - min + 1n;
  // 32 hex chars = 16 bytes = 128 bits of entropy.
  const betaValue = BigInt("0x" + hex.slice(0, 32));
  return min + (betaValue % range);
}

/** Convert Uint8Array to hex string */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { Keypair } from "@stellar/stellar-sdk";

/**
 * Network passphrases.
 *
 * Re-exported from `@stellar/stellar-sdk` with an added `MAINNET` alias for
 * `PUBLIC`: "mainnet" is the term used throughout this project's docs, while
 * the upstream SDK calls the live network `PUBLIC`. Both keys are valid.
 */
export const Networks = {
  ...StellarNetworks,
  /** Alias of `PUBLIC` — the live Stellar network. */
  MAINNET: StellarNetworks.PUBLIC,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
