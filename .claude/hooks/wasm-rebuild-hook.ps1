$root = "d:\Development\MazeGen"
Set-Location $root

$logDir = Join-Path $root ".claude\hooks"
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir "wasm-rebuild.log"

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$changed = git status --porcelain=v1 | ForEach-Object { $_.Substring(3) }
$matched = [bool]($changed -match '^(maze-core|maze-wasm)/')

if ($matched) {
    "$ts fired matched=true invoking-rebuild" | Add-Content $logFile
    & "$root\wasm-rebuild.ps1"
    "$ts rebuild-script-exit=$LASTEXITCODE" | Add-Content $logFile
} else {
    "$ts fired matched=false skipped" | Add-Content $logFile
}
