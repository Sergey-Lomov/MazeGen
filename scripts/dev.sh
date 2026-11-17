#!/usr/bin/env bash
# Start (or restart) the web dev server
set -euo pipefail
cd "$(dirname "$0")/../maze-web"
npm run dev
