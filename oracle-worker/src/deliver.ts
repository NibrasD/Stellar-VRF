/**
 * deliver.ts — best-effort `deliver(request_id)` after a callback request has
 * been fulfilled.
 *
 * In V2 `fulfill()` never runs consumer code. The callback runs in a separate
 * `deliver()` transaction that anyone may send. The worker sends one attempt
 * as a courtesy, and only if:
 *   - the request still has a pending callback,
 *   - simulation succeeds (a failing `on_vrf` is the consumer's problem: the
 *     result is final and readable with `get_beta()` either way), and
 *   - the simulated cost stays within the resource guard and
 *     DELIVER_MAX_FEE_STROOPS (the oracle pays for this transaction).
 *
 * Nothing here can affect the random output, so failures are logged, never
 * retried in a loop.
 */

import { TransactionBuilder, Operation, Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESS, NETWORK_PASSPHRASE, TX_FEE } from "./config.js";
import { log } from "./utils.js";
import { pollTransaction } from "./fulfiller.js";
import {
  checkSimulatedResources,
  resourceGuardOptionsFromEnv,
  simulatedResourcesOf,
  type ResourceGuardOptions,
} from "./resourceGuard.js";

const RESOURCE_GUARD: ResourceGuardOptions = resourceGuardOptionsFromEnv();

export type DeliverOutcome =
  | { delivered: true; hash: string }
  | { delivered: false; reason: string };

export async function submitDelivery(
  server: rpc.Server,
  requestId: bigint,
  signer: Keypair,
  maxFeeStroops: bigint
): Promise<DeliverOutcome> {
  try {
    const account = await server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, { fee: TX_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(
        Operation.invokeContractFunction({
          contract: CONTRACT_ADDRESS,
          function: "deliver",
          args: [nativeToScVal(requestId, { type: "u64" })],
        })
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return { delivered: false, reason: `simulation failed (consumer callback): ${sim.error}` };
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      return { delivered: false, reason: "simulation requires a state restore" };
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    const resources = simulatedResourcesOf(sim, BigInt(prepared.fee));
    const bounded = checkSimulatedResources(resources, RESOURCE_GUARD);
    if (!bounded.ok) return { delivered: false, reason: bounded.reason };
    if (BigInt(prepared.fee) > maxFeeStroops) {
      return {
        delivered: false,
        reason: `max fee ${prepared.fee} stroops exceeds DELIVER_MAX_FEE_STROOPS=${maxFeeStroops}`,
      };
    }

    prepared.sign(signer);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      return { delivered: false, reason: `send status ${sent.status}` };
    }
    const final = await pollTransaction(server, sent.hash);
    if (final.applied === "failed") return { delivered: false, reason: `transaction ${sent.hash} failed` };
    return { delivered: true, hash: sent.hash };
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Log-only wrapper used by the request pipeline. */
export async function deliverBestEffort(
  server: rpc.Server,
  requestId: bigint,
  signer: Keypair,
  maxFeeStroops: bigint
): Promise<void> {
  const out = await submitDelivery(server, requestId, signer, maxFeeStroops);
  if (out.delivered) {
    log.success(`  Callback delivered for request ${requestId}: ${out.hash}`);
  } else {
    log.warn(
      `  Callback for request ${requestId} not delivered (${out.reason}). The result is final; ` +
        `anyone (e.g. the consumer) can call deliver(${requestId}).`
    );
  }
}
