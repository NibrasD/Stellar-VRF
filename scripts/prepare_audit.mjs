import { copyFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import path from 'path';

const root = path.resolve(new URL(import.meta.url).pathname, '..', '..');
const out = path.join(root, 'audit_package');
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = [
  'README.md',
  'soroban-contract/src/lib.rs',
  'soroban-contract/deploy.mjs',
  'soroban-contract/deployed.json',
  'artifacts/api-server/src/lib/vrfCrypto.ts',
  'artifacts/api-server/src/lib/sorobanSubmit.ts',
  'artifacts/api-server/test',
  'artifacts/api-server/.env.example',
];

for (const f of files) {
  const src = path.join(root, f);
  const dest = path.join(out, f.replace(/\//g, '_'));
  try {
    copyFileSync(src, dest);
    console.log('Copied', f);
  } catch (e) {
    console.warn('Skipping', f, e.message);
  }
}

console.log('Audit package prepared at', out);
