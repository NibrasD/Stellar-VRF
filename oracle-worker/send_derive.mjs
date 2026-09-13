import { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";

async function main() {
  const server = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });
  const requesterSecret = process.env.REQUESTER_SECRET;
  if (!requesterSecret) { console.error("ERROR: REQUESTER_SECRET env var required"); process.exit(1); }
  const requesterKP = Keypair.fromSecret(requesterSecret); // Not saved, wait, I didn't save the KP in the script!
}
