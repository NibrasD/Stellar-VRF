/**
 * deploy.mjs — Deploy soroban-vrf-oracle (VREP/BLS) to Stellar Testnet
 * Compatible with @stellar/stellar-sdk v15
 *
 * Steps:
 *  1. Generate deployer keypair and fund from Friendbot
 *  2. Upload the WASM blob
 *  3. Create a contract instance
 *  4. Init the contract with oracle BLS PK, drand PK, and timing parameters
 *  5. Save the contract address to deployed.json
 */

// Run from workspace root:
//   node soroban-contract/deploy.mjs

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SDK_INDEX = path.resolve(
  __dirname,
  "../node_modules/.pnpm/@stellar+stellar-sdk@15.0.1/node_modules/@stellar/stellar-sdk/lib/index.js"
);
const stellar = await import(pathToFileURL(SDK_INDEX).href);

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

// Oracle BLS12-381 G2 public key (uncompressed 192 bytes)
const ORACLE_PK_HEX =
  "0d180c4b1368d78f859cdf9b63f09ee43bc26e940487ba4c39fa203e7f2acf217cc639b600fb3af781094fe3685ee76711a6fde86af52cfb7d49c56f48fc58db2c704b75397b7873e5ddb84d23bf27f50461cf38031156998c9e7f694b2b307b0b214b74b7ab8c8cc53b54ae98a32a0d75dda1668ac7d0590e26ee0d94122a516c666f19cfd3fdb31a689050fc02ea9d14b767ff9497b3eedcb3f0b3136732a2ebae133ef7bc9422fe8363aaba02882cd4235c3dc642e81bdeecd67f5c83324d";

const DRAND_PK_HEX =
  "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";
const G2_GENERATOR_HEX =
  "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";
const DRAND_GENESIS_TIME = 1692803367;
const DRAND_PERIOD = 3;
const ROUND_OFFSET = 1;

// Oracle Stellar Ed25519 keypair (pays gas + signs proofs)
const ORACLE_STELLAR_SEED = "SCOYJ5ZYDYBAM7FPRHL4PTFYNSE62AAL7LREU676VWAUSP75CCJUW7QO";
const oracleKP = Keypair.fromSecret(ORACLE_STELLAR_SEED);
const ORACLE_ADDRESS = oracleKP.publicKey(); // GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI
const ORACLE_ED25519_PK = oracleKP.rawPublicKey(); // 32 bytes

const WASM_PATH = path.join(
  __dirname,
  "target/wasm32v1-none/release/soroban_vrf_oracle.wasm"
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
  console.log(`\n═══ Soroban VRF Oracle — Testnet Deployment (v4: VREP/BLS) ═══`);
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

  // 5. Init with oracle BLS PK + oracle address + Ed25519 PK + drand settings
  //    Use oracle as source account so require_auth() passes
  console.log("\n[4/4] Initializing contract (oracle BLS + drand config)...");
  account = await server.getAccount(oracleKP.publicKey());
  const oraclePKScVal = nativeToScVal(Buffer.from(ORACLE_PK_HEX, "hex"), {
    type: "bytes",
  });
  const oracleAddrScVal = new Address(ORACLE_ADDRESS).toScVal();
  const oracleEd25519ScVal = nativeToScVal(Buffer.from(ORACLE_ED25519_PK), {
    type: "bytes",
  });
  const drandPkScVal = nativeToScVal(Buffer.from(DRAND_PK_HEX, "hex"), {
    type: "bytes",
  });
  const g2GeneratorScVal = nativeToScVal(Buffer.from(G2_GENERATOR_HEX, "hex"), {
    type: "bytes",
  });
  const drandGenesisScVal = nativeToScVal(DRAND_GENESIS_TIME, {
    type: "u64",
  });
  const drandPeriodScVal = nativeToScVal(DRAND_PERIOD, {
    type: "u32",
  });
  const roundOffsetScVal = nativeToScVal(ROUND_OFFSET, {
    type: "u32",
  });

  const initTx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractAddress,
        function: "init",
        args: [
          oraclePKScVal,
          oracleAddrScVal,
          oracleEd25519ScVal,
          drandPkScVal,
          g2GeneratorScVal,
          drandGenesisScVal,
          drandPeriodScVal,
          roundOffsetScVal,
        ],
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
  console.log("  Contract initialized with oracle BLS PK, drand PK, and future round offset.");

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
      "PK match — proof.public_key must equal stored oracle BLS12-381 PK",
      "Ed25519 signature — proof data signed by oracle Ed25519 key, verified on-chain",
      "Alpha binding — alpha = sha256(context || round || sha256(drand_signature))",
      "On-chain BLS verification — drand + VRF pairing checks",
      "Future round enforcement — round_offset >= 1",
    ],
  };
  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\n  Deployment complete!`);
  console.log(`   Contract:  ${contractAddress}`);
  console.log(`   Explorer:  ${result.explorerUrl}`);
  console.log(`   Security:  require_auth + PK match + Ed25519 sig + alpha binding + BLS pairing checks`);
  console.log(`   Saved to:  ${OUT_PATH}`);
  return result;
}

main().catch((e) => {
  console.error("\nDeployment failed:", e.message || e);
  process.exit(1);
});
