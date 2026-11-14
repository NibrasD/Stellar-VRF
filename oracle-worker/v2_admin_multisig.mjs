/**
 * v2_admin_multisig.mjs — turn the V2 admin account into an M-of-N multisig.
 *
 *   NETWORK=testnet ADMIN_SECRET=S… SIGNERS=G…,G…,G… THRESHOLD=2 node v2_admin_multisig.mjs
 *   NETWORK=testnet ADMIN_PUBLIC=G… node v2_admin_multisig.mjs --check
 *
 * What it does (one classic SetOptions transaction, signed by the account's
 * current master key):
 *   - adds each address in SIGNERS as a signer with weight 1,
 *   - sets the low / medium / high thresholds to THRESHOLD,
 *   - sets the master key's weight to 0.
 *
 * After it, no single key controls the admin role: every governance call
 * (rotation, revocation, upgrade, admin transfer) needs THRESHOLD of the
 * signers. The master secret becomes useless and can be destroyed.
 *
 * Soroban's `require_auth` for a classic account uses the account's signers
 * and its MEDIUM threshold, so this is all the contract needs: the admin
 * address stays the same G… account.
 *
 * Generate the signer keys on separate devices (hardware wallets where
 * possible) and pass only their PUBLIC keys here. `--check` prints the
 * current signers and thresholds and exits non-zero unless the account is a
 * multisig with a dead master key.
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Keypair, Networks, Operation, TransactionBuilder, rpc, xdr, StrKey } from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NET = (process.env.NETWORK ?? "testnet").toLowerCase();
if (!["testnet", "mainnet"].includes(NET)) throw new Error("NETWORK must be testnet or mainnet");
dotenv.config({ path: path.resolve(__dirname, NET === "mainnet" ? ".env" : ".env.testnet") });
const RPC = NET === "mainnet" ? process.env.SOROBAN_RPC_URL || "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org";
const PASSPHRASE = NET === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const server = new rpc.Server(RPC);

/** Signers and thresholds of a classic account, read from its ledger entry. */
export async function readAccountAuth(srv, publicKey) {
  const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(publicKey).xdrAccountId() }));
  const res = await srv.getLedgerEntries(key);
  if (!res.entries.length) throw new Error(`account ${publicKey} not found`);
  const acct = res.entries[0].val.account;
  // stellar-sdk v17: `thresholds` wraps the 4 bytes [master weight, low, medium, high].
  const t = Buffer.from(acct.thresholds.value ?? acct.thresholds);
  return {
    masterWeight: t[0],
    low: t[1],
    medium: t[2],
    high: t[3],
    signers: (acct.signers ?? []).map((s) => ({
      // stellar-sdk v17 serializes a signer key to its strkey form.
      key: String(JSON.parse(JSON.stringify(s.key))),
      weight: s.weight,
    })),
  };
}

/** Problems that make an admin account unsafe (empty = a proper multisig). */
export function multisigProblems(auth) {
  const problems = [];
  if (auth.masterWeight !== 0) problems.push(`master key still has weight ${auth.masterWeight}`);
  if (auth.signers.length < 2) problems.push(`only ${auth.signers.length} additional signer(s)`);
  if (auth.medium < 2) problems.push(`medium threshold is ${auth.medium} (one signature is enough)`);
  const total = auth.signers.reduce((n, s) => n + s.weight, 0);
  if (total < auth.medium || total < auth.high) problems.push("signer weights cannot reach the thresholds (account is locked)");
  if (auth.signers.some((s) => s.weight >= auth.medium && auth.medium > 0)) problems.push("a single signer can reach the medium threshold alone");
  return problems;
}

async function main() {
  if (process.argv.includes("--check")) {
    const pub = process.env.ADMIN_PUBLIC;
    if (!pub) throw new Error("ADMIN_PUBLIC is required for --check");
    const auth = await readAccountAuth(server, pub);
    console.log(JSON.stringify(auth, null, 2));
    const problems = multisigProblems(auth);
    if (problems.length) {
      console.error("NOT a safe admin account:\n  - " + problems.join("\n  - "));
      process.exit(2);
    }
    console.log(`OK: ${auth.medium}-of-${auth.signers.length} multisig, master key disabled.`);
    return;
  }

  const master = Keypair.fromSecret(process.env.ADMIN_SECRET ?? "");
  const signers = (process.env.SIGNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = Number(process.env.THRESHOLD ?? "2");
  if (signers.length < 2) throw new Error("SIGNERS needs at least 2 public keys");
  if (new Set(signers).size !== signers.length) throw new Error("SIGNERS contains a duplicate");
  if (signers.includes(master.publicKey())) throw new Error("SIGNERS must not contain the admin account's own key");
  for (const s of signers) if (!StrKey.isValidEd25519PublicKey(s)) throw new Error(`not a public key: ${s}`);
  if (!(threshold >= 2 && threshold <= signers.length)) throw new Error("THRESHOLD must be between 2 and the number of signers");

  const account = await server.getAccount(master.publicKey());
  const b = new TransactionBuilder(account, { fee: "100000", networkPassphrase: PASSPHRASE });
  for (const s of signers) b.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: s, weight: 1 } }));
  // Last, so the master key still authorizes this whole transaction.
  b.addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: threshold, medThreshold: threshold, highThreshold: threshold }));
  const tx = b.setTimeout(120).build();
  tx.sign(master);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error("send error " + JSON.stringify(sent.errorResult));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === "SUCCESS") break;
    if (res.status === "FAILED") throw new Error(`transaction ${sent.hash} failed`);
  }
  console.log(`setOptions: ${sent.hash}`);
  const auth = await readAccountAuth(server, master.publicKey());
  console.log(JSON.stringify(auth, null, 2));
  const problems = multisigProblems(auth);
  if (problems.length) throw new Error("account is not a safe multisig: " + problems.join("; "));
  console.log(`Admin ${master.publicKey()} is now a ${threshold}-of-${signers.length} multisig; its master key is disabled.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("ERROR: " + (e instanceof Error ? e.message : e)); process.exit(1); });
}
