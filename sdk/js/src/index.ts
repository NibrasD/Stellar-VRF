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
  hash as sha256,
} from "@stellar/stellar-sdk";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VrfClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  keypair: Keypair;
  maxFee?: string;
  /**
   * Allow a plain `http://` RPC URL to a non-loopback host. Off by default: the
   * client signs and submits transactions, and a plaintext RPC can be
   * tampered with in transit (e.g. fake simulation results). `http://` to
   * `localhost` / `127.0.0.1` / `::1` (a local node) is always allowed.
   */
  allowHttp?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate the RPC URL: HTTPS required, except `http://` to loopback or with
 * an explicit `allowHttp: true`. Returns the `allowHttp` flag for rpc.Server.
 */
export function checkRpcUrl(rpcUrl: string, allowHttp = false): boolean {
  let u: URL;
  try {
    u = new URL(rpcUrl);
  } catch {
    throw new Error(`Invalid rpcUrl: ${rpcUrl}`);
  }
  if (u.protocol === "https:") return false;
  if (u.protocol !== "http:") {
    throw new Error(`rpcUrl must use https:// (got ${u.protocol})`);
  }
  if (LOOPBACK_HOSTS.has(u.hostname) || allowHttp) return true;
  throw new Error(
    `rpcUrl uses plaintext http:// to ${u.hostname}. Use https://, or pass ` +
      `allowHttp: true if you really mean it (a local/test node only).`
  );
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
    this.config = { maxFee: "1000000", allowHttp: false, ...config };
    const allowHttp = checkRpcUrl(config.rpcUrl, this.config.allowHttp);
    this.server = new rpc.Server(config.rpcUrl, { allowHttp });
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
   * using the contract's `derive_random_in_range(request_id, max)`, which
   * returns an **exactly** uniform value in [0, max) (rejection sampling, no
   * modulo bias). We request a span of (max - min + 1) and shift by `min`.
   * Equals `min + deriveRangeFromBeta(beta, requestId, span)` offline.
   *
   * There is no caller-chosen context: a value picked after the result is
   * known would allow grinding. Bind application data at `request()` time, or
   * use `deriveRangeForDomain()` with a **fixed** domain.
   *
   * Range limit: the contract takes an exclusive u64 bound, so `[min, max]` must
   * lie within u64 and contain at most 2^64 - 1 values.
   */
  async deriveRandomInRange(requestId: bigint, min: bigint, max: bigint): Promise<bigint> {
    const span = inclusiveSpan(min, max);
    const result = await this.simulate("derive_random_in_range", [
      nativeToScVal(requestId, { type: "u64" }),
      nativeToScVal(span, { type: "u64" }),
    ]);
    return BigInt(result as string | number | bigint) + min;
  }

  /**
   * Like `deriveRandomInRange()`, plus a short domain separator so one request
   * can feed several independent draws.
   *
   * **The domain MUST be fixed before fulfillment** (a constant, or a value
   * committed before `request()`). Whoever can pick it after the randomness is
   * public can try many domains and keep the best result. At most
   * `MAX_DERIVE_DOMAIN_LEN` bytes.
   */
  async deriveRangeForDomain(
    requestId: bigint,
    domain: Uint8Array,
    min: bigint,
    max: bigint
  ): Promise<bigint> {
    if (domain.length > MAX_DERIVE_DOMAIN_LEN) {
      throw new Error(`domain is ${domain.length} bytes; the contract accepts at most ${MAX_DERIVE_DOMAIN_LEN}`);
    }
    const span = inclusiveSpan(min, max);
    const result = await this.simulate("derive_range_for_domain", [
      nativeToScVal(requestId, { type: "u64" }),
      nativeToScVal(domain, { type: "bytes" }),
      nativeToScVal(span, { type: "u64" }),
    ]);
    return BigInt(result as string | number | bigint) + min;
  }

  /** The verified 32-byte beta (`get_beta`). Survives `cleanup_proof()`. */
  async getBeta(requestId: bigint): Promise<Uint8Array> {
    const result = await this.simulate("get_beta", [nativeToScVal(requestId, { type: "u64" })]);
    return toUint8Array(result);
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

function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // scValToNative may return Buffer-like objects (which are Uint8Array subclasses)
  if (typeof v === "object" && v !== null && "length" in v) {
    return new Uint8Array(v as ArrayLike<number>);
  }
  throw new Error(`Cannot convert ${typeof v} to Uint8Array`);
}

// ── Offline derivation (byte-for-byte identical to the contract) ─────────────

/** Domain prefix of every contract derivation (`DERIVE_DOMAIN`). */
export const DERIVE_DOMAIN = "VREP_DERIVE_V2";
/** Longest domain accepted by `derive_range_for_domain`. */
export const MAX_DERIVE_DOMAIN_LEN = 64;
const TAG_U64 = 0x01;
const TAG_RANGE = 0x02;
const TAG_RANGE_DOMAIN = 0x03;
const TWO_128 = 1n << 128n;

function be64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}

function be32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}

function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt("0x" + toHex(b));
}

function deriveHash(tag: number, requestId: bigint, parts: Uint8Array[], beta: Uint8Array): Uint8Array {
  if (beta.length !== 32) throw new Error("beta must be exactly 32 bytes");
  if (requestId < 0n || requestId > U64_MAX) throw new Error("requestId must be a u64");
  const input = Buffer.concat([
    Buffer.from(DERIVE_DOMAIN, "utf8"),
    Uint8Array.of(tag),
    be64(requestId),
    ...parts,
    beta,
  ]);
  return new Uint8Array(sha256(input));
}

function checkMax(max: bigint): void {
  if (max <= 0n || max > U64_MAX) throw new Error("max must be in [1, 2^64 - 1]");
}

/**
 * Exact-uniform reduction of a 32-byte hash into [0, max), identical to the
 * contract's `reduce_uniform()`: two 128-bit big-endian candidates, each
 * accepted iff `c < 2^128 - (2^128 mod max)`. Throws if both are rejected
 * (probability < 2^-128), exactly where the contract panics. No biased fallback.
 */
export function reduceUniform(hash: Uint8Array, max: bigint): bigint {
  if (hash.length !== 32) throw new Error("hash must be 32 bytes");
  checkMax(max);
  const limit = TWO_128 - (TWO_128 % max);
  for (const half of [hash.subarray(0, 16), hash.subarray(16, 32)]) {
    const c = bytesToBigInt(half);
    if (c < limit) return c % max;
  }
  throw new Error("range derivation failed: both candidates rejected");
}

/** Offline equivalent of the contract's `derive_random(request_id)`. */
export function deriveU64FromBeta(beta: Uint8Array, requestId: bigint): bigint {
  return bytesToBigInt(deriveHash(TAG_U64, requestId, [], beta).subarray(0, 8));
}

/**
 * Offline equivalent of the contract's `derive_random_in_range(request_id, max)`:
 * an exactly uniform value in [0, max).
 */
export function deriveRangeFromBeta(beta: Uint8Array, requestId: bigint, max: bigint): bigint {
  checkMax(max);
  if (max === 1n) {
    deriveHash(TAG_RANGE, requestId, [], beta); // still validate inputs
    return 0n;
  }
  return reduceUniform(deriveHash(TAG_RANGE, requestId, [be64(max)], beta), max);
}

/**
 * Offline equivalent of the contract's `derive_range_for_domain(request_id, domain, max)`.
 * **The domain must be fixed before fulfillment**, otherwise it can be ground.
 */
export function deriveRangeForDomainFromBeta(
  beta: Uint8Array,
  requestId: bigint,
  domain: Uint8Array,
  max: bigint
): bigint {
  checkMax(max);
  if (domain.length > MAX_DERIVE_DOMAIN_LEN) throw new Error("domain exceeds maximum length");
  if (max === 1n) return 0n;
  const h = deriveHash(TAG_RANGE_DOMAIN, requestId, [be32(domain.length), domain, be64(max)], beta);
  return reduceUniform(h, max);
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Number of values in [min, max], as the contract's exclusive u64 bound.
 * Throws for ranges outside u64 and for [0, 2^64 - 1], whose span (2^64) can't
 * be encoded as a u64 (nativeToScVal would otherwise fail with a less useful
 * error).
 */
function inclusiveSpan(min: bigint, max: bigint): bigint {
  if (max < min) throw new Error("max must be >= min");
  if (min < 0n || max > U64_MAX) throw new Error("min and max must be within u64 [0, 2^64 - 1]");
  const span = max - min + 1n;
  if (span > U64_MAX) {
    throw new Error(
      "range [0, 2^64 - 1] has 2^64 values and cannot be expressed as the contract's " +
        "exclusive u64 bound; use deriveU64FromBeta() or the raw beta instead"
    );
  }
  return span;
}

/**
 * Derive a random number in the inclusive range [min, max] client-side from a
 * beta output hex string, without a contract call.
 *
 * @deprecated Not the contract's function, and only negligibly (≤ 2^-64)
 * rather than exactly uniform. Use `deriveRangeFromBeta()`, which reproduces
 * the contract's `derive_random_in_range(request_id, max)` exactly.
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
