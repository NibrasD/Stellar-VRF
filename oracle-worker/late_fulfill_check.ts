/**
 * late_fulfill_check.ts — drill for the fulfillment deadline.
 *
 *   REQUEST_ID=<id> npx tsx late_fulfill_check.ts
 *
 * Builds a VALID proof for a request and simulates fulfill() (nothing is
 * sent). Before the window closes the simulation succeeds; after
 * `required_round + TIMEOUT_ROUNDS` the contract must reject it, which is
 * what makes fulfill and timeout_refund mutually exclusive.
 */
import { TransactionBuilder, Operation, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESS, NETWORK_PASSPHRASE, ORACLE_KEYS, TIMEOUT_ROUNDS } from "./src/config.js";
import { createServer, fetchRequestContext, readEpoch, readRequestEpoch } from "./src/listener.js";
import { waitAndFetchBeacon, computeCurrentRound } from "./src/drand.js";
import { generateVrfProof } from "./src/vrf.js";
import { selectKeySet } from "./src/keys.js";
import { buildProofScVal } from "./src/fulfiller.js";

const id = BigInt(process.env.REQUEST_ID ?? "1");
const server = createServer();
const epochId = (await readRequestEpoch(server, id))!;
const epoch = (await readEpoch(server, epochId))!;
const keys = selectKeySet(ORACLE_KEYS, epoch)!;
const acct = await server.getAccount(keys.stellar.publicKey());
const sim0 = await server.simulateTransaction(
  new TransactionBuilder(acct, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT_ADDRESS, function: "request_round", args: [nativeToScVal(id, { type: "u64" })] }))
    .setTimeout(30).build()
);
const round = Number((sim0 as any).result.retval.value ?? (sim0 as any).result.retval.u64?.());
const now = computeCurrentRound(Date.now() / 1000);
console.log(`request ${id}: bound round ${round}, current round ${now}, window ends at ${round + TIMEOUT_ROUNDS} (${now > round + TIMEOUT_ROUNDS ? "CLOSED" : "open"})`);
const beacon = await waitAndFetchBeacon(round);
const proof = generateVrfProof(id, await fetchRequestContext(server, id), beacon, epochId, keys, CONTRACT_ADDRESS);
const tx = new TransactionBuilder(await server.getAccount(keys.stellar.publicKey()), { fee: "1000000", networkPassphrase: NETWORK_PASSPHRASE })
  .addOperation(Operation.invokeContractFunction({ contract: CONTRACT_ADDRESS, function: "fulfill", args: [nativeToScVal(id, { type: "u64" }), buildProofScVal(proof)] }))
  .setTimeout(60).build();
const sim = await server.simulateTransaction(tx);
console.log(rpc.Api.isSimulationError(sim) ? `fulfill simulation: REJECTED (${String(sim.error).split("\n")[0]})` : "fulfill simulation: ACCEPTED");
process.exit(0);
