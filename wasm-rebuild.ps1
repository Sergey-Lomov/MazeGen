# Rebuild WASM and copy artifacts to web source directory
$root = $PSScriptRoot
$wasmPkg = "$root\maze-wasm\pkg"
$webPkg  = "$root\maze-web\src\wasm\pkg"

# Force Cargo to recompile on Windows (bash `touch` does not update NTFS mtime)
(Get-Item "$root\maze-wasm\src\lib.rs").LastWriteTime = Get-Date

Write-Host "Building WASM..." -ForegroundColor Cyan
wasm-pack build "$root\maze-wasm" --target web
if (-not $?) { Write-Host "wasm-pack failed" -ForegroundColor Red; exit 1 }

Write-Host "Copying artifacts to $webPkg..." -ForegroundColor Cyan
Copy-Item "$wasmPkg\maze_wasm_bg.wasm"      "$webPkg\maze_wasm_bg.wasm"      -Force
Copy-Item "$wasmPkg\maze_wasm.js"           "$webPkg\maze_wasm.js"           -Force
Copy-Item "$wasmPkg\maze_wasm_bg.js"        "$webPkg\maze_wasm_bg.js"        -Force
Copy-Item "$wasmPkg\maze_wasm.d.ts"         "$webPkg\maze_wasm.d.ts"         -Force
Copy-Item "$wasmPkg\maze_wasm_bg.wasm.d.ts" "$webPkg\maze_wasm_bg.wasm.d.ts" -Force

# Touch the JS entry point so Vite's HMR watcher picks up the new WASM binary
(Get-Item "$webPkg\maze_wasm.js").LastWriteTime = Get-Date

Write-Host "Done." -ForegroundColor Green
