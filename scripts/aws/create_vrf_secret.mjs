#!/usr/bin/env node
// create_vrf_secret.mjs — create or update a Secrets Manager secret containing VRF_PRIVATE_KEY_HEX
// Usage: KMS_AWS_VRF_SECRET_ARN=... node scripts/aws/create_vrf_secret.mjs --secret-name my/vrf/key --value <hex>

import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';

const argv = process.argv.slice(2);
function getArg(name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

const secretName = getArg('--secret-name');
const value = getArg('--value');
const region = process.env.AWS_REGION || 'us-east-1';

if (!secretName || !value) {
  console.error('Usage: node create_vrf_secret.mjs --secret-name <name> --value <hex>');
  process.exit(2);
}

const client = new SecretsManagerClient({ region });

async function main() {
  try {
    // check exists
    await client.send(new DescribeSecretCommand({ SecretId: secretName }));
    console.log('Secret exists — putting new value');
    await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: value }));
    console.log('Updated secret');
  } catch (e) {
    // create
    await client.send(new CreateSecretCommand({ Name: secretName, SecretString: value }));
    console.log('Created secret');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
