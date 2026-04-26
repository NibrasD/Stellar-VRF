import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as drand from '../src/lib/drand.js';
import * as vrf from '../src/lib/vrfCrypto.js';

describe('drand mixing', () => {
  beforeEach(() => {
    process.env.KMS_PROVIDER = '';
    process.env.VRF_PRIVATE_KEY_HEX = 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721';
  });

  it('mixing external entropy changes VRF output', async () => {
    vi.spyOn(drand, 'getDrandLatest').mockResolvedValue({ randomness: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    const base = await vrf.generateEcvrfProof('alpha-seed');
    const mixed = await vrf.generateEcvrfProof('alpha-seed', { externalEntropyHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(base.randomOutput).not.toEqual(mixed.randomOutput);
  });

  it('rejects malformed drand beacon signature payload', async () => {
    const valid = {
      round: 1,
      randomness: 'a'.repeat(64),
      signature: 'b'.repeat(192),
    } as any;

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ public_key: 'c'.repeat(96) }),
      } as any);

    await expect(drand.verifyDrandBeacon(valid, 'quicknet')).rejects.toBeTruthy();
  });
});
