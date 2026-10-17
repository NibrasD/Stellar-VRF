<#
.SYNOPSIS
  Build a self-contained deployment package of the oracle worker on THIS machine,
  so nothing has to be compiled on the (512 MB) Testnet server.

.DESCRIPTION
  Produces  <OutDir>\testnet-<commit8>.tgz  containing exactly:
      dist\                 compiled worker (tests and type declarations removed)
      package.json
      package-lock.json
      ttl_extend.mjs        the TTL keeper script (runs from the release folder)
      MANIFEST.json         commit, build time, SHA-256 of dist\fulfiller.js
  The package never contains a .env file or any secret. The script refuses to
  finish if it finds an env file or a Stellar secret key (S...) inside it.

  On the server, install production dependencies only:
      npm ci --omit=dev --ignore-scripts

  Every npm call here uses npm.cmd, because plain `npm` (npm.ps1) does not run
  on this machine.

.PARAMETER OutDir
  Where to write the package (default: %TEMP%).

.PARAMETER AllowDirty
  Build even if oracle-worker has uncommitted changes. The MANIFEST then records
  dirty=true, so the running code is no longer reproducible from the commit.

.PARAMETER RunTests
  Run `npm.cmd test` before packaging (slower; recommended before a release).

.EXAMPLE
  cd C:\Users\User\Stellar-VRF\oracle-worker
  .\testnet_package.ps1 -RunTests
#>
[CmdletBinding()]
param(
  [string]$OutDir = $env:TEMP,
  [switch]$AllowDirty,
  [switch]$RunTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
function Need-Ok($what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" } }

$worker = $PSScriptRoot
$repo = Split-Path $worker -Parent
Set-Location $worker

foreach ($f in 'package.json', 'package-lock.json', 'tsconfig.json', 'ttl_extend.mjs') {
  if (-not (Test-Path (Join-Path $worker $f))) { Fail "missing $f in $worker" }
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm.cmd not found on PATH (is Node.js installed?)' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git not found on PATH' }
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'tar.exe not found (it ships with Windows 10 and later)' }

# --- provenance ------------------------------------------------------------
Step 'Checking git state'
$env:GIT_PAGER = 'cat'
$commit = (git -C $repo rev-parse HEAD).Trim(); Need-Ok 'git rev-parse'
$short = $commit.Substring(0, 8)
$dirtyLines = @(git -C $repo status --porcelain -- oracle-worker)
Need-Ok 'git status'
$dirty = $dirtyLines.Count -gt 0
if ($dirty -and -not $AllowDirty) {
  $dirtyLines | Select-Object -First 15 | ForEach-Object { Write-Host "   $_" }
  Fail 'oracle-worker has uncommitted changes. Commit them, or pass -AllowDirty (the MANIFEST will say dirty=true).'
}
if ($dirty) { Write-Host 'WARNING: building from a dirty tree (-AllowDirty).' -ForegroundColor Yellow }
Write-Host "    commit $commit  dirty=$dirty"
Write-Host "    local node $(node -v)  (the build output is ES2022 and does not depend on it)"

# --- build -----------------------------------------------------------------
Step 'npm.cmd ci (clean install, exactly as locked)'
& npm.cmd ci
Need-Ok 'npm.cmd ci'

if ($RunTests) {
  Step 'npm.cmd test'
  & npm.cmd test
  Need-Ok 'npm.cmd test'
}

Step 'Clean dist, then npm.cmd run build'
if (Test-Path (Join-Path $worker 'dist')) { Remove-Item (Join-Path $worker 'dist') -Recurse -Force }
& npm.cmd run build
Need-Ok 'npm.cmd run build'
foreach ($f in 'dist\index.js', 'dist\fulfiller.js', 'dist\config.js') {
  if (-not (Test-Path (Join-Path $worker $f))) { Fail "build did not produce $f" }
}

# --- stage -----------------------------------------------------------------
$rel = "testnet-$short"
if ($dirty) { $rel = "$rel-dirty" }
$stage = Join-Path $OutDir $rel
$tgz = Join-Path $OutDir "$rel.tgz"
Step "Staging $stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $tgz) { Remove-Item $tgz -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $worker 'dist') (Join-Path $stage 'dist') -Recurse
Copy-Item (Join-Path $worker 'package.json') $stage
Copy-Item (Join-Path $worker 'package-lock.json') $stage
Copy-Item (Join-Path $worker 'ttl_extend.mjs') $stage

# tsconfig includes src/**/* so tests are compiled too; they are not needed at runtime.
$removed = @(Get-ChildItem (Join-Path $stage 'dist') -Recurse -File |
  Where-Object { $_.Name -match '\.test\.' -or $_.Name -match '\.d\.ts(\.map)?$' })
$removed | Remove-Item -Force
Write-Host "    removed $($removed.Count) test/declaration files"

$fulfiller = Join-Path $stage 'dist\fulfiller.js'
$fulfillerHash = (Get-FileHash $fulfiller -Algorithm SHA256).Hash.ToLower()

$manifest = [ordered]@{
  name              = 'soroban-vrf-oracle-worker'
  commit            = $commit
  dirty             = $dirty
  builtAtUtc        = (Get-Date).ToUniversalTime().ToString('o')
  builtWithNode     = (node -v).Trim()
  fulfillerJsSha256 = $fulfillerHash
  install           = 'npm ci --omit=dev --ignore-scripts'
}
$json = ($manifest | ConvertTo-Json) + "`n"
[IO.File]::WriteAllText((Join-Path $stage 'MANIFEST.json'), $json, (New-Object Text.UTF8Encoding($false)))

# --- safety checks on what we are about to ship ------------------------------
Step 'Scanning the package for env files and secrets'
$files = @(Get-ChildItem $stage -Recurse -File)
$envFiles = @($files | Where-Object { $_.Name -like '.env*' -or $_.Name -like '*.env' })
if ($envFiles.Count -gt 0) { Fail "package contains env file(s): $($envFiles.Name -join ', ')" }
$secretHits = @($files | Select-String -Pattern '\bS[A-Z2-7]{55}\b' -List)
if ($secretHits.Count -gt 0) { Fail "package contains something that looks like a Stellar secret key in: $($secretHits.Path -join ', ')" }
Write-Host "    $($files.Count) files, no env files, no secret-key patterns"

# --- archive ---------------------------------------------------------------
Step "Creating $tgz"
& tar.exe -czf $tgz -C $OutDir $rel
Need-Ok 'tar'
$size = [math]::Round((Get-Item $tgz).Length / 1MB, 2)
$tgzHash = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()

Write-Host ''
Write-Host '==== PACKAGE READY ====' -ForegroundColor Green
Write-Host "  file                     : $tgz ($size MB)"
Write-Host "  commit                   : $commit  (dirty=$dirty)"
Write-Host "  package sha256           : $tgzHash"
Write-Host "  dist/fulfiller.js sha256 : $fulfillerHash"
Write-Host ''
Write-Host 'Copy it to the server (replace <TESTNET_HOST>):'
Write-Host "  scp `"$tgz`" deploy@<TESTNET_HOST>:/home/deploy/$rel.tgz"
Write-Host ''
Write-Host 'On the server, verify before unpacking:'
Write-Host "  sha256sum /home/deploy/$rel.tgz    # expect $tgzHash"
Write-Host ''
Write-Host 'Full server steps: docs/TESTNET_OPERATIONS.md'
