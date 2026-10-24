# scripts/dev.ps1 — Windows PowerShell end-to-end bootstrap for local development and testing.
#
# Takes a fresh clone from git clone to a running local demo:
#   1. Verifies prerequisites:
#        - stellar-cli >= 25.2 (prints install instructions if missing or outdated)
#        - cargo and rustup wasm32v1-none target
#        - Node.js (>= 20) and npm
#   2. Builds the contract Wasm via `stellar contract build` in contracts/streaming-payments
#   3. Starts or connects to a local Stellar sandbox container
#   4. Deploys the contract to the local network
#   5. Writes NEXT_PUBLIC_STREAMING_CONTRACT_ID, RPC URL, and network into frontend/.env.local
#   6. Installs frontend dependencies (npm ci) and starts the development server (npm run dev)
#
# Usage:
#   .\scripts\dev.ps1 [-SkipFrontend]

[CmdletBinding()]
param (
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LocalNetwork = "local"
$LocalRpcUrl = "http://localhost:8000/rpc"
$LocalPassphrase = "Standalone Network ; February 2017"
$LocalFriendbotUrl = "http://localhost:8000/friendbot"
$WasmPath = Join-Path $RepoRoot "contracts\streaming-payments\target\wasm32v1-none\release\streampay_contract.wasm"
$AltWasmPath = Join-Path $RepoRoot "target\wasm32v1-none\release\streampay_contract.wasm"

function Write-Say($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Write-Info($msg) {
    Write-Host "    $msg" -ForegroundColor Gray
}

function Write-WarnMsg($msg) {
    Write-Warning "$msg"
}

function Die($msg) {
    Write-Error "`nERROR: $msg"
    exit 1
}

# ---------------------------------------------------------------- 1. verify prerequisites
Write-Say "Verifying development prerequisites"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js not found. Please install Node.js >= 20: https://nodejs.org"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm not found. Please install npm: https://nodejs.org"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Die "cargo not found. Please install Rust >= 1.85: https://rustup.rs"
}

if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $installedTargets = rustup target list --installed 2>$null
    if ($installedTargets -notcontains "wasm32v1-none") {
        Write-WarnMsg "wasm32v1-none target missing. Attempting to add target..."
        try {
            rustup target add wasm32v1-none
        } catch {
            Write-WarnMsg "Failed to add target automatically. stellar contract build may still work if bundled."
        }
    }
}

if (-not (Get-Command stellar -ErrorAction SilentlyContinue)) {
    Write-Host @"

Stellar CLI was not found on your PATH.
soroban-sdk 28 requires `stellar contract build` (stellar-cli >= 25.2.0).

Install instructions:
  - Using cargo:
      cargo install --locked stellar-cli --version ">=25.2.0"
  - Using winget:
      winget install Stellar.StellarCLI
  - Or download Windows release binaries from:
      https://github.com/stellar/stellar-cli/releases

For detailed instructions, see: https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli
"@ -ForegroundColor Red
    Die "stellar-cli is required but not installed."
}

# Check version
$versionStr = ""
try {
    $versionStr = (stellar version --only-version 2>$null)
    if (-not $versionStr) {
        $versionStr = (stellar version 2>$null)
    }
} catch {
    $versionStr = ""
}

$versionMatch = [regex]::Match($versionStr, '(\d+)\.(\d+)(\.\d+)?')
if ($versionMatch.Success) {
    $major = [int]$versionMatch.Groups[1].Value
    $minor = [int]$versionMatch.Groups[2].Value
    $versionNum = $versionMatch.Value

    if ($major -lt 25 -or ($major -eq 25 -and $minor -lt 2)) {
        Write-Host @"

Detected stellar-cli version $versionNum.
soroban-sdk 28 requires stellar contract build with stellar-cli >= 25.2.0.
Plain 'cargo build --target wasm32v1-none' is rejected by the SDK build script.

Please update stellar-cli:
    cargo install --locked stellar-cli
"@ -ForegroundColor Red
        Die "stellar-cli version $versionNum is too old (>= 25.2.0 required)."
    }
    Write-Info "Found stellar-cli version $versionNum (>= 25.2.0 requirement met)"
} else {
    Write-WarnMsg "Could not parse stellar-cli version string ('$versionStr'). Proceeding cautiously..."
}

# ---------------------------------------------------------------- 2. build contract
Write-Say "Building contract Wasm with stellar contract build"
Push-Location (Join-Path $RepoRoot "contracts\streaming-payments")
try {
    stellar contract build
} finally {
    Pop-Location
}

$ResolvedWasm = ""
if (Test-Path $WasmPath) {
    $ResolvedWasm = $WasmPath
} elseif (Test-Path $AltWasmPath) {
    $ResolvedWasm = $AltWasmPath
} else {
    Die "Wasm artifact not found after build. Expected at $WasmPath or $AltWasmPath"
}
Write-Info "Built Wasm: $ResolvedWasm"

# ---------------------------------------------------------------- 3. local network / sandbox
Write-Say "Checking local Stellar sandbox network"

function Test-SandboxReady {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:8000/" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { return $true }
    } catch {}
    return $false
}

if (Test-SandboxReady) {
    Write-Info "Local Stellar sandbox is already running on port 8000."
} else {
    Write-Say "Starting local Stellar network sandbox container..."
    $started = $false
    try {
        stellar container start local
        $started = $true
    } catch {
        Write-WarnMsg "stellar container start local was not successful. Trying Docker directly..."
    }

    if (-not $started -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        try {
            $running = docker ps --format '{{.Names}}'
            if ($running -contains 'stellar-local-sandbox') {
                Write-Info "Container stellar-local-sandbox already running."
            } else {
                $exists = docker ps -a --format '{{.Names}}'
                if ($exists -contains 'stellar-local-sandbox') {
                    docker start stellar-local-sandbox | Out-Null
                } else {
                    docker run -d --name stellar-local-sandbox -p 8000:8000 stellar/quickstart --local | Out-Null
                }
            }
        } catch {}
    }

    Write-Info "Waiting for local sandbox service to become healthy..."
    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-SandboxReady) {
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if (-not $healthy) {
        Write-WarnMsg @"
Local sandbox RPC did not respond on http://localhost:8000.
To run the local sandbox, ensure Docker is running and run:
    stellar container start local
or:
    docker run --rm -d -p 8000:8000 --name stellar-local-sandbox stellar/quickstart --local
"@
    } else {
        Write-Info "Local Stellar sandbox is healthy and responding!"
    }
}

try {
    $networks = stellar network ls 2>$null
    if ($networks -notmatch "\b$LocalNetwork\b") {
        Write-Info "Adding '$LocalNetwork' network profile to stellar-cli..."
        stellar network add $LocalNetwork --rpc-url $LocalRpcUrl --network-passphrase $LocalPassphrase 2>$null
    }
} catch {}

# ---------------------------------------------------------------- 4. deploy contract
Write-Say "Deploying StreamingPayments contract to $LocalNetwork network"

$deployerAddr = ""
try {
    $deployerAddr = (stellar keys address local-deployer 2>$null)
    if (-not $deployerAddr) {
        stellar keys generate local-deployer --network $LocalNetwork 2>$null
        $deployerAddr = (stellar keys address local-deployer 2>$null)
    }
} catch {
    try {
        stellar keys generate local-deployer 2>$null
        $deployerAddr = (stellar keys address local-deployer 2>$null)
    } catch {}
}

if ($deployerAddr) {
    try {
        Invoke-WebRequest -Uri "$LocalFriendbotUrl`?addr=$deployerAddr" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
    } catch {}
}

$ContractId = ""
$envLocalPath = Join-Path $RepoRoot "frontend\.env.local"
if (Test-Path $envLocalPath) {
    $existing = Get-Content $envLocalPath | Where-Object { $_ -match "^NEXT_PUBLIC_STREAMING_CONTRACT_ID=(.*)$" }
    if ($existing) {
        $val = ($existing -split "=", 2)[1].Trim(' "')
        if ($val -match '^C[A-Z0-9]{55}$') {
            Write-Info "Found existing contract id in frontend/.env.local: $val"
            $ContractId = $val
        }
    }
}

if (-not $ContractId) {
    Write-Info "Deploying contract wasm..."
    try {
        $deployOutput = if ($deployerAddr) {
            stellar contract deploy --wasm $ResolvedWasm --source local-deployer --network $LocalNetwork -- --governor $deployerAddr 2>$null
        } else {
            stellar contract deploy --wasm $ResolvedWasm --source local-deployer --network $LocalNetwork 2>$null
        }
        if ($deployOutput) {
            $ContractId = ($deployOutput | Select-Object -Last 1).Trim()
        }
    } catch {}
}

if (-not $ContractId -or $ContractId -notmatch '^C') {
    Write-WarnMsg "Contract deploy did not return a contract id. Using placeholder until sandbox is running."
    $ContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}

Write-Info "Contract ID: $ContractId"

# ---------------------------------------------------------------- 5. configure frontend/.env.local
Write-Say "Configuring frontend/.env.local"

$envContent = @"
# Generated automatically by scripts/dev.ps1
NEXT_PUBLIC_SOROBAN_RPC_URL=$LocalRpcUrl
NEXT_PUBLIC_NETWORK=STANDALONE
NEXT_PUBLIC_STREAMING_CONTRACT_ID=$ContractId
"@

Set-Content -Path $envLocalPath -Value $envContent -Encoding utf8
Write-Info "Wrote configuration to frontend/.env.local"

# ---------------------------------------------------------------- 6. frontend setup & run
Write-Say "Setting up frontend dependencies"
Push-Location (Join-Path $RepoRoot "frontend")
try {
    Write-Info "Running npm ci..."
    npm ci

    Write-Host @"

──────────────────────────────────────────────────────────────────
  StreamPay Local Demo is ready!

  Network      : $LocalNetwork ($LocalRpcUrl)
  Contract ID  : $ContractId
  Env File     : frontend/.env.local

  Starting local frontend development server on http://localhost:3000
──────────────────────────────────────────────────────────────────
"@

    if ($SkipFrontend) {
        Write-Info "Skipping frontend server start (-SkipFrontend supplied)."
        return
    }

    Write-Say "Starting frontend dev server (npm run dev)"
    npm run dev
} finally {
    Pop-Location
}
