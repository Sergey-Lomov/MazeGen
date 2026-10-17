#!/usr/bin/env bash
# Rebuild WASM (with the dev-only `test-tessellation` kind) and copy artifacts to web source directory
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
wasm_pkg="$root/maze-wasm/pkg"
web_pkg="$root/maze-web/src/wasm/pkg"

echo "Building WASM..."
if ! wasm-pack build "$root/maze-wasm" --target web -- --features test-tessellation; then
  echo "wasm-pack failed" >&2
  exit 1
fi

echo "Copying artifacts to $web_pkg..."
mkdir -p "$web_pkg"
for f in maze_wasm_bg.wasm maze_wasm.js maze_wasm.d.ts maze_wasm_bg.wasm.d.ts; do
  cp -f "$wasm_pkg/$f" "$web_pkg/$f"
done

# Touch the JS entry point so Vite's HMR watcher picks up the new WASM binary
touch "$web_pkg/maze_wasm.js"

echo "Done."
