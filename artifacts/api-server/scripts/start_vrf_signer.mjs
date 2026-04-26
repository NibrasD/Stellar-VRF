#!/usr/bin/env node
import fs from 'fs';
import https from 'https';
import createVrfSignerApp from '../src/lib/vrfSigner.js';

const port = process.env.VRF_SIGNER_PORT ? Number(process.env.VRF_SIGNER_PORT) : 6060;
const app = createVrfSignerApp();

const keyPath = process.env.VRF_SIGNER_TLS_KEY_PATH;
const certPath = process.env.VRF_SIGNER_TLS_CERT_PATH;
const clientCaPath = process.env.VRF_SIGNER_CLIENT_CA_PATH;
const requireClientCert = process.env.VRF_SIGNER_REQUIRE_CLIENT_CERT === '1';

if (keyPath && certPath) {
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  const options = { key, cert };
  if (clientCaPath) {
    options.ca = fs.readFileSync(clientCaPath);
    if (requireClientCert) {
      options.requestCert = true;
      options.rejectUnauthorized = true;
    }
  } else if (requireClientCert) {
    // eslint-disable-next-line no-console
    console.warn('VRF_SIGNER_REQUIRE_CLIENT_CERT is set but VRF_SIGNER_CLIENT_CA_PATH is not provided; client cert validation will not occur.');
  }

  https.createServer(options, app).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`VRF signer PoC listening on https://127.0.0.1:${port}`);
  });
} else {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`VRF signer PoC listening on http://127.0.0.1:${port}`);
  });
}
