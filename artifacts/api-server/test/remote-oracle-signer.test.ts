import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import createVrfSignerApp from '../src/lib/vrfSigner.js';
import { attachRemoteSignature } from '../src/lib/sorobanSubmit.js';
import keyManager from '../src/lib/keyManager.js';
import { Keypair, Account, TransactionBuilder, Operation, Networks, Asset } from '@stellar/stellar-sdk';

let server: any;
let url: string;

beforeAll(async () => {
  // Provide a deterministic oracle seed for the signer PoC
  process.env.ORACLE_STELLAR_SEED = Keypair.random().secret();
  const app = createVrfSignerApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      // @ts-ignore
      const addr = server.address();
      const port = addr.port;
      url = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  process.env.ORACLE_SIGNER_URL = url;
});

afterAll(async () => {
  if (server && server.close) await new Promise((r) => server.close(r));
  delete process.env.ORACLE_SIGNER_URL;
  delete process.env.ORACLE_STELLAR_SEED;
});

describe('remote oracle signer (PoC)', () => {
  it('delegates transaction signing to remote oracle signer', async () => {
    process.env.KMS_PROVIDER = 'mock';
    await keyManager.init();

    const oraclePub = await keyManager.getOraclePublicKey();
    const kp = keyManager.getLocalOracleKeypair();
    expect(kp).toBeDefined();

    const account = new Account(oraclePub, '1');
    const dest = Keypair.random().publicKey();
    const tx = new TransactionBuilder(account, { fee: '100000', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();

    await attachRemoteSignature(tx);

    expect(Array.isArray(tx.signatures)).toBe(true);
    expect(tx.signatures.length).toBeGreaterThan(0);
  });
});
