/**
 * testnet_deploy.mjs — Deploy the new VRF contract on Stellar Testnet
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { bls12_381 } from "@noble/curves/bls12-381";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  Account,
} from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const server = new rpc.Server(TESTNET_RPC, { allowHttp: false });

const ORACLE_SECRET = process.env.ORACLE_STELLAR_SECRET || process.env.ORACLE_SECRET;
if (!ORACLE_SECRET) {
  console.error("ERROR: ORACLE_STELLAR_SECRET or ORACLE_SECRET env var is required");
  process.exit(1);
}
const ORACLE_KP = Keypair.fromSecret(ORACLE_SECRET);
const ORACLE_PUBLIC = ORACLE_KP.publicKey();
const ORACLE_ED25519 = ORACLE_KP.rawPublicKey().toString("hex");

// Derive BLS public key from secret key
const BLS_SK_HEX = (process.env.ORACLE_BLS_SECRET_KEY ?? "").trim().replace(/^0x/, "");
if (!/^[0-9a-fA-F]{1,64}$/.test(BLS_SK_HEX)) {
  console.error("ERROR: ORACLE_BLS_SECRET_KEY is required");
  process.exit(1);
}
const BLS_SK = BigInt("0x" + BLS_SK_HEX);
const ORACLE_BLS_PK = Buffer.from(
  bls12_381.G2.ProjectivePoint.BASE.multiply(BLS_SK).toRawBytes(false)
).toString("hex");

// drand quicknet G2 public key (192 bytes uncompressed)
const DRAND_PK =
  "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";

// Native XLM SAC on Testnet
const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const FEE_AMOUNT = 0n; // fee-free on testnet for frictionless testing

const WASM_PATH = path.resolve(
  __dirname,
  "../soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.optimized.wasm"
);

console.log("\n=== Stellar VRF Oracle — Testnet Deployment ===");
console.log(`  Network        : ${NETWORK}`);
console.log(`  RPC            : ${TESTNET_RPC}`);
console.log(`  Oracle account : ${ORACLE_PUBLIC}`);
console.log(`  Oracle BLS pk  : ${ORACLE_BLS_PK.slice(0, 32)}…`);
console.log(`  Fee token      : ${XLM_SAC_TESTNET} (native XLM SAC Testnet)`);
console.log(`  Fee amount     : ${FEE_AMOUNT} stroops`);
console.log(`  WASM           : ${WASM_PATH}`);

async function getAccount(publicKey) {
  try {
    return await server.getAccount(publicKey);
  } catch (e) {
    const resp = await fetch(`https://horizon-testnet.stellar.org/accounts/${publicKey}`);
    if (!resp.ok) throw new Error(`Horizon testnet account not found: ${publicKey}`);
    const data = await resp.json();
    return new Account(publicKey, data.sequence);
  }
}

async function pollTx(hash) {
  process.stdout.write("  Confirming");
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await server.getTransaction(hash);
    if (s.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      process.stdout.write(" ✔\n");
      return s;
    }
    if (s.status === rpc.Api.GetTransactionStatus.FAILED) {
      process.stdout.write(" ✖\n");
      throw new Error(`TX FAILED: ${hash} — ${JSON.stringify(s.resultXdr || s.errorResult || s)}`);
    }
    process.stdout.write(".");
  }
  throw new Error("Timeout: " + hash);
}

async function simRead(publicKey, contractId, fn, fnArgs) {
  const account = await getAccount(publicKey);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args: fnArgs }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Sim error (${fn}): ${JSON.stringify(sim.error)}`);
  return scValToNative(sim.result.retval);
}

async function main() {
  console.log("\n[1/4] Checking account...");
  const acct = await getAccount(ORACLE_PUBLIC);
  console.log(`  Sequence: ${acct.sequence} ✔`);

  console.log("\n[2/4] Uploading WASM...");
  const wasmBytes = fs.readFileSync(WASM_PATH);
  const wasmHash = crypto.createHash("sha256").update(wasmBytes).digest();
  console.log(`  WASM size: ${wasmBytes.length} bytes`);
  console.log(`  WASM sha256: ${wasmHash.toString("hex")}`);

  const uploadAcct = await getAccount(ORACLE_PUBLIC);
  const uploadTx = new TransactionBuilder(uploadAcct, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
    .setTimeout(300)
    .build();

  const uploadSim = await server.simulateTransaction(uploadTx);
  if (rpc.Api.isSimulationError(uploadSim)) throw new Error("Upload sim: " + JSON.stringify(uploadSim.error));

  const uploadPrep = rpc.assembleTransaction(uploadTx, uploadSim).build();
  uploadPrep.sign(ORACLE_KP);
  const uploadSent = await server.sendTransaction(uploadPrep);
  if (uploadSent.status === "ERROR") throw new Error("Upload send: " + JSON.stringify(uploadSent.errorResult));
  console.log(`  Upload TX: https://stellar.expert/explorer/testnet/tx/${uploadSent.hash}`);
  await pollTx(uploadSent.hash);

  console.log("\n[3/4] Deploying contract instance with atomic constructor...");
  const salt = crypto.randomBytes(32);
  const constructorArgs = [
    nativeToScVal(Buffer.from(ORACLE_BLS_PK, "hex"), { type: "bytes" }),
    new Address(ORACLE_PUBLIC).toScVal(),
    nativeToScVal(ORACLE_KP.rawPublicKey(), { type: "bytes" }),
    nativeToScVal(Buffer.from(DRAND_PK, "hex"), { type: "bytes" }),
    xdr.ScVal.scvU64(1692803367n),
    xdr.ScVal.scvU32(3),
    xdr.ScVal.scvU32(2),
    new Address(XLM_SAC_TESTNET).toScVal(),
    nativeToScVal(0n, { type: "i128" }),
  ];

  const deployAcct = await getAccount(ORACLE_PUBLIC);
  const deployTx = new TransactionBuilder(deployAcct, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(
      Operation.createCustomContract({
        wasmHash: wasmHash,
        address: new Address(ORACLE_PUBLIC),
        salt: salt,
        constructorArgs,
      })
    )
    .setTimeout(300)
    .build();

  const deploySim = await server.simulateTransaction(deployTx);
  if (rpc.Api.isSimulationError(deploySim)) throw new Error("Deploy sim: " + JSON.stringify(deploySim.error));

  const deployPrep = rpc.assembleTransaction(deployTx, deploySim).build();
  deployPrep.sign(ORACLE_KP);
  const deploySent = await server.sendTransaction(deployPrep);
  if (deploySent.status === "ERROR") throw new Error("Deploy send: " + JSON.stringify(deploySent.errorResult));
  console.log(`  Deploy TX: https://stellar.expert/explorer/testnet/tx/${deploySent.hash}`);
  const deployRes = await pollTx(deploySent.hash);

  let contractId;
  try {
    const returnVal = deployRes.resultMetaXdr.v3().sorobanMeta().returnValue();
    contractId = Address.fromScVal(returnVal).toString();
  } catch (e) {
    if (deploySim.result?.retval) {
      contractId = Address.fromScVal(deploySim.result.retval).toString();
    }
  }

  if (!contractId) throw new Error("Could not extract contract ID from deploy result");
  console.log(`  CONTRACT ID: ${contractId}`);

  console.log("\n[4/4] Verifying constructor configuration on Testnet...");
  const storedPkHex = Buffer.from(await simRead(ORACLE_PUBLIC, contractId, "oracle_pk", [])).toString("hex");
  if (storedPkHex !== ORACLE_BLS_PK) {
    throw new Error(`Constructor check failed: oracle_pk mismatch`);
  }
  const storedOracle = await simRead(ORACLE_PUBLIC, contractId, "oracle_address", []);
  if (storedOracle !== ORACLE_PUBLIC) {
    throw new Error(`Constructor check failed: oracle_address mismatch`);
  }
  console.log("  oracle_pk() and oracle_address() match constructor arguments ✔");

  const record = {
    contractAddress: contractId,
    wasmHash: wasmHash.toString("hex"),
    deployerPublicKey: ORACLE_PUBLIC,
    oraclePublicKeyHex: ORACLE_BLS_PK,
    oracleStellarAddress: ORACLE_PUBLIC,
    oracleEd25519Hex: ORACLE_ED25519,
    network: "testnet",
    sorobanRpcUrl: TESTNET_RPC,
    deployedAt: new Date().toISOString(),
    explorerUrl: `https://stellar.expert/explorer/testnet/contract/${contractId}`,
    uploadTxHash: uploadSent.hash,
    deployTxHash: deploySent.hash,
  };

  fs.writeFileSync(path.resolve(__dirname, "deployed.testnet.json"), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.resolve(__dirname, "../soroban-contract/deployed.testnet.json"), JSON.stringify(record, null, 2));
  console.log("\nSaved deployment records to deployed.testnet.json ✔");
  console.log(`\n🎉 Testnet Contract deployed successfully: ${contractId}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
