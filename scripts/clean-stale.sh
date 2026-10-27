#!/usr/bin/env bash
# Remove stale Cargo artifacts from target/ (pass --dry-run to preview)
set -euo pipefail
exec node "$(dirname "$0")/clean-stale.mjs" "$@"
