import { describe, it, expect, beforeEach } from 'vitest';
import keyManager from '../src/lib/keyManager.js';
import { Keypair } from '@stellar/stellar-sdk';

describe('keyManager (env provider)', () => {
  beforeEach(() => {
    process.env.KMS_PROVIDER = '';
  });

  it('signProofMessage should produce a 64-byte Ed25519 signature when ORACLE_STELLAR_SEED is set', async () => {
    const kp = Keypair.random();
    process.env.ORACLE_STELLAR_SEED = kp.secret();

    const msg = Buffer.from('test-message');
    const sig = await keyManager.signProofMessage(msg);
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
  });
});
