# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

A **maze editor and generator** with a Rust core (`maze-core`). Workspace; more crates may be added.

## Languages

- Converse, plan, and respond in the user's language; general terms in the user's language, specific technologies in English (`Result`, `impl`, `trait`, etc.).
- All file contents (code, comments, docs, specs) and commit messages: English only.

## Commits

IMPORTANT: overrides default commit behavior.

- Never commit without an explicit user instruction.
- Commit directly to the current branch — never create a new branch, even on `main` / the default branch.
- No Co-Authored-By or any attribution lines.
- Subject: short imperative, no period.

## Collaboration

- Ask clarifying questions if the task is ambiguous or underspecified before writing code.

## Communication style

Be concise.

During implementation: don't narrate reasoning, don't explain routine tool calls or obvious changes, no progress summaries unless something needs my attention. Prefer acting over explaining; keep intermediate messages to 1-2 sentences.

After a task, report only: what changed, tests/checks result, any important unresolved issue. No implementation walkthrough unless I ask.

## No visual verification

Never launch the dev server or drive a browser (Playwright etc.) to check UI changes — even when other guidance suggests it. Rely on unit tests and `tsc`/type checks. The user does visual checks themselves.

## Code exploration

Use `code-index` MCP tools first: `search_code_advanced`, `get_symbol_body`, `find_files`, `get_file_summary`. Fall back to Grep/Glob/Explore only if code-index can't answer, reports `needs_deep_index`, or the task is outside its capabilities.

## Debugging

- Prefix temporary diagnostic logs with `// DIAG` on the same line; remove all before committing (find via `// DIAG`).
- Use `diag_log!` (`maze-core/src/diag.rs`), never bare `println!` — `println!` is swallowed on `wasm32`; `diag_log!` prints to stdout natively and to the browser console when built for wasm:
  ```rust
  crate::diag_log!("value={x}"); // DIAG
  ```

## i18n (paraglide)

Compile from `maze-web`: `npx paraglide-js compile --project ./project.inlang --outdir ./generated/paraglide --output-structure locale-modules`.

**Always pass `--output-structure locale-modules`.** Without it the CLI defaults to `message-modules` (~1700+ files), making Vite dev-server start very slow. `locale-modules` produces ~10 files — sanity check: `find generated/paraglide -type f | wc -l` ≈ 10, not 1000+.

## Specs

`Specs/` — markdown descriptions of systems and data structures, authoritative source of intent. Check before implementing or modifying a feature.

## Integration tests (`maze-runner`)

`maze-runner` is a native-Rust crate (no wasm) that parses the same JSON config the browser sends and runs the full `build_maze` pipeline. Use it for all reproduction and regression tests.

**Workflow:**
1. Export config from the browser (debug toolbar → "Copy config JSON").
2. Save to `maze-runner/tests/fixtures/<name>.json`.
3. Copy `maze-runner/tests/repro.rs`'s template function, rename it, add assertions on `MazeRunResult`.

**Browser-repro tests: never hardcode generation params** — seed, tessellation, checks, strategies, repair limits all come from the fixture JSON, so the test reproduces exactly what the browser ran. Regular unit tests with hand-crafted mazes may hardcode params.

`MazeRunResult` fields: `remaining_issues`, `region_sizes` (`HashMap<RegionClass, Vec<usize>>` sorted desc), `start`, `finish`, `timing`, `graph` (final post-repair `Graph` — inspect edge kinds/directionality).

## Testing debug event logs (`EventLog`/`DebugTape`)

When instrumenting an algorithm with `EventLog` (see `Specs/event_log.md`), don't write one exact-sequence test per event variant — it breaks on every narration reword. Instead:

- **One** exact-sequence test on the smallest deterministic input (forces every branch via input shape, not seed luck) — asserts the full ordered payload list for a single scope.
- All other tests assert **invariants**, not exact payloads: mutating events match resulting graph state, tree nesting matches expected scope names, `is_mutating()` agrees with the mutating/trace split, `None` log doesn't change generation output. These survive narration rewording.
