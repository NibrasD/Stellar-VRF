/**
 * deploy.mjs — Deploy soroban-vrf-oracle to Stellar Testnet
 * Compatible with @stellar/stellar-sdk v15
 *
 * Steps:
 *  1. Generate deployer keypair and fund from Friendbot
 *  2. Upload the WASM blob
 *  3. Create a contract instance
 *  4. Init the contract with the oracle public key
 *  5. Save the contract address to deployed.json
 */

// Run from workspace root:
//   node soroban-contract/deploy.mjs

import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import from pnpm hoisted location
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
const NETWORK     = Networks.TESTNET;
const FRIENDBOT   = "https://friendbot.stellar.org";

// Oracle secp256k1 compressed public key (matches vrfCrypto.ts private key)
const ORACLE_PK_HEX =
  "032c8c31fc9f990c6b55e3865a184a4ce50e09481f2eaeb3e60ec1cea13a6ae645";

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
    if (!body.includes("createAccountAlreadyExist")) {
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

async function sendAndConfirm(server, deployerKP, tx) {
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation error: ${simulated.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulated).build();
  prepared.sign(deployerKP);
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
  console.log(`\n═══ Soroban VRF Oracle — Testnet Deployment ═══`);
  console.log(`Deployer:   ${deployerKP.publicKey()}`);
  console.log(`Oracle PK:  ${ORACLE_PK_HEX}`);

  // 2. Fund
  console.log("\n[1/4] Funding deployer via Friendbot...");
  await fundAccount(deployerKP.publicKey());
  await new Promise((r) => setTimeout(r, 5000)); // wait for ledger close

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
  // returnValue is an ScVal of type SCV_ADDRESS
  // Use Address.fromScVal to convert it properly
  const contractAddressObj = Address.fromScVal(createResult.returnValue);
  const contractAddress = contractAddressObj.toString();
  console.log(`  Contract address: ${contractAddress}`);

  // 5. Init
  console.log("\n[4/4] Initializing contract...");
  account = await server.getAccount(deployerKP.publicKey());
  const oraclePKScVal = nativeToScVal(Buffer.from(ORACLE_PK_HEX, "hex"), {
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
        args: [oraclePKScVal],
      })
    )
    .setTimeout(120)
    .build();

  await sendAndConfirm(server, deployerKP, initTx);
  console.log("  Contract initialized with oracle public key.");

  // 6. Persist
  const result = {
    contractAddress,
    wasmHash,
    deployerPublicKey: deployerKP.publicKey(),
    oraclePublicKeyHex: ORACLE_PK_HEX,
    network: "testnet",
    sorobanRpcUrl: SOROBAN_URL,
    deployedAt: new Date().toISOString(),
    explorerUrl: `https://stellar.expert/explorer/testnet/contract/${contractAddress}`,
  };
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\n✅ Deployment complete!`);
  console.log(`   Contract:  ${contractAddress}`);
  console.log(`   Explorer:  ${result.explorerUrl}`);
  console.log(`   Saved to:  ${OUT_PATH}`);
  return result;
}

main().catch((e) => {
  console.error("\n❌ Deployment failed:", e.message || e);
  process.exit(1);
});
