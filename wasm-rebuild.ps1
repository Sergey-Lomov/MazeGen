# Rebuild WASM and restart the web dev server
$root = $PSScriptRoot

Write-Host "Building WASM..." -ForegroundColor Cyan
Set-Location "$root\maze-wasm"
wasm-pack build --target web --out-dir "$root\maze-web\pkg"
if (-not $?) { Write-Host "wasm-pack failed" -ForegroundColor Red; exit 1 }

Write-Host "Starting dev server..." -ForegroundColor Cyan
Set-Location "$root\maze-web"
npm run dev
