/**
 * v2_rotate.mjs — V2 governance: key rotation and epoch revocation.
 *
 *   NETWORK=testnet node v2_rotate.mjs status
 *   NETWORK=testnet node v2_rotate.mjs propose     # needs NEW_ORACLE_* (below)
 *   NETWORK=testnet node v2_rotate.mjs execute     # after the timelock
 *   NETWORK=testnet node v2_rotate.mjs cancel
 *   NETWORK=testnet node v2_rotate.mjs revoke <epoch_id>
 *
 * Environment: CONTRACT_ADDRESS, ADMIN_PUBLIC, ADMIN_SECRETS (optional, see
 * v2_lib.mjs), and for `propose`:
 *   NEW_ORACLE_STELLAR_SECRET   new operator account (signs its own auth)
 *   NEW_ORACLE_BLS_SECRET_KEY   new BLS secret (hex); omit to generate one
 *
 * Rotation hand-over for the worker: before `execute`, restart the worker with
 * the NEW keys as ORACLE_STELLAR_SECRET / ORACLE_BLS_SECRET_KEY and the OLD
 * keys as ORACLE_PREVIOUS_STELLAR_SECRET / ORACLE_PREVIOUS_BLS_SECRET_KEY.
 * It then serves both epochs. Remove the previous keys once the old epoch has
 * no pending requests (at most EXPIRY_ROUNDS, 24 h, after `execute`).
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Account, Address, Keypair, Networks, Operation, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { blsPublicKey, newBuilder, popSignature, randomBlsSecret, simulateSignSubmit } from "./v2_lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NET = (process.env.NETWORK ?? "testnet").toLowerCase();
dotenv.config({ path: path.resolve(__dirname, NET === "mainnet" ? ".env" : ".env.testnet") });
const RPC = NET === "mainnet" ? process.env.SOROBAN_RPC_URL || "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org";
const PASSPHRASE = NET === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const server = new rpc.Server(RPC);

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const CONTRACT = need("CONTRACT_ADDRESS");
const ADMIN = need("ADMIN_PUBLIC");

async function instance() {
  const e = await server.getContractData(CONTRACT, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
  const out = {};
  // stellar-sdk v17 XDR objects are plain data (same access as listener.ts).
  for (const item of e.val.contractData.val.instance.storage ?? []) {
    const k = scValToNative(item.key);
    if (Array.isArray(k) && k.length === 1) out[k[0]] = scValToNative(item.val);
  }
  return out;
}

async function adminCall(fn, args, authKeys = new Map()) {
  const seq = (await server.getAccount(ADMIN)).sequenceNumber();
  // build() increments the Account's sequence; start every build from the same one.
  const build = (auth) =>
    newBuilder(new Account(ADMIN, seq), PASSPHRASE)
      .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: fn, args, ...(auth ? { auth } : {}) }))
      .build();
  const out = await simulateSignSubmit(server, PASSPHRASE, build, authKeys, { label: fn });
  if (out) console.log(`${fn}: ${out.hash}`);
}

const [cmd, arg] = process.argv.slice(2);
const admin = new Address(ADMIN).toScVal();

if (cmd === "status") {
  const inst = await instance();
  console.log({
    activeEpochId: inst.ActiveEpochId,
    epochCounter: inst.EpochCounter,
    pendingRotation: inst.PendingRot ?? null,
    pendingUpgrade: inst.PendingUpg ?? null,
    admin: inst.Admin,
  });
} else if (cmd === "propose") {
  const inst = await instance();
  const newEpochId = Number(inst.EpochCounter) + 1;
  let blsSecret = process.env.NEW_ORACLE_BLS_SECRET_KEY;
  if (!blsSecret) {
    blsSecret = randomBlsSecret();
    console.log(`Generated NEW_ORACLE_BLS_SECRET_KEY=${blsSecret}\n(store it in the secret store now; it is not saved anywhere)`);
  }
  const op = Keypair.fromSecret(need("NEW_ORACLE_STELLAR_SECRET"));
  if (op.publicKey() === ADMIN) throw new Error("new operator must differ from the admin");
  const pk = blsPublicKey(blsSecret);
  const pop = popSignature(CONTRACT, newEpochId, blsSecret);
  console.log(`Proposing epoch ${newEpochId}: operator ${op.publicKey()}, BLS pk ${pk.toString("hex").slice(0, 32)}…`);
  await adminCall(
    "propose_key_rotation",
    [admin, nativeToScVal(pk, { type: "bytes" }), new Address(op.publicKey()).toScVal(), nativeToScVal(pop, { type: "bytes" })],
    new Map([[op.publicKey(), op]])
  );
} else if (cmd === "execute") {
  await adminCall("execute_key_rotation", [admin]);
} else if (cmd === "cancel") {
  await adminCall("cancel_key_rotation", [admin]);
} else if (cmd === "revoke") {
  if (!arg) throw new Error("usage: revoke <epoch_id>");
  await adminCall("revoke_epoch", [admin, nativeToScVal(Number(arg), { type: "u32" })]);
} else {
  console.log("usage: node v2_rotate.mjs status|propose|execute|cancel|revoke <epoch_id>");
  process.exit(1);
}
