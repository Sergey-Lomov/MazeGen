# Test performance

The complete local workflow is `scripts/test.sh` (macOS/Linux) or
`scripts/windows/test.ps1` (Windows). Both commands print separate measurements for `cargo-test`,
`wasm-rebuild`, and `web-test`.

## Measurement protocol

Run the full command twice on an otherwise idle machine:

1. Record the first run as **cold**. It includes compilation and the initial WASM package build.
2. Record the second run as **warm**. With unchanged Rust inputs its `wasm-rebuild` phase must
   report `0` and `reused current package`.

The comparison is intentionally phase-based. Rust compilation is unavoidable after a clean build;
the optimized path removes the redundant WASM build from warm full runs and from web-only work.

For a focused change, use the commands in `scripts/README.md` instead of the complete workflow.

## CI

GitHub Actions runs Rust and web suites in parallel. Cargo and npm dependency caches are keyed by
their lockfiles. The web job builds exactly one WASM package before running Vitest, preserving the
integration coverage that requires the real WASM module.
