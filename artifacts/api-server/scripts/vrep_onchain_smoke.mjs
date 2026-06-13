import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bls12_381 } from "@noble/curves/bls12-381.js";
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

const SOROBAN_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const FEE = "1000000";
const FRIENDBOT = "https://friendbot.stellar.org";

const QUICKNET_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const QUICKNET_DRAND_PK_HEX =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
const QUICKNET_GENESIS_TIME = 1692803367;
const QUICKNET_PERIOD = 3;

const DRAND_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const VRF_DST = "SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_";
const BETA_DOMAIN = Buffer.from("VREP_BETA_V1", "utf-8");

const DEFAULT_ORACLE_SEED = "SCOYJ5ZYDYBAM7FPRHL4PTFYNSE62AAL7LREU676VWAUSP75CCJUW7QO";
const DEFAULT_BLS_SK_HEX = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  "../../../soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.wasm"
);

const server = new SorobanRpc.Server(SOROBAN_URL, { allowHttp: false });

function sha256(data) {
  return createHash("sha256").update(data).digest();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toU64(scVal) {
  const v = scVal.u64();
  if (typeof v.toNumber === "function") return v.toNumber();
  return Number(BigInt(v.toString()));
}

function u64be(n) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return out;
}

async function fundAccount(publicKey) {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (res.ok) return;
  const body = await res.text();
  if (body.includes("createAccountAlreadyExist") || body.includes("already funded")) return;
  throw new Error(`Friendbot failed for ${publicKey}: ${body.slice(0, 200)}`);
}

async function pollTx(hash) {
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const tx = await server.getTransaction(hash);
    if (tx.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return tx;
    if (tx.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`tx failed ${hash}: ${JSON.stringify(tx.resultMetaXdr ?? tx.resultXdr ?? tx)}`);
    }
  }
  throw new Error(`timeout waiting tx ${hash}`);
}

function extractCpu(simulated) {
  try {
    const insns =
      simulated?.transactionData?.build?.()?.resources?.()?.instructions?.();
    if (insns !== undefined && insns !== null) return Number(insns);
  } catch (e) {
    // ignore
  }
  try {
    if (simulated?.cost?.cpuInsns) return Number(simulated.cost.cpuInsns);
  } catch (e) {
    // ignore
  }
  return null;
}

async function sendTx(tx, signer) {
  const simulated = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulated)) {
    throw new Error(`simulation failed: ${simulated.error}`);
  }
  const cpuInsns = extractCpu(simulated);
  const prepared = SorobanRpc.assembleTransaction(tx, simulated).build();
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  }
  const confirmed = await pollTx(sent.hash);
  return { hash: sent.hash, tx: confirmed, cpuInsns };
}

function getBlsSecret() {
  const skHex = (process.env.ORACLE_BLS_SK_HEX || DEFAULT_BLS_SK_HEX).trim();
  const scalar = BigInt(`0x${skHex}`) % bls12_381.fields.Fr.ORDER;
  if (scalar === 0n) throw new Error("invalid ORACLE_BLS_SK_HEX (zero scalar)");
  return scalar;
}

function buildProof({ requestId, contextBytes, drandRound, drandSignatureHex, oracleBlsSk }) {
  const drandSigPoint = bls12_381.G1.Point.fromHex(drandSignatureHex);
  const drandSigBytes = Buffer.from(drandSigPoint.toBytes(false));
  const drandRandomness = sha256(drandSigBytes);
  const alphaSeed = sha256(Buffer.concat([u64be(requestId), contextBytes, u64be(drandRound), drandRandomness]));

  const hAlpha = bls12_381.G1.hashToCurve(alphaSeed, { DST: VRF_DST });
  const gamma = hAlpha.multiply(oracleBlsSk);
  const gammaBytes = Buffer.from(gamma.toBytes(false));

  const oraclePkPoint = bls12_381.G2.Point.BASE.multiply(oracleBlsSk);
  const oraclePkBytes = Buffer.from(oraclePkPoint.toBytes(false));

  const betaOutput = sha256(Buffer.concat([BETA_DOMAIN, gammaBytes]));

  const signMessage = Buffer.concat([
    u64be(requestId),
    alphaSeed,
    gammaBytes,
    betaOutput,
    u64be(drandRound),
    drandSigBytes,
  ]);

  return {
    alphaSeed,
    gammaBytes,
    betaOutput,
    oraclePkBytes,
    drandSigBytes,
    signMessage,
  };
}

async function fetchDrandBeacon(round) {
  const url = `https://api.drand.sh/${QUICKNET_HASH}/public/${round}`;
  for (let i = 0; i < 30; i++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const beacon = await res.json();
      if (!beacon?.signature) throw new Error(`invalid drand payload for round ${round}`);
      return beacon;
    }
    if (res.status === 404) {
      await sleep(2000);
      continue;
    }
    throw new Error(`drand fetch failed ${res.status}: ${await res.text()}`);
  }
  throw new Error(`drand round ${round} not available yet`);
}

async function callU64(contractAddress, fnName, args, signer) {
  const acct = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractAddress,
        function: fnName,
        args,
      })
    )
    .setTimeout(120)
    .build();
  const out = await sendTx(tx, signer);
  return { ...out, value: toU64(out.tx.returnValue) };
}
async function main() {
  const deployer = Keypair.random();
  const oracle = Keypair.fromSecret(process.env.ORACLE_STELLAR_SEED || DEFAULT_ORACLE_SEED);
  const oracleBlsSk = getBlsSecret();

  console.log("[0/8] funding accounts...");
  await fundAccount(deployer.publicKey());
  await fundAccount(oracle.publicKey());
  await sleep(3000);

  console.log("[1/8] uploading WASM...");
  const wasm = readFileSync(WASM_PATH);
  let account = await server.getAccount(deployer.publicKey());
  const uploadTx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(120)
    .build();
  const upload = await sendTx(uploadTx, deployer);
  const wasmHashHex = Buffer.from(upload.tx.returnValue.bytes()).toString("hex");

  console.log("[2/8] creating contract...");
  account = await server.getAccount(deployer.publicKey());
  const createTx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.createCustomContract({
        wasmHash: Buffer.from(wasmHashHex, "hex"),
        address: new Address(deployer.publicKey()),
        salt: Buffer.alloc(32, 0),
      })
    )
    .setTimeout(120)
    .build();
  const created = await sendTx(createTx, deployer);
  const contractAddress = Address.fromScVal(created.tx.returnValue).toString();

  console.log("[3/8] init contract...");
  const oraclePkBytes = Buffer.from(bls12_381.G2.Point.BASE.multiply(oracleBlsSk).toBytes(false));
  const g2GeneratorBytes = Buffer.from(bls12_381.G2.Point.BASE.toBytes(false));
  const drandPkBytes = Buffer.from(
    bls12_381.G2.Point.fromHex(QUICKNET_DRAND_PK_HEX).toBytes(false)
  );
  const initArgs = [
    nativeToScVal(oraclePkBytes, { type: "bytes" }),
    new Address(oracle.publicKey()).toScVal(),
    nativeToScVal(Buffer.from(oracle.rawPublicKey()), { type: "bytes" }),
    nativeToScVal(drandPkBytes, { type: "bytes" }),
    nativeToScVal(g2GeneratorBytes, { type: "bytes" }),
    nativeToScVal(QUICKNET_GENESIS_TIME, { type: "u64" }),
    nativeToScVal(QUICKNET_PERIOD, { type: "u32" }),
    nativeToScVal(1, { type: "u32" }),
  ];
  account = await server.getAccount(oracle.publicKey());
  const initTx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.invokeContractFunction({ contract: contractAddress, function: "init", args: initArgs }))
    .setTimeout(120)
    .build();
  const init = await sendTx(initTx, oracle);

  console.log("[4/8] request randomness...");
  const requestContext = Buffer.from(`smoke:${Date.now()}`, "utf-8");
  account = await server.getAccount(oracle.publicKey());
  const requestTx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractAddress,
        function: "request",
        args: [nativeToScVal(requestContext, { type: "bytes" }), new Address(oracle.publicKey()).toScVal()],
      })
    )
    .setTimeout(120)
    .build();
  const request = await sendTx(requestTx, oracle);
  const requestId = toU64(request.tx.returnValue);

  console.log("[5/8] read expected drand round...");
  const roundRes = await callU64(
    contractAddress,
    "request_round",
    [nativeToScVal(requestId, { type: "u64" })],
    oracle
  );
  const requiredRound = roundRes.value;

  console.log(`[6/8] fetch drand beacon round ${requiredRound}...`);
  const beacon = await fetchDrandBeacon(requiredRound);
  const proof = buildProof({
    requestId,
    contextBytes: requestContext,
    drandRound: requiredRound,
    drandSignatureHex: beacon.signature,
    oracleBlsSk,
  });
  const signature = oracle.sign(proof.signMessage);

  console.log("[7/8] fulfill + derive_random...");
  const proofMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("alpha_seed"), val: nativeToScVal(proof.alphaSeed, { type: "bytes" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("beta_output"), val: nativeToScVal(proof.betaOutput, { type: "bytes" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("drand_round"), val: nativeToScVal(requiredRound, { type: "u64" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("drand_signature"), val: nativeToScVal(proof.drandSigBytes, { type: "bytes" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("gamma_point"), val: nativeToScVal(proof.gammaBytes, { type: "bytes" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("public_key"), val: nativeToScVal(proof.oraclePkBytes, { type: "bytes" }) }),
  ]);

  account = await server.getAccount(oracle.publicKey());
  const fulfillTx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractAddress,
        function: "fulfill",
        args: [
          nativeToScVal(requestId, { type: "u64" }),
          proofMap,
          nativeToScVal(Buffer.from(signature), { type: "bytes" }),
        ],
      })
    )
    .setTimeout(120)
    .build();
  const fulfill = await sendTx(fulfillTx, oracle);

  const fulfilledRes = await (async () => {
    const acct = await server.getAccount(oracle.publicKey());
    const tx = new TransactionBuilder(acct, { fee: FEE, networkPassphrase: NETWORK })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractAddress,
          function: "is_fulfilled",
          args: [nativeToScVal(requestId, { type: "u64" })],
        })
      )
      .setTimeout(120)
      .build();
    const out = await sendTx(tx, oracle);
    return { hash: out.hash, value: out.tx.returnValue.b() };
  })();

  const deriveRes = await callU64(
    contractAddress,
    "derive_random",
    [nativeToScVal(requestId, { type: "u64" }), nativeToScVal(Buffer.from("smoke:ctx", "utf-8"), { type: "bytes" })],
    oracle
  );

  const summary = {
    contractAddress,
    wasmHashHex,
    requestId,
    requiredRound,
    drandRoundFromApi: beacon.round,
    tx: {
      upload: upload.hash,
      create: created.hash,
      init: init.hash,
      request: request.hash,
      requestRound: roundRes.hash,
      fulfill: fulfill.hash,
      isFulfilled: fulfilledRes.hash,
      deriveRandom: deriveRes.hash,
    },
    checks: {
      drandRoundMatch: Number(beacon.round) === Number(requiredRound),
      isFulfilled: fulfilledRes.value,
      derivedRandomU64: deriveRes.value,
      alphaSeedHex: proof.alphaSeed.toString("hex"),
      betaOutputHex: proof.betaOutput.toString("hex"),
    },
    cpuInstructions: {
      request: request.cpuInsns,
      requestRound: roundRes.cpuInsns,
      fulfill: fulfill.cpuInsns,
      deriveRandom: deriveRes.cpuInsns,
    },
    explorer: {
      contract: `https://stellar.expert/explorer/testnet/contract/${contractAddress}`,
      requestTx: `https://stellar.expert/explorer/testnet/tx/${request.hash}`,
      fulfillTx: `https://stellar.expert/explorer/testnet/tx/${fulfill.hash}`,
      deriveTx: `https://stellar.expert/explorer/testnet/tx/${deriveRes.hash}`,
    },
  };

  console.log("\n=== VREP On-chain Smoke Result ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("VREP smoke failed:", e?.stack || e?.message || e);
  process.exit(1);
});
