/**
 * v2_deploy.mjs — deploy the V2 VRF contract (Testnet or Mainnet).
 *
 *   NETWORK=testnet node v2_deploy.mjs      # reads .env.testnet
 *   NETWORK=mainnet node v2_deploy.mjs      # reads .env
 *
 * Environment:
 *   ADMIN_PUBLIC            admin account (G…), cold key / multisig. Required.
 *   ADMIN_SECRETS           comma-separated signer secrets of ADMIN_PUBLIC.
 *                           Leave unset to print the deploy transaction XDR
 *                           for external signing (recommended on Mainnet).
 *   ORACLE_STELLAR_SECRET   operator account (hot key). Uploads the WASM and
 *                           signs its own constructor authorization.
 *   ORACLE_BLS_SECRET_KEY   operator BLS secret (hex) for epoch 1.
 *   FEE_STROOPS             per-request fee in native XLM (default 2000000).
 *   ROUND_OFFSET            default 4 (contract minimum).
 *   ROTATION_TIMELOCK_LEDGERS / UPGRADE_TIMELOCK_LEDGERS
 *                           defaults 2880 (~4 h) / 8640 (~12 h), the minimums.
 *   WASM_PATH               default ../soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.wasm
 *
 * The constructor requires the admin AND the operator to authorize, and
 * refuses admin == operator.
 */
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Address, Keypair, Networks, Operation, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { blsPublicKey, newBuilder, simulateSignSubmit } from "./v2_lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NET = (process.env.NETWORK ?? "testnet").toLowerCase();
if (!["testnet", "mainnet"].includes(NET)) throw new Error("NETWORK must be testnet or mainnet");
dotenv.config({ path: path.resolve(__dirname, NET === "mainnet" ? ".env" : ".env.testnet") });

const CFG = {
  testnet: {
    rpc: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET,
    xlmSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  },
  mainnet: {
    rpc: process.env.SOROBAN_RPC_URL || "https://mainnet.sorobanrpc.com",
    passphrase: Networks.PUBLIC,
    xlmSac: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  },
}[NET];

// drand quicknet: genesis, period and the group key (uncompressed G2). Fixed
// for the life of the contract.
const DRAND_GENESIS = 1692803367n;
const DRAND_PERIOD = 3;
const DRAND_PK =
  "03cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a01a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b0e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273";

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const ADMIN = need("ADMIN_PUBLIC");
const OPERATOR = Keypair.fromSecret(need("ORACLE_STELLAR_SECRET"));
if (ADMIN === OPERATOR.publicKey()) throw new Error("ADMIN_PUBLIC must differ from the operator account");
const ORACLE_BLS_PK = blsPublicKey(need("ORACLE_BLS_SECRET_KEY"));
const FEE = BigInt(process.env.FEE_STROOPS ?? "2000000");
const OFFSET = Number(process.env.ROUND_OFFSET ?? "4");
const ROT_TL = Number(process.env.ROTATION_TIMELOCK_LEDGERS ?? "2880");
const UPG_TL = Number(process.env.UPGRADE_TIMELOCK_LEDGERS ?? "8640");
const WASM_PATH =
  process.env.WASM_PATH ??
  path.resolve(__dirname, "../soroban-contract/target/wasm32v1-none/release/soroban_vrf_oracle.wasm");

const server = new rpc.Server(CFG.rpc);
const wasm = fs.readFileSync(WASM_PATH);
const wasmHash = crypto.createHash("sha256").update(wasm).digest();

console.log(`\n=== Stellar VRF V2 deployment (${NET}) ===`);
console.log(`  Admin     : ${ADMIN}`);
console.log(`  Operator  : ${OPERATOR.publicKey()}`);
console.log(`  BLS pk    : ${ORACLE_BLS_PK.toString("hex").slice(0, 32)}…`);
console.log(`  Fee       : ${FEE} stroops (native XLM SAC ${CFG.xlmSac})`);
console.log(`  Offset    : ${OFFSET} rounds; timelocks rotation ${ROT_TL} / upgrade ${UPG_TL} ledgers`);
console.log(`  WASM      : ${WASM_PATH}`);
console.log(`  WASM hash : ${wasmHash.toString("hex")}  (compare with the CI build)`);

// 1. Upload the WASM (any account may; the operator pays).
{
  const acct = await server.getAccount(OPERATOR.publicKey());
  const tx = newBuilder(acct, CFG.passphrase).addOperation(Operation.uploadContractWasm({ wasm })).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`upload simulation: ${sim.error}`);
  } else {
    const prep = rpc.assembleTransaction(tx, sim).build();
    prep.sign(OPERATOR);
    const sent = await server.sendTransaction(prep);
    if (sent.status === "ERROR") throw new Error(`upload send: ${JSON.stringify(sent.errorResult)}`);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) break;
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`upload ${sent.hash} failed`);
    }
    console.log(`  Uploaded: ${sent.hash}`);
  }
}

// 2. Create the instance; the constructor runs atomically.
const salt = crypto.randomBytes(32);
const constructorArgs = [
  new Address(ADMIN).toScVal(),
  nativeToScVal(ORACLE_BLS_PK, { type: "bytes" }),
  new Address(OPERATOR.publicKey()).toScVal(),
  nativeToScVal(Buffer.from(DRAND_PK, "hex"), { type: "bytes" }),
  nativeToScVal(DRAND_GENESIS, { type: "u64" }),
  nativeToScVal(DRAND_PERIOD, { type: "u32" }),
  nativeToScVal(OFFSET, { type: "u32" }),
  new Address(CFG.xlmSac).toScVal(),
  nativeToScVal(FEE, { type: "i128" }),
  nativeToScVal(ROT_TL, { type: "u32" }),
  nativeToScVal(UPG_TL, { type: "u32" }),
];
const adminAccount = await server.getAccount(ADMIN);
const build = (auth) =>
  newBuilder(adminAccount, CFG.passphrase)
    .addOperation(
      Operation.createCustomContract({
        address: new Address(ADMIN),
        wasmHash,
        salt,
        constructorArgs,
        ...(auth ? { auth } : {}),
      })
    )
    .build();

const out = await simulateSignSubmit(
  server,
  CFG.passphrase,
  build,
  new Map([[OPERATOR.publicKey(), OPERATOR]]),
  { label: "deploy" }
);
if (out) {
  const ret = out.result.returnValue;
  const contractId = ret ? Address.fromScVal(ret).toString() : "(see transaction)";
  const record = {
    network: NET,
    contractAddress: contractId,
    wasmHash: wasmHash.toString("hex"),
    admin: ADMIN,
    operator: OPERATOR.publicKey(),
    oracleBlsPk: ORACLE_BLS_PK.toString("hex"),
    feeStroops: FEE.toString(),
    roundOffset: OFFSET,
    rotationTimelockLedgers: ROT_TL,
    upgradeTimelockLedgers: UPG_TL,
    deployTxHash: out.hash,
    deployedAt: new Date().toISOString(),
  };
  const file = path.resolve(__dirname, `deployed.v2.${NET}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`\n  Contract  : ${contractId}`);
  console.log(`  Saved     : ${file}`);
  console.log("  Active key epoch: 1");
}
