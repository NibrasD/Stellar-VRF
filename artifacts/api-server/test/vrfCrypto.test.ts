import { describe, it, expect, beforeAll } from 'vitest';

// Set a known test private key BEFORE importing the module so the module
// initialization does not throw when it requires `VRF_PRIVATE_KEY_HEX`.
beforeAll(() => {
  process.env.VRF_PRIVATE_KEY_HEX =
    'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721';
});

let vrf: typeof import('../src/lib/vrfCrypto');

beforeAll(async () => {
  vrf = await import('../src/lib/vrfCrypto');
});

describe('ECVRF generate/verify', () => {
  it('generateEcvrfProof produces a proof that verifies', async () => {
    const alpha = 'unit-test-alpha-seed';
    const proof = (vrf as any).generateEcvrfProof(alpha);
    // `generateEcvrfProof` may be async when VRF signer delegation is enabled;
    // ensure the returned value is resolved if it's a Promise.
    const resolvedProof = proof instanceof Promise ? await proof : proof;
    const res = (vrf as any).verifyEcvrfProof(
      {
        gammaPoint: resolvedProof.gammaPoint,
        challengeScalar: resolvedProof.challengeScalar,
        responseScalar: resolvedProof.responseScalar,
        publicKey: resolvedProof.publicKey,
        proofBytes: resolvedProof.proofBytes,
      },
      alpha
    );

    expect(res.valid).toBe(true);
    expect(resolvedProof.randomOutput).toBeDefined();
    expect(resolvedProof.randomOutput).toHaveLength(64);
  });

  it('tampered proof fails verification', async () => {
    const alpha = 'unit-test-alpha-seed-2';
    const proof = (vrf as any).generateEcvrfProof(alpha);
    const resolvedProof = proof instanceof Promise ? await proof : proof;
    // Tamper with the response scalar
    const tampered = { ...resolvedProof, responseScalar: 'f'.repeat(64) };
    const res = (vrf as any).verifyEcvrfProof(
      {
        gammaPoint: tampered.gammaPoint,
        challengeScalar: tampered.challengeScalar,
        responseScalar: tampered.responseScalar,
        publicKey: tampered.publicKey,
        proofBytes: tampered.proofBytes,
      },
      alpha
    );
    expect(res.valid).toBe(false);
  });

  it('proof verifies only against the same alpha seed', async () => {
    const alpha = 'alpha-original';
    const proof = await (vrf as any).generateEcvrfProof(alpha);
    const ok = (vrf as any).verifyEcvrfProof(
      {
        gammaPoint: proof.gammaPoint,
        challengeScalar: proof.challengeScalar,
        responseScalar: proof.responseScalar,
        publicKey: proof.publicKey,
        proofBytes: proof.proofBytes,
      },
      alpha
    );
    const mismatch = (vrf as any).verifyEcvrfProof(
      {
        gammaPoint: proof.gammaPoint,
        challengeScalar: proof.challengeScalar,
        responseScalar: proof.responseScalar,
        publicKey: proof.publicKey,
        proofBytes: proof.proofBytes,
      },
      'alpha-different'
    );
    expect(ok.valid).toBe(true);
    expect(mismatch.valid).toBe(false);
  });
});
