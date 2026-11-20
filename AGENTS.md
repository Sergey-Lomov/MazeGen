# Repository Guidelines

Tool-agnostic rules shared by all AI agents. `CLAUDE.md` imports this file and adds Claude Code specifics.

A **maze editor and generator** with a Rust core (`maze-core`). Cargo workspace; more crates may be added.

## Language

- Repository artifacts in English only (code, comments, docs, specs, commit messages, GitHub issues, PRs and their comments). Exception: localization files use their locale's language.
- Converse, plan, and respond in the user's language; specific technologies stay in English (`Result`, `impl`, `trait`, etc.).

## Collaboration

- Ask clarifying questions before writing code if the task is ambiguous or underspecified.

## Commits

- Never commit without an explicit user instruction.
- Commit directly to the current branch; never create a new branch, even on `main`.
- No Co-Authored-By or other attribution lines.
- Subject: short imperative, no period.

## Specs

`Specs/` holds the authoritative description of systems and data structures. Check it before implementing or modifying a feature.

## Core and WASM Workflow

- Finish all related `maze-core` / `maze-wasm` source changes before building WASM.
- Run one final `wasm-pack build maze-wasm --target web`, sync the package into `maze-web/src/wasm/pkg`, and verify the WASM artifact hashes match.
- Don't rebuild earlier or repeatedly unless a failed build or a later core/WASM edit requires it. Test-only or docs-only changes after a successful build need no rebuild.

## Testing

- Prefer focused tests for the changed area; don't repeat broad suites or builds without distinct coverage value.
- Before proposing a commit of any change under `maze-core/` or `maze-runner/`, run once after all edits (lib tests alone miss separate integration targets):
  - `cargo test -p maze-core --tests`
  - `cargo test -p maze-runner`
- Add `--no-fail-fast`. `maze-wasm` is wasm-only: exclude it from `--workspace` runs. A web change also needs `npx vitest run` from `maze-web/` against a fresh wasm build.
- On a failure, check `git stash` first to tell a regression from a pre-existing failure, and report which it is.

### CPU load

Never run tests, checks, builds, or other heavy processes with all cores saturated; the machine must stay responsive. Cap parallelism explicitly, e.g. `npx vitest run --maxWorkers=2`, `cargo test -j 2 -- --test-threads=2`, `cargo build -j 2`. Don't run heavy processes in parallel with each other.

### Integration tests (`maze-runner`)

Native-Rust crate that parses the same JSON config the browser sends and runs the full `build_maze` pipeline. Use it for all reproduction and regression tests.

1. Export config from the browser (debug toolbar → "Copy config JSON").
2. Save to `maze-runner/tests/fixtures/<name>.json`.
3. Copy the template function from `maze-runner/tests/repro.rs`, rename it, assert on `MazeRunResult`.

Browser-repro tests never hardcode generation params (seed, tessellation, checks, strategies, repair limits): take them all from the fixture so the test reproduces the browser run. Hand-crafted unit tests may hardcode them.

`MazeRunResult`: `remaining_issues`, `region_sizes` (`HashMap<RegionClass, Vec<usize>>`, sorted desc), `start`, `finish`, `timing`, `graph` (final post-repair `Graph`; inspect edge kinds/directionality).

### Debug event logs (`EventLog`/`DebugTape`)

See `Specs/event_log.md`. Don't write an exact-sequence test per event variant; it breaks on every narration reword.

- **One** exact-sequence test on the smallest deterministic input (branches forced by input shape, not seed luck), asserting the full ordered payload list for one scope.
- All other tests assert **invariants**: mutating events match resulting graph state, tree nesting matches expected scope names, `is_mutating()` agrees with the mutating/trace split, a `None` log doesn't change generation output.

## Debugging

- Mark temporary diagnostic logs with `// DIAG` on the same line; remove all before committing.
- In Rust use `diag_log!` (`maze-core/src/diag.rs`), never bare `println!` (swallowed on `wasm32`): `crate::diag_log!("value={x:?}"); // DIAG`
- Log only what the investigation needs: no per-frame/per-item spam, no unrelated state.
- Output must be readable as-is, with no toggles, flags, or console commands, and no collapsed objects. In TypeScript use `console.log("tag", JSON.stringify(payload))`, never a raw object. In Rust format values into the message.
- Each log is one self-contained line: short tag plus concrete values.

## No visual verification

Never launch the dev server or drive a browser (Playwright etc.) to check UI changes, even if other guidance suggests it. Rely on unit tests and `tsc`. The user checks visuals.

## i18n (paraglide)

- Compile from `maze-web`: `npx paraglide-js compile --project ./project.inlang --outdir ./generated/paraglide --output-structure locale-modules`.
- **Always pass `--output-structure locale-modules`.** The default `message-modules` emits ~1700 files and makes Vite dev start very slow. Sanity check: `find generated/paraglide -type f | wc -l` ≈ 10.
- `npm run dev|build|test|test:watch` run `tools/ensure-deps.mjs` (npm install on missing or mismatched deps), then `tools/prepare-paraglide.mjs`, which fingerprints translations, `project.inlang/settings.json`, package manifests and the Paraglide package; it recompiles and clears `node_modules/.vite` only when the fingerprint changes. Generated output stays untracked.
- Inlang plugins are vendored in `maze-web/tools/inlang-plugins/` (no network needed; part of the fingerprint). `tools/paraglide-watch-plugin.mjs` recompiles on translation/settings edits during dev. `npm run measure:startup [-- --cold]` timestamps dev-server startup.

## Export

Cut transfers (#859, `PngExporter.renderCutSheet`): unless a feature's spec says otherwise, everything drawn on the image takes part: drawn once per `CutPlan` offset, clipped to the cut region, like the content. A new export element drawn once over the whole frame must say so in `Specs/image-export.md`.

## Files to skip

Don't read, search, or edit these (generated, vendored, binary, or machine-local); exclude them from searches (e.g. `rg -g '!target' -g '!node_modules'`).

- Build outputs: `target/`, `maze-web/dist/`, `maze-web/tsconfig.tsbuildinfo`.
- Dependencies: `node_modules/`.
- Generated: `maze-web/generated/`, `maze-web/src/wasm/pkg/`, `maze-web/src/wasm/maze_wasm.js`, `maze-web/src/wasm/maze_wasm_bg.wasm`, `maze-wasm/pkg/`.
- Caches, coverage, profiling: `maze-web/coverage/`, `maze-web/node_modules/.vite/`, `*.profraw`.
- Logs and temp output: `*.log`, `maze-web/*.png`, `quality-logs/`, `.decomposition-notes/`.
- Large binary assets: `maze-web/public/fonts/`, `maze-web/public/licenses/`.
- Editor and local agent state: `.vscode/`, `.claude/settings.local.json`.

Source, `Specs/`, configs, lockfiles, test fixtures and baselines stay in scope.
