import { it } from 'vitest';
import fc from 'fast-check';

it('fuzz: malformed proof bytes should not crash verify (skipped if no VRF key)', async () => {
  if (!process.env.VRF_PRIVATE_KEY_HEX) {
    console.warn('Skipping fuzz test: VRF_PRIVATE_KEY_HEX not set');
    return;
  }

  const vrf = await import('../src/lib/vrfCrypto');

  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 512 }), async (bytes) => {
      try {
        // ensure verifyEcvrfProof handles arbitrary garbage without throwing
        const res = vrf.verifyEcvrfProof(
          {
            gammaPoint: Buffer.from(bytes).toString('hex'),
            challengeScalar: Buffer.from(bytes).toString('hex').slice(0, 32),
            responseScalar: Buffer.from(bytes).toString('hex').slice(0, 64),
            publicKey: Buffer.from(bytes).toString('hex').slice(0, 66),
            proofBytes: Buffer.from(bytes).toString('hex'),
          },
          'fuzz-seed'
        );
        // verify should return an object or falsey but should not throw
        return typeof res === 'object' || res === false || res === null;
      } catch (e) {
        return false;
      }
    }),
    { numRuns: 200 }
  );
}, 60_000);
