/**
 * mainnet_init.mjs — Initialize contract CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU on Stellar Mainnet
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs";
import dotenv from "dotenv";

// HISTORICAL: this one-off script already initialised CBTCC5QL…. It uses
// fee_amount = 0 and a hard-coded oracle BLS key, which is exactly what
// mainnet_deploy.mjs now refuses to do. Use mainnet_deploy.mjs.
if (process.env.I_KNOW_THIS_IS_A_HISTORICAL_SCRIPT !== "yes") {
  console.error("Refusing to run: historical script (fee_amount = 0, hard-coded BLS key). Use mainnet_deploy.mjs.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env") });

const SDK_INDEX = path.resolve(__dirname, "node_modules/@stellar/stellar-sdk/lib/esm/index.js");
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc, xdr } =
  stellar.default || stellar;

const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const server = new rpc.Server(MAINNET_RPC, { allowHttp: false });

const sec = process.env.ORACLE_STELLAR_SECRET;
const kp = Keypair.fromSecret(sec);
const acct = await server.getAccount(kp.publicKey());

const contractId = "CBTCC5QL5T3JSLEZO4PH6LSJYEQF6GEFDCAO67OXI4DTM5NXMK6TSUHU";
const uploadTxHash = "0b555662fcdf5083237b7ab337583cb9d8c8124deb4c1220a385745299702222";
const deployTxHash = "348f0fde4ac4954f4ebed808b1bba9dbdbf2137cbb29156f69188fc69fad3af1";
const wasmHash = "90ad849914b6c5ead39e7e4847af36f680f54f683675dc108ed1a0e90f18f84f";

const ORACLE_BLS_PK = "0eb7e2ddf281bd96d81988e1ed0318c7d481f479048af7ab038557508c6a0468ec174a227e93deed4aa9d48f22e00754164ac02fa3937a68d4162d015958139418853e4705c843305686d8017c7d5a8cc61579973f9ddc5b5d1d58307ec555660f71eb42297319aa7e2b8b45ad45fba933dd5e9b2453f80755b375f26f9a87c5ef3f8e11c6711103789d9cc44641e1110038272b39aafb997f3eb07ef494360efeb34f4e1c2bdd937636bacb5d019aaee6ff75f4c16b3bd2814e1311f6c3383d";
const DRAND_PK = "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";
const G2_GEN = "13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

const ed25519Bytes = Buffer.from(kp.rawPublicKey());

function bytesVal(hexOrBuf) {
  const buf = Buffer.isBuffer(hexOrBuf) ? hexOrBuf : Buffer.from(hexOrBuf, "hex");
  return nativeToScVal(buf, { type: "bytes" });
}
function u64Val(n) { return xdr.ScVal.scvU64(BigInt(n)); }
function u32Val(n) { return xdr.ScVal.scvU32(Number(n)); }
function i128Val(n) { return nativeToScVal(n, { type: "i128" }); }

async function pollTx(hash) {
  process.stdout.write("  Confirming init TX");
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
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

const args = [
  bytesVal(ORACLE_BLS_PK),
  new Address(kp.publicKey()).toScVal(),
  bytesVal(ed25519Bytes),
  bytesVal(DRAND_PK),
  bytesVal(G2_GEN),
  u64Val(1692803367n),
  u32Val(3),
  u32Val(2),
  new Address(XLM_SAC).toScVal(),
  i128Val(0n),
];

console.log("\n=== Initializing Contract on Stellar Mainnet ===");
console.log(`Contract: ${contractId}`);
console.log(`Oracle:   ${kp.publicKey()}`);

const tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: Networks.PUBLIC })
  .addOperation(Operation.invokeContractFunction({ contract: contractId, function: "init", args: args }))
  .setTimeout(300)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);
}

const prepared = rpc.assembleTransaction(tx, sim).build();
prepared.sign(kp);

const sent = await server.sendTransaction(prepared);
if (sent.status === "ERROR") {
  throw new Error(`Send failed: ${JSON.stringify(sent.errorResult)}`);
}

console.log(`TX submitted: https://stellar.expert/explorer/public/tx/${sent.hash}`);
await pollTx(sent.hash);
console.log("Contract initialized successfully! ✔");

const deployedRecord = {
  contractAddress: contractId,
  wasmHash: wasmHash,
  deployerPublicKey: kp.publicKey(),
  oraclePublicKeyHex: ORACLE_BLS_PK,
  oracleStellarAddress: kp.publicKey(),
  oracleEd25519Hex: ed25519Bytes.toString("hex"),
  network: "mainnet",
  sorobanRpcUrl: MAINNET_RPC,
  deployedAt: new Date().toISOString(),
  explorerUrl: `https://stellar.expert/explorer/public/contract/${contractId}`,
  uploadTxHash: uploadTxHash,
  deployTxHash: deployTxHash,
  initTxHash: sent.hash,
  securityFeatures: [
    "require_auth() — only oracle address can call fulfill()",
    "requester == callback_contract — prevents confused-deputy callback attacks",
    "MAX_CONTEXT_LEN = 1024 cap on user context",
    "PK match — proof.public_key must equal stored oracle BLS12-381 PK",
    "Ed25519 signature — proof data signed by oracle Ed25519 key, verified on-chain",
    "Alpha binding — alpha = sha256(context || round || sha256(drand_signature))",
    "On-chain BLS verification — drand + VRF pairing checks",
    "Future round enforcement — round_offset >= 2"
  ]
};

fs.writeFileSync(
  path.resolve(__dirname, "../soroban-contract/deployed.json"),
  JSON.stringify(deployedRecord, null, 2),
  "utf8"
);
fs.writeFileSync(
  path.resolve(__dirname, "deployed.mainnet.json"),
  JSON.stringify(deployedRecord, null, 2),
  "utf8"
);

console.log("\n╔═══════════════════════════════════════════════════════════╗");
console.log("║           MAINNET DEPLOYMENT COMPLETE ✅                  ║");
console.log("╠═══════════════════════════════════════════════════════════╣");
console.log(`║ Contract:  ${contractId}`);
console.log(`║ Oracle:    ${kp.publicKey()}`);
console.log(`║ Upload TX: https://stellar.expert/explorer/public/tx/${uploadTxHash}`);
console.log(`║ Deploy TX: https://stellar.expert/explorer/public/tx/${deployTxHash}`);
console.log(`║ Init TX:   https://stellar.expert/explorer/public/tx/${sent.hash}`);
console.log(`║ Explorer:  https://stellar.expert/explorer/public/contract/${contractId}`);
console.log("╚═══════════════════════════════════════════════════════════╝\n");
