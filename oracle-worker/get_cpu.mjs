import { rpc } from "@stellar/stellar-sdk";

async function main() {
  const server = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });
  const txHash = "035949d12677141c05b9ca7402d68443c2ab55646f40503e2c87fcd3091584ea";
  const status = await server.getTransaction(txHash);
  
  if (status.status === "SUCCESS") {
    // The instructions are found inside the diagnostic events in the meta,
    // or inside the resource fee charged extension.
    // Let's just JSON.stringify the whole thing and search for "cpu" or "instructions"
    const jsonStr = JSON.stringify(status, (key, val) => 
      typeof val === 'bigint' ? val.toString() : val
    );
    console.log(jsonStr.substring(0, 500));
  }
}
main().catch(console.error);
