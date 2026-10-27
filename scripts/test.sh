#!/usr/bin/env bash
# Run all Rust tests, then the web tests against a fresh wasm build
set -euo pipefail
cd "$(dirname "$0")/.."
cargo test
scripts/wasm-rebuild.sh
(cd maze-web && npm test)
