/**
 * fulfiller.ts — Build and submit fulfill() transactions to the VRF contract
 *
 * Constructs the Soroban contract invocation with the VRF proof,
 * simulates it, signs, and submits with retry logic.
 */

import {
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import {
  CONTRACT_ADDRESS,
  NETWORK_PASSPHRASE,
  ORACLE_KEYPAIR,
  ORACLE_PUBLIC_KEY,
  TX_FEE,
  MAX_RETRIES,
} from "./config.js";
import { log, sleep, bytesToHex } from "./utils.js";
import type { VrfProofData } from "./vrf.js";
import {
  checkSimulatedResources,
  resourceGuardOptionsFromEnv,
  simulatedResourcesOf,
  type ResourceGuardOptions,
} from "./resourceGuard.js";
import {
  FulfillTerminalError,
  classifyFulfillError,
  failureError,
  isNonRetryable,
  isPreInclusionRejection,
} from "./fulfillErrors.js";
import type { SendOutcome } from "./feeGuard.js";

/** Identifies one send, so its fee reservation can be settled by outcome. */
export interface SentTx {
  hash: string;
  /** Tx `maxTime` (ms): once a later ledger closes without it, it can never land. */
  validUntilMs?: number;
}

/**
 * Result of the pre-send gate. `settle` is called exactly once per sent
 * transaction with how it ended (see feeGuard.SendOutcome).
 */
export type SendGate =
  | { ok: true; settle?: (outcome: SendOutcome, tx: SentTx) => Promise<void> }
  | { ok: false; reason: string };

// Parsed once at startup so a bad value fails fast instead of on the first request.
const RESOURCE_GUARD: ResourceGuardOptions = resourceGuardOptionsFromEnv();

/**
 * Thrown when submission is aborted on purpose (e.g. leadership lost). Callers
 * must NOT retry this — retrying is exactly what the abort is preventing.
 */
export class FulfillAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FulfillAbortedError";
  }
}

/**
 * Submit a fulfill() transaction to the VRF contract.
 *
 * @param server    - Soroban RPC server
 * @param requestId - The on-chain request ID
 * @param proof     - The complete VRF proof data
 * @param canSubmit - Checked immediately before EVERY attempt (including
 *                    internal retries). Return false to abort — used to stop a
 *                    node that lost leadership mid-retry from submitting.
 * @param beforeSend - Called with the assembled transaction's maximum fee
 *                    (stroops) and a unique send id (the tx hash) immediately
 *                    before EVERY `sendTransaction()`. Returning `{ ok: false }`
 *                    aborts without sending. This is where the fee guard
 *                    reserves spend, so retries count too. The returned
 *                    `settle` is told how that send ended:
 *                    `not_included` (sendTransaction ERROR / TRY_AGAIN_LATER:
 *                    never entered a ledger, no fee), `success`, `failed`
 *                    (applied, fee charged) or `unknown` (no answer).
 * @returns The transaction hash on success
 */
export async function submitFulfillment(
  server: rpc.Server,
  requestId: bigint,
  proof: VrfProofData,
  canSubmit: () => boolean = () => true,
  beforeSend: (maxFeeStroops: bigint, sendId: string) => Promise<SendGate> = async () => ({ ok: true })
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (!canSubmit()) {
      throw new FulfillAbortedError(
        `aborting fulfill(${requestId}) before attempt ${attempt}: no longer allowed to submit (leadership lost)`
      );
    }
    try {
      log.info(
        `Submitting fulfill for request ${requestId} (attempt ${attempt}/${MAX_RETRIES})…`
      );

      // 1. Build the proof struct as ScVal
      const proofScVal = buildProofScVal(proof);

      // 2. Build the transaction
      const account = await server.getAccount(ORACLE_PUBLIC_KEY);

      const tx = new TransactionBuilder(account, {
        fee: TX_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: CONTRACT_ADDRESS,
            function: "fulfill",
            args: [
              // request_id: u64
              nativeToScVal(requestId, { type: "u64" }),
              // proof: BlsVrfProof struct
              proofScVal,
              // signature: BytesN<64>
              nativeToScVal(proof.ed25519Signature, { type: "bytes" }),
            ],
          })
        )
        .setTimeout(120)
        .build();

      // 3. Simulate
      const simulated = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulated)) {
        // Contract panics (already fulfilled, bad proof, …) are terminal.
        throw failureError("Simulation error", simulated.error);
      }
      if (!rpc.Api.isSimulationSuccess(simulated)) {
        // Restore-needed: an archived entry. Not something retrying fixes.
        throw new FulfillTerminalError(
          `Simulation requires a state restore for fulfill(${requestId})`,
          "entry_archived",
          false
        );
      }

      // 4. Assemble, then bound the cost BEFORE signing (see resourceGuard.ts).
      const prepared = rpc.assembleTransaction(tx, simulated).build();
      const resources = simulatedResourcesOf(simulated, BigInt(prepared.fee));
      log.info(
        `  Simulated CPU: ${resources.instructions} instructions, resource fee ` +
          `${resources.resourceFeeStroops} stroops, max fee ${resources.txFeeStroops} stroops`
      );
      const bounded = checkSimulatedResources(resources, RESOURCE_GUARD);
      if (!bounded.ok) {
        throw new FulfillTerminalError(
          `refusing fulfill(${requestId}): ${bounded.reason}`,
          "resource_bound_exceeded",
          false
        );
      }

      // Last gate before money can move. `prepared.fee` is the envelope's max
      // fee (inclusion + resource fee): Stellar never charges more than this.
      if (!canSubmit()) {
        throw new FulfillAbortedError(
          `aborting fulfill(${requestId}) attempt ${attempt}: no longer allowed to submit (leadership lost)`
        );
      }
      // The hash doesn't cover signatures, so it's known before signing and is
      // a unique id for this send's fee reservation.
      const tx0 = txIdentity(prepared, requestId, attempt);
      const gate = await beforeSend(BigInt(prepared.fee), tx0.hash);
      if (!gate.ok) {
        throw new FulfillAbortedError(`aborting fulfill(${requestId}) attempt ${attempt}: ${gate.reason}`);
      }
      const settle = gate.settle ?? (async () => {});

      prepared.sign(ORACLE_KEYPAIR);

      let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
      try {
        sent = await server.sendTransaction(prepared);
      } catch (err) {
        // No answer: it may or may not have reached core.
        await settle("unknown", tx0);
        throw err;
      }
      const sentTx: SentTx = { ...tx0, hash: sent.hash || tx0.hash };
      if (sent.status === "TRY_AGAIN_LATER") {
        // Not queued by core: never entered a ledger, no fee.
        await settle("not_included", sentTx);
        throw new Error(`Send TRY_AGAIN_LATER for fulfill(${requestId}) (not queued)`);
      }
      if (sent.status === "ERROR") {
        // Rejected at submission. The reservation is released only for the
        // known pre-inclusion codes in fulfillErrors.ts (tx_bad_seq,
        // tx_insufficient_fee, time bounds, …): those never enter a ledger,
        // so no fee was charged. Anything unlisted stays counted
        // (conservative) until it leaves the one-hour window.
        if (isPreInclusionRejection(sent.errorResult)) {
          await settle("not_included", sentTx);
        } else {
          log.warn(`fulfill(${requestId}) rejected with an unlisted code; keeping its fee reservation`);
          await settle("failed", sentTx);
        }
        throw failureError("Send error", sent.errorResult);
      }

      // 5. Poll for confirmation
      let outcome: SendOutcome = "unknown";
      try {
        const final = await pollTransaction(server, sentTx.hash);
        if (final.applied === "failed") {
          outcome = "failed"; // applied and failed: the fee was charged
          throw failureError(`Transaction failed: ${sentTx.hash}`, final.resultXdr);
        }
        outcome = "success";
      } finally {
        await settle(outcome, sentTx);
      }

      log.success(
        `Request ${requestId} fulfilled! TX: ${sentTx.hash}`
      );

      return sentTx.hash;
    } catch (err: unknown) {
      if (isNonRetryable(err)) throw err; // deliberate abort or deterministic failure
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(
        `Fulfill attempt ${attempt} failed for request ${requestId}: ${errMsg}`
      );
      const cls = classifyFulfillError(err);
      if (cls.kind === "terminal") {
        throw new FulfillTerminalError(errMsg, cls.reason, cls.settled);
      }

      if (attempt < MAX_RETRIES) {
        const backoff = Math.min(2000 * 2 ** (attempt - 1), 15_000);
        log.info(`Retrying in ${backoff}ms…`);
        await sleep(backoff);
      } else {
        throw new Error(
          `Failed to fulfill request ${requestId} after ${MAX_RETRIES} attempts: ${errMsg}`
        );
      }
    }
  }

  throw new Error(`Unreachable: fulfill retry loop exhausted`);
}

/**
 * Build the BlsVrfProof struct as an ScVal (Soroban struct).
 */
function buildProofScVal(proof: VrfProofData): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("alpha_seed"),
      val: nativeToScVal(proof.alphaSeed, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("beta_output"),
      val: nativeToScVal(proof.betaOutput, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("drand_round"),
      val: nativeToScVal(proof.drandRound, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("drand_signature"),
      val: nativeToScVal(proof.drandSignature, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("gamma_point"),
      val: nativeToScVal(proof.gammaPoint, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("public_key"),
      val: nativeToScVal(proof.publicKey, { type: "bytes" }),
    }),
  ]);
}

/** Hash and validity window of an assembled tx (test doubles may lack both). */
function txIdentity(prepared: unknown, requestId: bigint, attempt: number): SentTx {
  const p = prepared as { hash?: () => Uint8Array; timeBounds?: { maxTime?: string } };
  let hash: string;
  try {
    hash = p.hash ? Buffer.from(p.hash()).toString("hex") : "";
  } catch {
    hash = "";
  }
  if (!hash) hash = `req${requestId}-a${attempt}-${Date.now()}`;
  const maxTime = Number(p.timeBounds?.maxTime ?? 0);
  return { hash, validUntilMs: maxTime > 0 ? maxTime * 1000 : undefined };
}

/**
 * Poll for transaction confirmation with timeout. Resolves once the tx is in
 * a ledger (`success` or `failed`); throws only when there is no answer
 * (timeout or RPC error), i.e. the outcome is unknown.
 */
async function pollTransaction(
  server: rpc.Server,
  hash: string,
  maxWaitMs = 120_000
): Promise<{ applied: "success" } | { applied: "failed"; resultXdr: unknown }> {
  const start = Date.now();
  process.stdout.write("  Confirming");

  while (Date.now() - start < maxWaitMs) {
    await sleep(2000);
    const status = await server.getTransaction(hash);

    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" ✔\n");
      return { applied: "success" };
    }

    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" ✖\n");
      // Applied and failed (fee charged). The result code says whether a
      // retry could ever succeed, e.g. a trapping callback never will.
      return { applied: "failed", resultXdr: (status as any).resultXdr };
    }

    process.stdout.write(".");
  }

  process.stdout.write(" timeout\n");
  throw new Error(`Transaction confirmation timeout: ${hash}`);
}
