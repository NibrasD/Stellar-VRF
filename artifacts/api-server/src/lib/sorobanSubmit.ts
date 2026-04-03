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
// GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI
const ORACLE_STELLAR_SEED =
  "SCOYJ5ZYDYBAM7FPRHL4PTFYNSE62AAL7LREU676VWAUSP75CCJUW7QO";

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
      throw new Error(`On-chain tx failed (${hash}): ${JSON.stringify((status as any).resultMetaXdr ?? (status as any).resultXdr ?? status)}`);
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
  // xdr Uint64 is represented as a Long object — convert via toString first
  let contractId = 0;
  try {
    const rv = result.returnValue as xdr.ScVal;
    const u64val = rv.u64();
    // xdr Long objects have a .toNumber() or .toString() method
    contractId = typeof (u64val as any).toNumber === "function"
      ? (u64val as any).toNumber()
      : Number(BigInt((u64val as any).toString()));
  } catch (e) {
    // Non-critical — we still have the tx hash
  }
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
  // gammaPoint is stored as 65-byte uncompressed (04||x||y) — contract wants 33-byte compressed
  // Compress manually: if y is even → 02||x, if y is odd → 03||x (no library needed)
  const gammaHex = proof.gammaPoint;
  let gammaBytes: Buffer;
  if (gammaHex.startsWith("04") && gammaHex.length === 130) {
    const raw = Buffer.from(gammaHex.slice(2), "hex"); // 64 bytes: x||y
    const x   = raw.subarray(0, 32);
    const yLastByte = raw[63]; // last byte of y
    const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
    gammaBytes = Buffer.concat([Buffer.from([prefix]), x]); // 33 bytes
  } else {
    gammaBytes = Buffer.from(gammaHex, "hex"); // already compact
  }
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
