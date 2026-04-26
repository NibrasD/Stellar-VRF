import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';

let server: any;
let url: string;

beforeAll(async () => {
  process.env.VRF_PRIVATE_KEY_HEX = 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721';
  const app = express();
  app.use(express.json());
  app.post('/generateProof', async (req, res) => {
    try {
      const { alphaSeed, externalEntropyHex } = req.body || {};
      if (!alphaSeed) {
        res.status(400).json({ error: 'alphaSeed is required' });
        return;
      }
      const vrf = await import('../src/lib/vrfCrypto.js');
      // Prevent recursion: temporarily disable delegation while signer endpoint computes proof.
      const prevSigner = process.env.VRF_SIGNER_URL;
      delete process.env.VRF_SIGNER_URL;
      try {
        const proof = await vrf.generateEcvrfProof(alphaSeed, externalEntropyHex ? { externalEntropyHex } : undefined);
        res.json(proof);
      } finally {
        if (prevSigner !== undefined) process.env.VRF_SIGNER_URL = prevSigner;
      }
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      // @ts-ignore
      const addr = server.address();
      const port = addr.port;
      url = `http://127.0.0.1:${port}/generateProof`;
      resolve();
    });
  });

  process.env.VRF_SIGNER_URL = url;
});

afterAll(async () => {
  if (server && server.close) await new Promise((r) => server.close(r));
  delete process.env.VRF_SIGNER_URL;
});

describe('VRF remote signer PoC', () => {
  it('delegates proof generation to an external signer URL', async () => {
    const vrf = await import('../src/lib/vrfCrypto.js');
    const alpha = 'poctest:' + Date.now();
    const proof = await vrf.generateEcvrfProof(alpha);
    expect(proof).toBeTruthy();
    expect(proof.gammaPoint).toBeTruthy();
    expect(proof.randomOutput).toHaveLength(64);
  }, 15000);
});
