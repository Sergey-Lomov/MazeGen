# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project

A **maze editor and generator** with a Rust core (`maze-core`). Workspace structure — more crates may be added.

## Languages

- Converse with the user in the user's language
- Plans and all responses in the user's language
- General terms in the user's language, specific technologies in English (e.g. `Result`, `impl`, `trait` stay as-is)
- All file contents (code, comments, docs, specs) in English only
- Commit messages in English only

## Commits

IMPORTANT: These rules override the default commit behavior.

- **Never commit without an explicit user instruction**
- **No Co-Authored-By lines** — never add authorship attribution of any kind
- Subject line: short imperative, no period

## Collaboration

- Always ask clarifying questions if anything in the task is ambiguous or underspecified before writing code

## No visual verification

**Never** launch the dev server / drive a browser (Playwright etc.) to visually check UI changes — not even when general guidance elsewhere suggests it. Rely on unit tests and `tsc`/type checks instead. If the user wants a visual check, they'll do it themselves.

## Code exploration

DEFAULT RULE

For code exploration, use `code-index` MCP tools first.

Preferred tools:

- search_code_advanced
- get_symbol_body
- find_files
- get_file_summary

Use Grep/Glob/Explore only if:

- code-index cannot answer the query;
- code-index reports `needs_deep_index`;
- the task is clearly outside code-index's capabilities.

## Debugging

- Temporary diagnostic logs must be prefixed with `// DIAG` comment on the same line
- Use the `diag_log!` macro (`maze-core/src/diag.rs`), never bare `println!` — `println!` is silently swallowed on `wasm32` (no stdout in the browser); `diag_log!` prints to stdout natively and to the browser console (`console.log` via `web_sys`) when built for wasm:
  ```rust
  crate::diag_log!("value={x}"); // DIAG
  ```
- To find all diagnostic logs: search for `// DIAG`
- Remove all `// DIAG` logs before committing

## Specs

`Specs/` — markdown descriptions of systems and data structures, authoritative source of intent. Check before implementing or modifying a feature.

## Integration tests (`maze-runner`)

`maze-runner` is a native-Rust crate (no wasm) that parses the same JSON config the browser sends and runs the full `build_maze` pipeline. Use it for all reproduction and regression tests.

**Workflow:**
1. Export config from the browser (debug toolbar → "Copy config JSON")
2. Save to `maze-runner/tests/fixtures/<name>.json`
3. Copy `maze-runner/tests/repro.rs`'s template function, rename it, add assertions on `MazeRunResult`

**For browser-repro tests: never hardcode generation params** — seed, tessellation, checks, strategies, repair limits all come from the fixture JSON. This guarantees the test reproduces exactly what the browser ran. Regular unit tests with hand-crafted mazes may hardcode params as usual.

`MazeRunResult` fields: `remaining_issues`, `region_sizes` (`HashMap<RegionClass, Vec<usize>>` sorted desc), `start`, `finish`, `timing`, `graph` (final post-repair `Graph` — inspect edge kinds/directionality).

## Testing debug event logs (`EventLog`/`DebugTape`)

When instrumenting an algorithm with `EventLog` (see `Specs/event_log.md`), don't write one exact-sequence test per event variant — that's a maintenance burden that breaks on every narration wording change. Instead:

- **One** exact-sequence test on the smallest possible deterministic input (forces every branch via input shape, not luck of the seed) — asserts the full ordered payload list for a single scope, pinning down real values and order once.
- Remaining tests assert **invariants**, not exact payloads: mutating events match the resulting graph state, tree nesting matches expected scope names, `is_mutating()` agrees with the mutating/trace split, `None` log doesn't change generation output. These survive narration rewording.
