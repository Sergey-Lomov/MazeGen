# Run all Rust tests, then the web tests against a current WASM package.
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot)
Set-Location $repoRoot

function Invoke-Phase([string]$Name, [scriptblock]$Action) {
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  & $Action
  $exitCode = $LASTEXITCODE
  $stopwatch.Stop()
  Write-Host ("PHASE={0} ELAPSED_SECONDS={1:N3}" -f $Name, $stopwatch.Elapsed.TotalSeconds)
  if ($exitCode -ne 0) { exit $exitCode }
}

Invoke-Phase "wasm-state-test" { node --test "$repoRoot\scripts\wasm-state.test.mjs" }
Invoke-Phase "cargo-test" { cargo test }

$wasmState = & node "$repoRoot\scripts\wasm-state.mjs" --needs-rebuild
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) { exit $LASTEXITCODE }
Write-Host $wasmState
if ($wasmState -like "rebuild:*") {
  Invoke-Phase "wasm-rebuild" { & "$PSScriptRoot/wasm-rebuild.ps1" }
} else {
  Write-Host "PHASE=wasm-rebuild ELAPSED_SECONDS=0 (reused current package)"
}

Set-Location "$repoRoot/maze-web"
Invoke-Phase "web-test" { npm test }
