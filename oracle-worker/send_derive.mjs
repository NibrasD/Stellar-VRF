import { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";

async function main() {
  const server = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });
  const requesterKP = Keypair.fromSecret("***REDACTED_KEY***"); // Not saved, wait, I didn't save the KP in the script!
}
