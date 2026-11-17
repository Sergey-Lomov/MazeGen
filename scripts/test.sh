#!/usr/bin/env bash
# Run all Rust tests, then the web tests against a current WASM package.
set -euo pipefail
cd "$(dirname "$0")/.."

run_phase() {
  local name="$1"
  shift
  local started=$SECONDS
  "$@"
  printf 'PHASE=%s ELAPSED_SECONDS=%s\n' "$name" "$((SECONDS - started))"
}

run_phase wasm-state-test node --test scripts/wasm-state.test.mjs
run_phase cargo-test cargo test

set +e
wasm_state="$(node scripts/wasm-state.mjs --needs-rebuild)"
wasm_state_exit=$?
set -e
if [[ $wasm_state_exit -ne 0 && $wasm_state_exit -ne 2 ]]; then
  exit "$wasm_state_exit"
fi
printf '%s\n' "$wasm_state"
if [[ "$wasm_state" == rebuild:* ]]; then
  run_phase wasm-rebuild scripts/wasm-rebuild.sh
else
  printf 'PHASE=wasm-rebuild ELAPSED_SECONDS=0 (reused current package)\n'
fi

cd maze-web
run_phase web-test npm test
