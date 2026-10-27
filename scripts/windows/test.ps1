# Run all Rust tests, then the web tests against a fresh wasm build
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot)
Set-Location $repoRoot
cargo test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot/wasm-rebuild.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Set-Location "$repoRoot/maze-web"
npm test
exit $LASTEXITCODE
