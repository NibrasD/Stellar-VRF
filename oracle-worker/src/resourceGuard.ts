/**
 * resourceGuard.ts — refuse to send a fulfill() whose simulated cost is out of
 * bounds.
 *
 * Why: most of the cost of fulfill() is fixed (drand + BLS-VRF pairings), but
 * a callback request also runs the consumer's `on_vrf()` inside the same
 * transaction. A consumer can make that arbitrarily expensive, up to the
 * network's per-transaction limits, and the oracle pays the resource fee.
 * The fee guard (feeGuard.ts) caps the TOTAL unpaid spend per hour, and
 * sendAttempts.ts caps sends per request, but neither stops a single
 * pathological transaction from costing many times a normal one.
 *
 * This guard checks the simulation result BEFORE signing:
 *   - simulated CPU instructions   <= MAX_FULFILL_INSTRUCTIONS
 *   - simulated min resource fee   <= MAX_FULFILL_RESOURCE_FEE_STROOPS
 *   - assembled envelope max fee   <= MAX_FULFILL_TX_FEE_STROOPS
 *
 * A refusal is terminal for the request: the same inputs simulate the same
 * way, so retrying would only repeat the refusal. The requester can still
 * recover their fee with `timeout_refund()`.
 *
 * Defaults: the VRF core (drand check + VRF verify + Ed25519) is covered by
 * a 75M-instruction test in the contract suite; a normal fulfill without
 * callback measures ~58M on Mainnet. 90M leaves room for a modest callback
 * while staying below the 100M network transaction limit.
 */

export interface ResourceGuardOptions {
  maxInstructions: number;
  maxResourceFeeStroops: bigint;
  maxTxFeeStroops: bigint;
}

export interface SimulatedResources {
  /** CPU instructions from the simulated SorobanTransactionData. */
  instructions: number;
  /** `minResourceFee` from the simulation, in stroops. */
  resourceFeeStroops: bigint;
  /** Max fee of the assembled envelope (inclusion + resource), in stroops. */
  txFeeStroops: bigint;
}

export type ResourceDecision = { ok: true } | { ok: false; reason: string };

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: string): bigint {
  const raw = env[key] ?? fallback;
  if (!/^[0-9]+$/.test(raw.trim()) || BigInt(raw.trim()) <= 0n) {
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  }
  return BigInt(raw.trim());
}

export function resourceGuardOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ResourceGuardOptions {
  const maxInstructions = positiveInt(env, "MAX_FULFILL_INSTRUCTIONS", "90000000");
  if (maxInstructions > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("MAX_FULFILL_INSTRUCTIONS is too large");
  }
  return {
    maxInstructions: Number(maxInstructions),
    maxResourceFeeStroops: positiveInt(env, "MAX_FULFILL_RESOURCE_FEE_STROOPS", "5000000"),
    maxTxFeeStroops: positiveInt(env, "MAX_FULFILL_TX_FEE_STROOPS", "6000000"),
  };
}

/** Pure decision: may a transaction with these simulated resources be sent? */
export function checkSimulatedResources(
  res: SimulatedResources,
  opts: ResourceGuardOptions
): ResourceDecision {
  if (!Number.isFinite(res.instructions) || res.instructions < 0) {
    return { ok: false, reason: `simulation reported invalid instruction count ${res.instructions}` };
  }
  if (res.instructions > opts.maxInstructions) {
    return {
      ok: false,
      reason:
        `simulated CPU ${res.instructions} instructions exceeds MAX_FULFILL_INSTRUCTIONS ` +
        `(${opts.maxInstructions}); likely an expensive consumer callback`,
    };
  }
  if (res.resourceFeeStroops > opts.maxResourceFeeStroops) {
    return {
      ok: false,
      reason:
        `simulated resource fee ${res.resourceFeeStroops} stroops exceeds ` +
        `MAX_FULFILL_RESOURCE_FEE_STROOPS (${opts.maxResourceFeeStroops})`,
    };
  }
  if (res.txFeeStroops > opts.maxTxFeeStroops) {
    return {
      ok: false,
      reason:
        `transaction max fee ${res.txFeeStroops} stroops exceeds ` +
        `MAX_FULFILL_TX_FEE_STROOPS (${opts.maxTxFeeStroops})`,
    };
  }
  return { ok: true };
}

/** Read a field that stellar-sdk exposes either as a property or an accessor. */
function field(obj: unknown, name: string): unknown {
  const v = (obj as Record<string, unknown>)?.[name];
  return typeof v === "function" ? (v as () => unknown).call(obj) : v;
}

/**
 * Extract the simulated instruction count and resource fee from a successful
 * simulation. Throws when the fields are missing, so the caller fails closed
 * instead of sending an unchecked transaction.
 */
export function simulatedResourcesOf(
  simulated: { transactionData?: unknown; minResourceFee?: unknown },
  txFeeStroops: bigint
): SimulatedResources {
  const builder = simulated.transactionData as { build?: () => unknown } | undefined;
  const data = builder && typeof builder.build === "function" ? builder.build() : builder;
  const instructions = Number(field(field(data, "resources"), "instructions"));
  if (simulated.minResourceFee === undefined || !Number.isFinite(instructions)) {
    throw new Error("simulation result has no resource data; refusing to send unchecked");
  }
  return {
    instructions,
    resourceFeeStroops: BigInt(String(simulated.minResourceFee)),
    txFeeStroops,
  };
}
