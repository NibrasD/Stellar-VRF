import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_INDEX = path.resolve(
  __dirname,
  "../node_modules/@stellar/stellar-sdk/lib/index.js"
);
const stellar = await import(pathToFileURL(SDK_INDEX).href);
const { Keypair, Networks, TransactionBuilder, Operation, Address, nativeToScVal, rpc } = stellar.default || stellar;

const server = new rpc.Server("https://soroban-testnet.stellar.org", { allowHttp: false });

const dummyKP = Keypair.random();
await fetch(`https://friendbot.stellar.org?addr=${dummyKP.publicKey()}`);
await new Promise(r => setTimeout(r, 5000));

const account = await server.getAccount(dummyKP.publicKey());
const deployedPath = path.resolve(__dirname, "../soroban-contract/deployed.json");
const deployed = JSON.parse(readFileSync(deployedPath, "utf8"));

const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
  .addOperation(
    Operation.invokeContractFunction({
      contract: deployed.contractAddress,
      function: "request",
      args: [
        nativeToScVal(Buffer.from("measure_sim"), { type: "bytes" }),
        new Address(dummyKP.publicKey()).toScVal(),
      ],
    })
  )
  .setTimeout(30)
  .build();

const sim = await server.simulateTransaction(tx);
console.log(JSON.stringify(sim, null, 2));
