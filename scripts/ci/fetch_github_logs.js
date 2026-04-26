// scripts/ci/fetch_github_logs.js
// ESM version — Usage: node scripts/ci/fetch_github_logs.js
// Requires one of env vars: GITHUB_TOKEN, GITHUB_PAT, GH_TOKEN

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { exec } from 'child_process';

const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_TOKEN;
if (!token) {
  console.error('NO_TOKEN');
  process.exit(2);
}

const owner = 'NibrasD';
const repo = 'Stellar-VRF';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'log-extractor' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

(async () => {
  try {
    const runsData = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/actions/runs?branch=main&per_page=10`);
    if (!runsData.workflow_runs || runsData.workflow_runs.length === 0) {
      console.error('NO_RUNS');
      process.exit(3);
    }
    const run = runsData.workflow_runs[0];
    console.log(JSON.stringify({ id: run.id, name: run.name, html_url: run.html_url, conclusion: run.conclusion, status: run.status, created_at: run.created_at, head_sha: run.head_sha }, null, 2));

    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/logs`;
    const zipRes = await fetch(zipUrl, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'log-extractor' } });
    if (!zipRes.ok) throw new Error(`Failed to download logs: ${zipRes.status} ${zipRes.statusText}`);

    const outPath = path.resolve(process.cwd(), `run-${run.id}-logs.zip`);
    await pipeline(zipRes.body, fs.createWriteStream(outPath));
    console.log('Saved', outPath);

    // Extract using PowerShell Expand-Archive
    await new Promise((resolve, reject) => {
      const outDir = path.resolve(process.cwd(), `gh-logs-${run.id}`);
      const cmd = `powershell -NoProfile -Command "Remove-Item -Recurse -Force '${outDir}' -ErrorAction SilentlyContinue; Expand-Archive -LiteralPath '${outPath}' -DestinationPath '${outDir}' -Force"`;
      exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });

    const logsDir = path.resolve(process.cwd(), `gh-logs-${run.id}`);

    // Search files for interesting patterns
    const matches = [];
    const patterns = [/Missing VRF_PRIVATE_KEY_HEX/i, /VRF_PRIVATE_KEY_HEX/i, /KMS_AWS_VRF_SECRET_ARN/i, /ERROR/i];

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else {
          let text = '';
          try { text = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const re of patterns) {
              if (re.test(line)) {
                matches.push(`${p}:${i + 1}: ${line.trim()}`);
                if (matches.length >= 500) return;
                break;
              }
            }
          }
        }
      }
    }

    walk(logsDir);

    if (matches.length) {
      console.log('\nFOUND MATCHES:');
      for (const m of matches.slice(0, 200)) console.log(m);
    } else {
      console.log('\nNo matching lines found in extracted logs.');
    }

    console.log('\nExtracted logs are in:', logsDir);
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message || err);
    process.exit(10);
  }
})();
