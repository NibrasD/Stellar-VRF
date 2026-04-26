import { describe, it, expect } from "vitest";
import keyManager from "../src/lib/keyManager.js";
import { attachRemoteSignature } from "../src/lib/sorobanSubmit.js";
import { Keypair, Account, TransactionBuilder, Operation, Networks, Asset } from "@stellar/stellar-sdk";

describe("remote signing (mock provider)", () => {
  it("attaches a remote signature to a prepared Transaction", async () => {
    process.env.KMS_PROVIDER = "mock";
    // Provide a deterministic seed if desired; otherwise the mock will generate one
    process.env.MOCK_ORACLE_STELLAR_SEED = Keypair.random().secret();
    await keyManager.init();

    const oraclePub = await keyManager.getOraclePublicKey();
    const kp = keyManager.getLocalOracleKeypair();
    expect(kp).toBeDefined();

    const account = new Account(oraclePub, "1");
    const dest = Keypair.random().publicKey();
    const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount: "1" }))
      .setTimeout(30)
      .build();

    await attachRemoteSignature(tx);

    // The prepared transaction should now include at least one signature
    expect(Array.isArray(tx.signatures)).toBe(true);
    expect(tx.signatures.length).toBeGreaterThan(0);
  });
});
