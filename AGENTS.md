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
