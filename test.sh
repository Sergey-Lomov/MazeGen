#!/usr/bin/env bash
# Run all Rust tests
set -euo pipefail
cd "$(dirname "$0")"
cargo test
