import { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";

async function main() {
  const server = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });
  const requesterKP = Keypair.fromSecret("SDV7G54M3F4K65Y2U663363ZZ3DUR7X7KNYH6L7U5L5E6TY2N5S4L2C6"); // Not saved, wait, I didn't save the KP in the script!
}
