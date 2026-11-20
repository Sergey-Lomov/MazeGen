# Repository Guidelines

## Language

- Use English only for repository artifacts except localization files, including source code, code comments, documentation, specifications, commit messages, GitHub issues, pull requests, and their comments.
- Localization files must use the language of their respective locale.
- Conversation with the user may follow the user's language.

## Core and WASM Workflow

- When a production-source change affects `maze-core` or `maze-wasm`, finish all related source changes before building WASM.
- Run one final `wasm-pack build maze-wasm --target web`, then synchronize the emitted package with `maze-web/src/wasm/pkg` and verify the WASM artifact hashes match.
- Do not rebuild WASM earlier or repeatedly unless a failed build or a subsequent core/WASM edit makes it necessary.
- A test-only or documentation-only change made after a successful WASM build does not require another WASM rebuild.
- Prefer focused tests for the changed area. Do not repeat broad suites or builds unless they provide distinct coverage needed for the change.

## Files to skip

Do not read, search, or edit these; they are generated, vendored, binary, or machine-local. Exclude them from searches (e.g. `rg -g '!target' -g '!node_modules'`).

- Build outputs: `target/`, `maze-web/dist/`, `maze-web/tsconfig.tsbuildinfo`.
- Dependencies: `node_modules/`.
- Generated code: `maze-web/generated/`, `maze-web/src/wasm/pkg/`, `maze-web/src/wasm/maze_wasm.js`, `maze-web/src/wasm/maze_wasm_bg.wasm`, `maze-wasm/pkg/`.
- Caches, coverage, profiling: `maze-web/coverage/`, `maze-web/node_modules/.vite/`, `*.profraw`.
- Logs and temp output: `*.log`, `maze-web/*.png`, `quality-logs/`, `.decomposition-notes/`.
- Large binary assets: `maze-web/public/fonts/`, `maze-web/public/licenses/`.
- Editor and local agent state: `.vscode/`, `.claude/settings.local.json`.

Source, `Specs/`, configs, lockfiles, test fixtures and baselines stay in scope.

## Scoping Context

Codex has no ignore file, so narrow its context manually:

- Name target paths in the prompt (e.g. `maze-core/src/generation/` or `@maze-web/src/wasm/mazeService.ts`) instead of asking for repo-wide search.
- Point to the relevant `Specs/*.md` file first; it is the authoritative description of a system.
- Restrict searches to source directories: `rg <pattern> maze-core maze-runner maze-wasm maze-web/src Specs`.
- Exclude noise in ad-hoc searches: `rg -g '!target' -g '!node_modules' -g '!maze-web/generated' -g '!maze-web/dist' -g '!maze-web/src/wasm/pkg' -g '!*.wasm' <pattern>`.
- Run Codex from the subdirectory being changed (e.g. `maze-web/`) to narrow its default working scope.
- Keep `AGENTS.md` short; Codex loads it into every session.
