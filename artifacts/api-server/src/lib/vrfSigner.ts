import express from 'express';
import keyManager from './keyManager.js';
import * as vrf from './vrfCrypto.js';

export function createVrfSignerApp() {
  const app = express();
  app.use(express.json());

  // Authentication middleware: support optional API key and optional client-cert enforcement.
  app.use((req, res, next) => {
    // Client certificate enforcement (set VRF_SIGNER_REQUIRE_CLIENT_CERT=1 to enable)
    if (process.env.VRF_SIGNER_REQUIRE_CLIENT_CERT === '1') {
      // `req.socket.authorized` will be true when the TLS layer accepted the client cert
      // (requires the server to be started with `requestCert: true` and appropriate CA).
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      if (!req.socket || !req.socket.authorized) {
        res.status(401).json({ error: 'Client certificate required' });
        return;
      }
    }

    // API key enforcement (set VRF_SIGNER_REQUIRE_API_KEY=1 or provide VRF_SIGNER_API_KEY)
    const requireApiKey = process.env.VRF_SIGNER_REQUIRE_API_KEY === '1' || !!process.env.VRF_SIGNER_API_KEY;
    if (requireApiKey) {
      const headerKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : undefined;
      const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
      const provided = headerKey || bearer;
      if (!provided || provided !== process.env.VRF_SIGNER_API_KEY) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }
    }

    next();
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/generateProof', async (req, res): Promise<void> => {
    const { alphaSeed, externalEntropyHex } = req.body || {};
    if (!alphaSeed) {
      res.status(400).json({ error: 'alphaSeed is required' });
      return;
    }
    try {
      // Ensure any configured key manager (Secrets Manager, KMS) is initialized
      if (keyManager.init) await keyManager.init();

      // Prevent delegation recursion: temporarily unset VRF_SIGNER_URL
      const prevSigner = process.env.VRF_SIGNER_URL;
      delete process.env.VRF_SIGNER_URL;
      try {
        const proof = await vrf.generateEcvrfProof(alphaSeed, externalEntropyHex ? { externalEntropyHex } : undefined);
        res.json(proof);
      } finally {
        if (prevSigner !== undefined) process.env.VRF_SIGNER_URL = prevSigner;
      }
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/publicKey', async (_req, res): Promise<void> => {
    try {
      if (keyManager.init) await keyManager.init();
      // Prefer a KMS-backed public-key retrieval when available to avoid exposing
      // private key material in process memory or Secrets Manager.
      if (typeof (keyManager as any).getVrfPublicKeyAsync === 'function') {
        try {
          const pk = await (keyManager as any).getVrfPublicKeyAsync();
          res.json({ publicKey: pk, source: process.env.KMS_PROVIDER || 'env' });
          return;
        } catch (err) {
          // fallback to local computation below
        }
      }

      // Fallback: compute public key via local VRF code
      const pk = await vrf.getVrfPublicKey();
      res.json({ publicKey: pk, source: 'local' });
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/oraclePublicKey', async (_req, res): Promise<void> => {
    try {
      if (keyManager.init) await keyManager.init();
      // Prevent delegation recursion
      const prev = process.env.ORACLE_SIGNER_URL;
      delete process.env.ORACLE_SIGNER_URL;
      try {
        const pk = await keyManager.getOraclePublicKey();
        res.json({ publicKey: pk, source: process.env.KMS_PROVIDER || 'local' });
      } finally {
        if (prev !== undefined) process.env.ORACLE_SIGNER_URL = prev;
      }
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/signProof', async (req, res): Promise<void> => {
    const { messageHex } = req.body || {};
    if (!messageHex) {
      res.status(400).json({ error: 'messageHex is required' });
      return;
    }
    try {
      if (keyManager.init) await keyManager.init();
      const prev = process.env.ORACLE_SIGNER_URL;
      delete process.env.ORACLE_SIGNER_URL;
      try {
        const buf = Buffer.from(messageHex, 'hex');
        const sig = await keyManager.signProofMessage(buf);
        res.json({ signature: sig.toString('hex') });
      } finally {
        if (prev !== undefined) process.env.ORACLE_SIGNER_URL = prev;
      }
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/signTx', async (req, res): Promise<void> => {
    const { messageHex } = req.body || {};
    if (!messageHex) {
      res.status(400).json({ error: 'messageHex is required' });
      return;
    }
    try {
      if (keyManager.init) await keyManager.init();
      const prev = process.env.ORACLE_SIGNER_URL;
      delete process.env.ORACLE_SIGNER_URL;
      try {
        const buf = Buffer.from(messageHex, 'hex');
        const sig = await keyManager.signTransactionHash(buf);
        res.json({ signature: sig.toString('hex') });
      } finally {
        if (prev !== undefined) process.env.ORACLE_SIGNER_URL = prev;
      }
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    }
  });

  return app;
}

export default createVrfSignerApp;
