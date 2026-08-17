# Checklist: Adding a New Check / Strategy / Rule Param

See `quality_control.md` for the system this checklist wires into (`IssueKind`, `Check<T, I>`, `RepairStrategy<T, I>`, `Rule<T, I>`).

Every id introduced here (check id, strategy id, rule-param id, and any new `IssueKind`) must be wired through several independent places by hand — nothing enforces this except `codegen`'s completeness check (see below), so treat this list as the actual contract.

## New `IssueKind` variant

Only if no existing kind fits — see `quality_control.md`'s "Hard rule: `IssueKind` is a semantic category, not a producer id."

1. Add the variant to `IssueKind` (`maze-core/src/quality_control/issue.rs`) — `as_str`/`from_str`/`Display` are **generated**, not hand-written (`codegen`'s `id_enum` module, GitHub issue #361): run `cargo run -p codegen` after adding the variant, do not hand-edit `issue_kind_ids.rs`.
2. Add the concrete `Issue` type in `quality_control::issue_kinds` (own module, `impl_issue!`, `IssueKindConst`, `IssueMerge`, `IssueRequirement`).
3. Add a payload-resolution arm in `issue_payload.rs` if the web UI needs structural data beyond `kind`/`source_checks`/`details` (see `IssuePayloadDto` in `quality-feature.md`).

## New Check

1. Implement `Check<T, I>` (own file under `quality_control/checks/`).
2. Register a `CheckDescriptor { id, label, description, issue_kinds, params, allow_multiple_instances }` in `maze-wasm/src/checks_catalog.rs`'s `available_checks_list()` — this is the single source of truth for the check's id and every param id it exposes.
3. Wire the check into `maze-runner`'s rule-building (`build_rule_for!`/check factory) so `config.checks` can select it.
4. Add `qualityI18n.ts` entries: `checkI18n[id]` (label/description), and a `DETAIL_LABELS`/`DETAIL_DESCRIPTIONS` entry in `issueRegistry.ts` if the check records `details` the UI should render as a specific sentence rather than the issue kind's generic label.
5. Add the corresponding `check.<id>.label`/`.description` (and any detail-label) keys to **both** `maze-web/messages/en.json` and `ru.json`.

## New Strategy

1. Implement `RepairStrategy<T, I>` (own file under `repair/strategies/`).
2. Register a `StrategyDescriptor { id, handles, params, experimental, nested_slots }` in `maze-wasm/src/strategies_catalog.rs`'s `available_strategies_list()`.
3. Add `qualityI18n.ts`'s `strategyI18n[id]` entry, plus `en.json`/`ru.json` keys.

## New rule-level param

Rare — only for a param several checks/strategies share, see `RuleParamDescriptor`.

1. Add to `RULE_PARAM_DESCRIPTORS` in `maze-core/src/quality_control/rule_params.rs`, listing every check/strategy id in `applies_to`.
2. Add `qualityI18n.ts`'s `paramI18n[id]` entry (or reuse an existing param id if it's the same concept), plus `en.json`/`ru.json` keys.

**Any new param id** (check, strategy, or rule-level) needs a `qualityI18n.ts`'s `paramI18n[id]` entry regardless of which of the above it came from — params are a flat, shared id space in the UI layer.

## Verification — run before considering the work done

```
cargo run -p codegen -- --check
```

This regenerates `maze-web/src/wasm/generated/issueKind.ts` and `maze-web/src/components/features/generated/qualityIds.ts` (both plain generated mirrors, never hand-edit), and diffs every check/strategy/rule-param/issue-kind/param id it finds in `maze-wasm`'s catalogs against `qualityI18n.ts`'s registries — a missing entry fails `--check` with the exact registry and id name. It does **not** catch a missing `en.json`/`ru.json` message key, a missing `DETAIL_LABELS` entry, or a missing `issueRegistry.ts`/`KNOWN_ISSUES` entry — those still need this checklist (see also `feedback_new_check_checklist` in this project's persistent memory for the same recurring gaps).

Instead of hand-typing every flagged `qualityI18n.ts` entry, run:

```
cargo run -p codegen -- --scaffold
```

This auto-appends a TODO-stub entry (`label: "TODO_<id>"`, `description: "TODO"`) to `qualityI18n.ts`'s `checkI18n`/`strategyI18n`/`issueI18n`/`paramI18n` for every id `find_missing` currently flags, plus matching `"<prefix>.<id>.label"`/`.description"` TODO placeholder keys in both `en.json` and `ru.json`. It only covers those four registries — `DETAIL_LABELS`, `issueRegistry.ts`, and any `cardLabel`/`short_label` override still need hand-editing per this checklist. Replace every `TODO_*`/`TODO` placeholder with real text before considering the work done.
