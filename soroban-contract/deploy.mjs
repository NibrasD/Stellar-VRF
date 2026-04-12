/**
 * deploy.mjs — Deploy soroban-vrf-oracle to Stellar Testnet
 * Compatible with @stellar/stellar-sdk v15
 *
 * Steps:
 *  1. Generate deployer keypair and fund from Friendbot
 *  2. Upload the WASM blob
 *  3. Create a contract instance
 *  4. Init the contract with oracle PK, oracle address, and Ed25519 PK
 *  5. Save the contract address to deployed.json
 */

// Run from workspace root:
//   node soroban-contract/deploy.mjs

import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SDK_INDEX = path.resolve(
  __dirname,
  "../node_modules/.pnpm/@stellar+stellar-sdk@15.0.1/node_modules/@stellar/stellar-sdk/lib/index.js"
);
const stellar = await import(SDK_INDEX);

const {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Address,
  nativeToScVal,
  rpc,
} = stellar.default || stellar;

const SOROBAN_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const FRIENDBOT = "https://friendbot.stellar.org";

// Oracle secp256k1 compressed public key (matches vrfCrypto.ts private key)
const ORACLE_PK_HEX =
  "032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645";

// Oracle Stellar Ed25519 keypair (pays gas + signs proofs)
const ORACLE_STELLAR_SEED = "SCOYJ5ZYDYBAM7FPRHL4PTFYNSE62AAL7LREU676VWAUSP75CCJUW7QO";
const oracleKP = Keypair.fromSecret(ORACLE_STELLAR_SEED);
const ORACLE_ADDRESS = oracleKP.publicKey(); // GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI
const ORACLE_ED25519_PK = oracleKP.rawPublicKey(); // 32 bytes

const WASM_PATH = path.join(
  __dirname,
  "target/wasm32-unknown-unknown/release/soroban_vrf_oracle.wasm"
);
const OUT_PATH = path.join(__dirname, "deployed.json");

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fundAccount(pk) {
  const res = await fetch(`${FRIENDBOT}?addr=${pk}`);
  if (!res.ok) {
    const body = await res.text();
    if (!body.includes("createAccountAlreadyExist") && !body.includes("already funded")) {
      throw new Error(`Friendbot error ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log("  Account already funded.");
  } else {
    console.log("  Funded OK via Friendbot.");
  }
}

async function pollTx(server, hash) {
  process.stdout.write("  Waiting");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await server.getTransaction(hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(" done.");
      return status;
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${hash}`);
    }
    process.stdout.write(".");
  }
  throw new Error("Timeout waiting for transaction: " + hash);
}

async function sendAndConfirm(server, signerKP, tx) {
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation error: ${simulated.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulated).build();
  prepared.sign(signerKP);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Send error: ${JSON.stringify(sent.errorResult)}`);
  }
  return pollTx(server, sent.hash);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (existsSync(OUT_PATH)) {
    const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    console.log(`\nAlready deployed: ${prev.contractAddress}`);
    console.log(`Explorer: ${prev.explorerUrl}`);
    console.log("Delete soroban-contract/deployed.json to re-deploy.\n");
    return prev;
  }

  const server = new rpc.Server(SOROBAN_URL, { allowHttp: false });

  // 1. Deployer keypair
  const deployerKP = Keypair.random();
  console.log(`\n═══ Soroban VRF Oracle — Testnet Deployment (v2: auth + ed25519) ═══`);
  console.log(`Deployer:      ${deployerKP.publicKey()}`);
  console.log(`Oracle PK:     ${ORACLE_PK_HEX}`);
  console.log(`Oracle Addr:   ${ORACLE_ADDRESS}`);
  console.log(`Oracle Ed25519: ${Buffer.from(ORACLE_ED25519_PK).toString("hex")}`);

  // 2. Fund deployer AND oracle accounts
  console.log("\n[1/4] Funding accounts via Friendbot...");
  await fundAccount(deployerKP.publicKey());
  await fundAccount(ORACLE_ADDRESS);
  await new Promise((r) => setTimeout(r, 5000));

  // 3. Upload WASM
  console.log("\n[2/4] Uploading WASM...");
  const wasmBytes = readFileSync(WASM_PATH);
  console.log(`  WASM size: ${wasmBytes.length} bytes`);
  let account = await server.getAccount(deployerKP.publicKey());

  const uploadTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK,
  })
    .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
    .setTimeout(120)
    .build();

  const uploadResult = await sendAndConfirm(server, deployerKP, uploadTx);
  const wasmHash = Buffer.from(uploadResult.returnValue.bytes()).toString("hex");
  console.log(`  WASM hash: ${wasmHash}`);

  // 4. Create contract
  console.log("\n[3/4] Creating contract instance...");
  account = await server.getAccount(deployerKP.publicKey());
  const salt = Buffer.alloc(32, 0);

  const createTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.createCustomContract({
        wasmHash: Buffer.from(wasmHash, "hex"),
        address: new Address(deployerKP.publicKey()),
        salt,
      })
    )
    .setTimeout(120)
    .build();

  const createResult = await sendAndConfirm(server, deployerKP, createTx);
  const contractAddressObj = Address.fromScVal(createResult.returnValue);
  const contractAddress = contractAddressObj.toString();
  console.log(`  Contract address: ${contractAddress}`);

  // 5. Init with oracle PK + oracle address + Ed25519 PK
  //    Use oracle as source account so require_auth() passes
  console.log("\n[4/4] Initializing contract (oracle PK + address + Ed25519)...");
  account = await server.getAccount(oracleKP.publicKey());
  const oraclePKScVal = nativeToScVal(Buffer.from(ORACLE_PK_HEX, "hex"), {
    type: "bytes",
  });
  const oracleAddrScVal = new Address(ORACLE_ADDRESS).toScVal();
  const oracleEd25519ScVal = nativeToScVal(Buffer.from(ORACLE_ED25519_PK), {
    type: "bytes",
  });

  const initTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractAddress,
        function: "init",
        args: [oraclePKScVal, oracleAddrScVal, oracleEd25519ScVal],
      })
    )
    .setTimeout(120)
    .build();

  const simInit = await server.simulateTransaction(initTx);
  if (rpc.Api.isSimulationError(simInit)) {
    throw new Error(`Init simulation error: ${simInit.error}`);
  }
  const preparedInit = rpc.assembleTransaction(initTx, simInit).build();
  preparedInit.sign(oracleKP);
  const sentInit = await server.sendTransaction(preparedInit);
  if (sentInit.status === "ERROR") {
    throw new Error(`Init send error: ${JSON.stringify(sentInit.errorResult)}`);
  }
  await pollTx(server, sentInit.hash);
  console.log("  Contract initialized with oracle PK, address, and Ed25519 PK (oracle auth verified).");

  // 6. Persist
  const result = {
    contractAddress,
    wasmHash,
    deployerPublicKey: deployerKP.publicKey(),
    oraclePublicKeyHex: ORACLE_PK_HEX,
    oracleStellarAddress: ORACLE_ADDRESS,
    oracleEd25519Hex: Buffer.from(ORACLE_ED25519_PK).toString("hex"),
    network: "testnet",
    sorobanRpcUrl: SOROBAN_URL,
    deployedAt: new Date().toISOString(),
    explorerUrl: `https://stellar.expert/explorer/testnet/contract/${contractAddress}`,
    securityFeatures: [
      "require_auth() — only oracle address can call fulfill()",
      "PK match — proof.public_key must equal stored oracle secp256k1 PK",
      "Ed25519 signature — proof data signed by oracle Ed25519 key, verified on-chain",
    ],
  };
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\n  Deployment complete!`);
  console.log(`   Contract:  ${contractAddress}`);
  console.log(`   Explorer:  ${result.explorerUrl}`);
  console.log(`   Security:  require_auth + PK match + Ed25519 sig verify`);
  console.log(`   Saved to:  ${OUT_PATH}`);
  return result;
}

main().catch((e) => {
  console.error("\nDeployment failed:", e.message || e);
  process.exit(1);
});
