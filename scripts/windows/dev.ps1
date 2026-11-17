# Start (or restart) the web dev server
Set-Location "$(Split-Path (Split-Path $PSScriptRoot))\maze-web"
npm run dev
