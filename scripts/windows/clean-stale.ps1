# Remove stale Cargo artifacts from target\ (pass --dry-run to preview)
node "$PSScriptRoot\..\clean-stale.mjs" @args
exit $LASTEXITCODE
