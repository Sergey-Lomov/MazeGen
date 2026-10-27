$root = "d:\Development\MazeGen"
Set-Location $root

$logDir = Join-Path $root ".claude\hooks"
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir "wasm-rebuild.log"

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$changed = git status --porcelain=v1 | ForEach-Object { $_.Substring(3) }
$matched = [bool]($changed -match '^(maze-core|maze-core-macros|maze-runner|maze-wasm)/')

# Skip when the built wasm is newer than every uncommitted source file in those crates.
if ($matched) {
    $wasm = Join-Path $root "maze-web\src\wasm\pkg\maze_wasm_bg.wasm"
    if (Test-Path $wasm) {
        $built = (Get-Item $wasm).LastWriteTime
        $newest = $changed | Where-Object { $_ -match '^(maze-core|maze-core-macros|maze-runner|maze-wasm)/' } |
            ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ -PathType Leaf } |
            ForEach-Object { (Get-Item $_).LastWriteTime } | Sort-Object -Descending | Select-Object -First 1
        if ($newest -and $newest -le $built) { $matched = $false }
    }
}

if ($matched) {
    "$ts fired matched=true invoking-rebuild" | Add-Content $logFile
    & "$root\scripts\windows\wasm-rebuild.ps1"
    "$ts rebuild-script-exit=$LASTEXITCODE" | Add-Content $logFile
} else {
    "$ts fired matched=false skipped" | Add-Content $logFile
}
