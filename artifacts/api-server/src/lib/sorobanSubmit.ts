/**
 * sorobanSubmit.ts — Submit VRF proofs to the deployed Soroban contract
 *
 * Contract: CB2T6ZARCT2L6BIKTSIOJLPBSY4HY2Z6VKWPW3N6XEMJDJXASKGPG77Q
 * Network:  Stellar Testnet
 *
 * This module funds an ephemeral oracle Stellar account from Friendbot,
 * then submits `request` and `fulfill` invocations to the live contract.
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  xdr,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import { VRF_CONTRACT_ADDRESS } from "./vrfCrypto.js";
import type { EcvrfProof } from "./vrfCrypto.js";

const SOROBAN_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT   = "https://friendbot.stellar.org";
const NETWORK     = Networks.TESTNET;
const FEE         = "1000000"; // 0.1 XLM max

// Fixed oracle Stellar keypair — funded from Friendbot on first use
// This is a Stellar Ed25519 key for paying gas (distinct from the secp256k1 VRF key)
// IMPORTANT: testnet only — do not use real XLM
const ORACLE_STELLAR_SEED =
  "SAQLZCQA6AYUXK6JSKVPJ2MY6LQLUCHJ7Q7PBNUKHFH6MRBJPOPZ7K6";

let oracleKP: Keypair;
let server: SorobanRpc.Server;
let oracleFunded = false;

function getServer(): SorobanRpc.Server {
  if (!server) {
    server = new SorobanRpc.Server(SOROBAN_URL, { allowHttp: false });
  }
  return server;
}

function getOracleKP(): Keypair {
  if (!oracleKP) {
    oracleKP = Keypair.fromSecret(ORACLE_STELLAR_SEED);
  }
  return oracleKP;
}

async function ensureFunded(): Promise<void> {
  if (oracleFunded) return;
  const kp = getOracleKP();
  const srv = getServer();
  try {
    await srv.getAccount(kp.publicKey());
    oracleFunded = true;
  } catch {
    // Account doesn't exist — fund it
    const res = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
    if (!res.ok) {
      const body = await res.text();
      if (!body.includes("createAccountAlreadyExist")) {
        throw new Error(`Friendbot failed: ${body.slice(0, 200)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
    oracleFunded = true;
  }
}

async function pollTx(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
  const srv = getServer();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await srv.getTransaction(hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return status;
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`On-chain tx failed: ${hash}`);
    }
  }
  throw new Error("Timeout waiting for tx: " + hash);
}

async function sendTx(tx: any): Promise<SorobanRpc.Api.GetTransactionResponse> {
  const srv = getServer();
  const kp  = getOracleKP();

  const simulated = await srv.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation error: ${simulated.error}`);
  }
  const prepared = SorobanRpc.assembleTransaction(tx, simulated).build();
  prepared.sign(kp);
  const sent = await srv.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(sent.errorResult)}`);
  }
  return pollTx(sent.hash);
}

export interface SorobanRequestResult {
  contractRequestId: number;
  txHash: string;
}

export interface SorobanFulfillResult {
  txHash: string;
  explorerUrl: string;
}

/**
 * Submit a VRF request to the Soroban contract and return the contract-assigned request ID.
 */
export async function sorobanRequest(
  alphaSeed: string,
  requesterAddress: string
): Promise<SorobanRequestResult> {
  await ensureFunded();
  const kp  = getOracleKP();
  const srv = getServer();
  const account = await srv.getAccount(kp.publicKey());

  const alphaBytes = Buffer.from(alphaSeed, "utf-8");

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: VRF_CONTRACT_ADDRESS,
        function: "request",
        args: [
          nativeToScVal(alphaBytes, { type: "bytes" }),
          nativeToScVal(requesterAddress, { type: "string" }),
        ],
      })
    )
    .setTimeout(120)
    .build();

  const result = await sendTx(tx);
  // Return value is SCV_U64 — the contract-assigned request ID
  const contractId = Number(
    (result.returnValue as xdr.ScVal).u64()
  );
  const txHash = result.txHash || "";
  return { contractRequestId: contractId, txHash };
}

/**
 * Submit a fulfilled ECVRF proof to the Soroban contract.
 */
export async function sorobanFulfill(
  contractRequestId: number,
  alphaSeed: string,
  proof: EcvrfProof
): Promise<SorobanFulfillResult> {
  await ensureFunded();
  const kp  = getOracleKP();
  const srv = getServer();
  const account = await srv.getAccount(kp.publicKey());

  // Build EcvrfProof struct matching the Soroban contract
  const alphaBytes  = Buffer.from(alphaSeed, "utf-8");
  const gammaBytes  = Buffer.from(proof.gammaPoint, "hex");       // 33 bytes compressed
  // challenge is 16 bytes (first half of 32-byte hash)
  const cBytes      = Buffer.from(proof.challengeScalar, "hex").subarray(0, 16);
  const sBytes      = Buffer.from(proof.responseScalar,  "hex");  // 32 bytes
  const betaBytes   = Buffer.from(proof.randomOutput,    "hex");  // 32 bytes
  const pkBytes     = Buffer.from(proof.publicKey,       "hex");  // 33 bytes compressed

  // Soroban contracttype EcvrfProof fields (in declaration order from lib.rs):
  //   alpha_seed, gamma_point, c_scalar, s_scalar, beta_output, public_key
  const proofMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("alpha_seed"),
      val: nativeToScVal(alphaBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("beta_output"),
      val: nativeToScVal(betaBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("c_scalar"),
      val: nativeToScVal(cBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("gamma_point"),
      val: nativeToScVal(gammaBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("public_key"),
      val: nativeToScVal(pkBytes, { type: "bytes" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("s_scalar"),
      val: nativeToScVal(sBytes, { type: "bytes" }),
    }),
  ]);

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: VRF_CONTRACT_ADDRESS,
        function: "fulfill",
        args: [
          nativeToScVal(contractRequestId, { type: "u64" }),
          proofMap,
        ],
      })
    )
    .setTimeout(120)
    .build();

  const result = await sendTx(tx);
  const txHash = result.txHash || "";
  return {
    txHash,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
  };
}
