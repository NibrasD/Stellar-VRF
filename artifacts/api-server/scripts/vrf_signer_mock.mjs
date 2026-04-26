#!/usr/bin/env node
import express from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

const port = process.env.VRF_SIGNER_PORT ? Number(process.env.VRF_SIGNER_PORT) : 6060;

app.post('/generateProof', async (req, res) => {
  try {
    const { alphaSeed, externalEntropyHex } = req.body || {};
    if (!alphaSeed) return res.status(400).json({ error: 'alphaSeed is required' });
    const vrf = await import('../src/lib/vrfCrypto.js');
    const proof = await vrf.generateEcvrfProof(alphaSeed, externalEntropyHex ? { externalEntropyHex } : undefined);
    res.json(proof);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`VRF signer mock listening on http://localhost:${port}`);
});
