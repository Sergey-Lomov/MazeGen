# Register a daily Task Scheduler job that runs clean-stale.ps1 (current user, no admin needed).
# Runs 4 times a day, every 6 hours starting at -At (default 03:00, 09:00, 15:00, 21:00);
# if the machine was off, runs at the next opportunity.
# Re-running replaces the existing task. Remove with: Unregister-ScheduledTask MazeGenCleanStale
param([string]$At = "03:00")

$script = Join-Path $PSScriptRoot "clean-stale.ps1"
$repoRoot = Split-Path (Split-Path $PSScriptRoot)
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
    -WorkingDirectory $repoRoot
$trigger = 0..3 | ForEach-Object { New-ScheduledTaskTrigger -Daily -At ([datetime]$At).AddHours(6 * $_) }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "MazeGenCleanStale" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered MazeGenCleanStale (4 times a day from $At, every 6 hours)" -ForegroundColor Green
