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

/**
 * Submit a fulfill() transaction to the VRF contract.
 *
 * @param server    - Soroban RPC server
 * @param requestId - The on-chain request ID
 * @param proof     - The complete VRF proof data
 * @returns The transaction hash on success
 */
export async function submitFulfillment(
  server: rpc.Server,
  requestId: bigint,
  proof: VrfProofData
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
        throw new Error(`Simulation error: ${simulated.error}`);
      }

      // Log the estimated CPU budget
      if (rpc.Api.isSimulationSuccess(simulated)) {
        const cost = (simulated as any).cost;
        if (cost) {
          log.info(
            `  Estimated CPU: ${cost.cpuInsns} instructions, Mem: ${cost.memBytes} bytes`
          );
        }
      }

      // 4. Assemble, sign, and submit
      const prepared = rpc.assembleTransaction(tx, simulated).build();
      prepared.sign(ORACLE_KEYPAIR);

      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new Error(
          `Send error: ${JSON.stringify(sent.errorResult)}`
        );
      }

      // 5. Poll for confirmation
      const result = await pollTransaction(server, sent.hash);

      log.success(
        `Request ${requestId} fulfilled! TX: ${sent.hash}`
      );

      return sent.hash;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(
        `Fulfill attempt ${attempt} failed for request ${requestId}: ${errMsg}`
      );

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
      throw new Error(`Transaction failed: ${hash}`);
    }

    process.stdout.write(".");
  }

  process.stdout.write(" timeout\n");
  throw new Error(`Transaction confirmation timeout: ${hash}`);
}
