#!/usr/bin/env node
import fs from 'fs'
import process from 'process'
import sodium from 'libsodium-wrappers'

async function getFetch() {
  if (typeof fetch === 'function') return fetch
  const mod = await import('node-fetch')
  return mod.default
}

async function encrypt(publicKeyBase64, secretValue) {
  await sodium.ready
  const pubKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL)
  const msg = sodium.from_string(secretValue)
  const sealed = sodium.crypto_box_seal(msg, pubKey)
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL)
}

async function putSecret(repo, token, name, value) {
  const fetch = await getFetch()
  const pkRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' }
  })
  if (!pkRes.ok) throw new Error(`failed to fetch public key: ${pkRes.status} ${await pkRes.text()}`)
  const pk = await pkRes.json()
  const encrypted = await encrypt(pk.key, value)
  const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: pk.key_id })
  })
  if (!putRes.ok) throw new Error(`failed to put secret ${name}: ${putRes.status} ${await putRes.text()}`)
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'NibrasD/Stellar-VRF'
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error('GITHUB_TOKEN not set')
    process.exit(2)
  }

  const tfPath = 'infra/aws/tf_output.json'
  if (!fs.existsSync(tfPath)) {
    console.error('tf_output.json not found at infra/aws/tf_output.json')
    process.exit(3)
  }
  const data = JSON.parse(fs.readFileSync(tfPath, 'utf8'))
  const kms = data.kms_key_id?.value
  const secretArn = data.secret_arn?.value
  if (!kms || !secretArn) {
    console.error('missing outputs in tf_output.json')
    process.exit(4)
  }

  await putSecret(repo, token, 'KMS_AWS_VRF_SECRET_ARN', secretArn)
  await putSecret(repo, token, 'KMS_AWS_KEY_ID', kms)

  console.log('GH_SECRETS_SET_OK')
}

main().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
