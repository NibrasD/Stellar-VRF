/**
 * sorobanSubmit.ts — Submit VRF proofs to the deployed Soroban contract
 *
 * Security model:
 *   1. require_auth() — only the oracle Stellar address can call fulfill()
 *   2. PK match — contract verifies proof.public_key == stored oracle secp256k1 PK
 *   3. Ed25519 sig — oracle signs proof data with its Stellar Ed25519 key;
 *      contract verifies the signature on-chain via env.crypto().ed25519_verify()
 *
 * Network: Stellar Testnet
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
const FRIENDBOT = "https://friendbot.stellar.org";
const NETWORK = Networks.TESTNET;
const FEE = "1000000"; // 0.1 XLM max

// Fixed oracle Stellar keypair — funded from Friendbot on first use
// This is a Stellar Ed25519 key for:
//   - paying gas (source account)
//   - require_auth() access control (only this address can call fulfill)
//   - Ed25519 signing of proof data (verified on-chain)
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
  const kp = getOracleKP();

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
  const kp = getOracleKP();
  const srv = getServer();
  const account = await srv.getAccount(kp.publicKey());

  const alphaBytes = Buffer.from(alphaSeed, "utf-8");

  // requester = oracle address (signs require_auth on-chain)
  const requesterAddr = new Address(kp.publicKey());

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: VRF_CONTRACT_ADDRESS,
        function: "request",
        args: [
          nativeToScVal(alphaBytes, { type: "bytes" }),
          requesterAddr.toScVal(),
        ],
      })
    )
    .setTimeout(120)
    .build();

  const result = await sendTx(tx);
  let contractId = 0;
  try {
    const rv = result.returnValue as xdr.ScVal;
    const u64val = rv.u64();
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
 *
 * Security layers:
 *   1. Transaction is signed by oracle keypair → satisfies require_auth()
 *   2. proof.public_key is the oracle secp256k1 PK → contract checks it matches stored PK
 *   3. Ed25519 signature over (gamma || c || s || beta) → verified on-chain
 */
export async function sorobanFulfill(
  contractRequestId: number,
  alphaSeed: string,
  proof: EcvrfProof
): Promise<SorobanFulfillResult> {
  await ensureFunded();
  const kp = getOracleKP();
  const srv = getServer();
  const account = await srv.getAccount(kp.publicKey());

  // Build EcvrfProof struct matching the Soroban contract
  const alphaBytes = Buffer.from(alphaSeed, "utf-8");

  // gammaPoint is stored as 65-byte uncompressed (04||x||y) — contract wants 33-byte compressed
  // Compress manually: if y is even → 02||x, if y is odd → 03||x
  const gammaHex = proof.gammaPoint;
  let gammaBytes: Buffer;
  if (gammaHex.startsWith("04") && gammaHex.length === 130) {
    const raw = Buffer.from(gammaHex.slice(2), "hex"); // 64 bytes: x||y
    const x = raw.subarray(0, 32);
    const yLastByte = raw[63];
    const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
    gammaBytes = Buffer.concat([Buffer.from([prefix]), x]); // 33 bytes
  } else {
    gammaBytes = Buffer.from(gammaHex, "hex");
  }

  const cBytes = Buffer.from(proof.challengeScalar, "hex").subarray(0, 16); // 16 bytes
  const sBytes = Buffer.from(proof.responseScalar, "hex");  // 32 bytes
  const betaBytes = Buffer.from(proof.randomOutput, "hex");  // 32 bytes
  const pkBytes = Buffer.from(proof.publicKey, "hex");  // 33 bytes compressed

  // Ed25519 signature: sign (request_id_be8 || gamma || c || s || beta)
  // request_id as 8-byte big-endian — prevents proof reuse across different requests
  const ridBuf = Buffer.alloc(8);
  ridBuf.writeBigUInt64BE(BigInt(contractRequestId));
  const proofMessage = Buffer.concat([ridBuf, gammaBytes, cBytes, sBytes, betaBytes]);
  const ed25519Signature = kp.sign(proofMessage); // 64 bytes

  // Soroban contract type EcvrfProof fields (alphabetical order for Soroban map encoding)
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

  // Ed25519 signature as BytesN<64>
  const signatureScVal = nativeToScVal(Buffer.from(ed25519Signature), { type: "bytes" });

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: VRF_CONTRACT_ADDRESS,
        function: "fulfill",
        args: [
          nativeToScVal(contractRequestId, { type: "u64" }),
          proofMap,
          signatureScVal,
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
