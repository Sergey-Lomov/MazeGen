# CLAUDE.md

Guidance for Claude Code in this repository.

@AGENTS.md

Claude Code specifics below. Shared rules (language, commits, specs, testing, debugging, i18n, export, ...) live in `AGENTS.md`.

## Commits

IMPORTANT: the commit rules in `AGENTS.md` override Claude Code's default commit behavior, including its attribution guidance.

## Communication style

Be concise.

During implementation: don't narrate reasoning, don't explain routine tool calls or obvious changes, no progress summaries unless something needs my attention. Prefer acting over explaining; keep intermediate messages to 1-2 sentences.

After a task, report only: what changed, tests/checks result, any important unresolved issue. No implementation walkthrough unless I ask.

## Code exploration

Use `code-index` MCP tools first: `search_code_advanced`, `get_symbol_body`, `find_files`, `get_file_summary`. Fall back to Grep/Glob/Explore only if code-index can't answer, reports `needs_deep_index`, or the task is outside its capabilities.
