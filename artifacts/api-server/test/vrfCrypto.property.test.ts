import { it, expect } from 'vitest';
import fc from 'fast-check';

// Property-based round-trip test for VRF generate/verify.
it('property: generate/verify roundtrip for random alpha seeds (skipped if no VRF key)', async () => {
  if (!process.env.VRF_PRIVATE_KEY_HEX) {
    // Skip property test when no VRF key is configured (CI can enable via secrets)
    console.warn('Skipping property test: VRF_PRIVATE_KEY_HEX not set');
    return;
  }

  const vrf = await import('../src/lib/vrfCrypto');

  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 256 }), async (alpha) => {
      // generate proof and verify
      const proof = await vrf.generateEcvrfProof(alpha);
      const verify = vrf.verifyEcvrfProof(
        {
          gammaPoint: proof.gammaPoint,
          challengeScalar: proof.challengeScalar,
          responseScalar: proof.responseScalar,
          publicKey: proof.publicKey,
          proofBytes: proof.proofBytes,
        },
        alpha
      );
      return verify.valid === true;
    }),
    { numRuns: 100 }
  );
}, 60_000);
