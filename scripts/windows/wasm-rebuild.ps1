# Rebuild WASM and copy artifacts to web source directory.
# Default: dev profile (opt-level 0, incremental) - ~6x faster than release.
# Use -Release for an optimized build (slow, ~5 min).
param([switch]$Release)
$root = Split-Path (Split-Path $PSScriptRoot)
$wasmPkg = "$root\maze-wasm\pkg"
$webPkg  = "$root\maze-web\src\wasm\pkg"

Write-Host "Building WASM..." -ForegroundColor Cyan
$mode = if ($Release) { "--release" } else { "--dev" }
wasm-pack build "$root\maze-wasm" --target web $mode
if ($LASTEXITCODE -ne 0) { Write-Host "wasm-pack failed" -ForegroundColor Red; exit 1 }

Write-Host "Copying artifacts to $webPkg..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $webPkg -Force | Out-Null
Copy-Item "$wasmPkg\maze_wasm_bg.wasm"      "$webPkg\maze_wasm_bg.wasm"      -Force
Copy-Item "$wasmPkg\maze_wasm.js"           "$webPkg\maze_wasm.js"           -Force
Copy-Item "$wasmPkg\maze_wasm.d.ts"         "$webPkg\maze_wasm.d.ts"         -Force
Copy-Item "$wasmPkg\maze_wasm_bg.wasm.d.ts" "$webPkg\maze_wasm_bg.wasm.d.ts" -Force

# Touch the JS entry point so Vite's HMR watcher picks up the new WASM binary
(Get-Item "$webPkg\maze_wasm.js").LastWriteTime = Get-Date

node "$root\scripts\wasm-state.mjs" --verify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done." -ForegroundColor Green
