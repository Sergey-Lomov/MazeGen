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

## Debugging

- Temporary diagnostic logs must be prefixed with `// DIAG` comment on the same line:
  ```rust
  println!("value={x}"); // DIAG
  ```
- To find all diagnostic logs: search for `// DIAG`
- Remove all `// DIAG` logs before committing

## Specs

`Specs/` — markdown descriptions of systems and data structures, authoritative source of intent. Check before implementing or modifying a feature.
