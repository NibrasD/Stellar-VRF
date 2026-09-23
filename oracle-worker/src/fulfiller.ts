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
} from "./fulfillErrors.js";

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
 *                    (stroops) immediately before EVERY `sendTransaction()`.
 *                    Returning `{ ok: false }` aborts without sending. This is
 *                    where the fee guard reserves spend, so retries count too.
 * @returns The transaction hash on success
 */
export async function submitFulfillment(
  server: rpc.Server,
  requestId: bigint,
  proof: VrfProofData,
  canSubmit: () => boolean = () => true,
  beforeSend: (maxFeeStroops: bigint) => Promise<{ ok: true } | { ok: false; reason: string }> =
    async () => ({ ok: true })
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
      const gate = await beforeSend(BigInt(prepared.fee));
      if (!gate.ok) {
        throw new FulfillAbortedError(`aborting fulfill(${requestId}) attempt ${attempt}: ${gate.reason}`);
      }

      prepared.sign(ORACLE_KEYPAIR);

      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw failureError("Send error", sent.errorResult);
      }

      // 5. Poll for confirmation
      const result = await pollTransaction(server, sent.hash);

      log.success(
        `Request ${requestId} fulfilled! TX: ${sent.hash}`
      );

      return sent.hash;
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

/**
 * Poll for transaction confirmation with timeout.
 */
async function pollTransaction(
  server: rpc.Server,
  hash: string,
  maxWaitMs = 120_000
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const start = Date.now();
  process.stdout.write("  Confirming");

  while (Date.now() - start < maxWaitMs) {
    await sleep(2000);
    const status = await server.getTransaction(hash);

    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" ✔\n");
      return status as rpc.Api.GetSuccessfulTransactionResponse;
    }

    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" ✖\n");
      // Applied and failed (fee charged). The result code says whether a
      // retry could ever succeed, e.g. a trapping callback never will.
      throw failureError(`Transaction failed: ${hash}`, (status as any).resultXdr);
    }

    process.stdout.write(".");
  }

  process.stdout.write(" timeout\n");
  throw new Error(`Transaction confirmation timeout: ${hash}`);
}
