# Checklist: Adding a New Check / Strategy / Rule Param

See `quality_control.md` for the system this checklist wires into (`IssueKind`, `Check<T, I>`, `RepairStrategy<T, I>`, `Rule<T, I>`).

Every id introduced here (check id, strategy id, rule-param id, and any new `IssueKind`) must be wired through several independent places by hand — nothing enforces this except `codegen`'s completeness check (see below), so treat this list as the actual contract.

## New `IssueKind` variant

Only if no existing kind fits — see `quality_control.md`'s "Hard rule: `IssueKind` is a semantic category, not a producer id."

1. Add the variant to `IssueKind` (`maze-core/src/quality_control/issue.rs`) — `as_str`/`from_str`/`Display` are **generated**, not hand-written (`codegen`'s `id_enum` module, GitHub issue #361): run `cargo run -p codegen` after adding the variant, do not hand-edit `issue_kind_ids.rs`.
2. Add the concrete `Issue` type in `quality_control::issue_kinds` (own module, `impl_issue!`, `IssueKindConst`, `IssueMerge`, `IssueRequirement`).
3. Add a payload-resolution arm in `issue_payload.rs` if the web UI needs structural data beyond `kind`/`source_checks`/`details` (see `IssuePayloadDto` in `quality-feature.md`).

## New Check

0. Run `cargo run -p codegen -- --new-check <id>` to scaffold `checks/<id>.rs` (a `Check<T, I>`
   skeleton + matching test module) and get this checklist printed back with `<id>` substituted in.
   It also declares `pub mod <id>;` in `checks/mod.rs` — the `pub use` re-export (step 1b below)
   still needs to be added by hand, since what to re-export (the struct, plus any `_DEFAULT`
   constants) can't be inferred from the id alone. The scaffolded file references a
   `<PascalId>Issue` type that doesn't exist yet on purpose — pick an existing `IssueKind` or add a
   new one (see below) before it compiles. `--new-check`/`--new-strategy` must be run alone — not
   combined with `--check`, `--scaffold`, or each other; `codegen` rejects that combination instead
   of silently running only one of the requested actions.
1. Implement `Check<T, I>` (own file under `quality_control/checks/`).
2. Register a `CheckDescriptor { id, label, description, issue_kinds, params }` in `maze-wasm/src/checks_catalog.rs`'s `available_checks_list()` — this is the single source of truth for the check's id and every param id it exposes.
3. Wire the check into `maze-runner`'s rule-building: add its `type_id` to the matching `KindTag` entry's id list in `maze-runner/src/runner/qc_kind_registry.rs`'s `qc_kind_registry!` table (or add a new entry if it's a new `KindTag`) so `config.checks` can select it. This single table generates `KindTag`, `check_kind_for_type`, and `build_rule`'s dispatch together (GitHub issue #407) — before this, the three had to be hand-kept in sync separately, which is exactly the class of gap GitHub issue #405 hit.
4. Add `qualityI18n.ts` entries: `checkI18n[id]` (label/description). Also add a `DETAIL_LABELS`/`DETAIL_DESCRIPTIONS` entry in `issueRegistry.ts` if the check calls `.with_detail(...)` (see "New Check without details" below if it doesn't).
5. Add the corresponding `check.<id>.label`/`.description` (and any detail-label) keys to **both** `maze-web/messages/en.json` and `ru.json`.

### New Check without details

A check that never calls `.with_detail(...)` (a pure structural check — `MissingEndpointsCheck`, `UnreachableFinishCheck`, `TeleportDuplicatesConnectionCheck` are the current examples) has nothing for `DETAIL_LABELS`/`DETAIL_DESCRIPTIONS` to render, and the issue kind's generic `issue.<kind>.label`/`.description` already reads correctly for it. Add the check's id to `issueRegistry.ts`'s `NO_DETAIL_CHECKS` list instead of writing a `DETAIL_LABELS`/`DETAIL_DESCRIPTIONS` entry for it — `codegen --check`'s completeness diff excludes every id in that list.

`codegen` can't derive "does this check call `.with_detail`" itself: the call often lives in a shared check-core helper several files away from the concrete check (e.g. `region_size_check_core.rs`'s `build_issue`), with the detail key passed as a variable rather than a literal, so a text scan can't reliably trace it — `NO_DETAIL_CHECKS` is a hand-maintained, explicit statement of which checks are known to have nothing to render.

## New Strategy

0. Run `cargo run -p codegen -- --new-strategy <id>` to scaffold `strategies/<id>.rs` (a
   `RepairStrategy<T, I>` skeleton + matching test module) and get this checklist printed back with
   `<id>` substituted in. It also declares `pub mod <id>;` in `strategies/mod.rs` — the `pub use`
   re-export still needs to be added by hand. The scaffolded file's `apply()` is generic over a
   placeholder `TodoIssueType` on purpose — replace it with the concrete issue type this strategy
   repairs before it compiles.
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

This regenerates `maze-web/src/wasm/generated/issueKind.ts` and `maze-web/src/components/features/generated/qualityIds.ts` (both plain generated mirrors, never hand-edit), and diffs every check/strategy/rule-param/issue-kind/param id it finds in `maze-wasm`'s catalogs against three hand-written places, failing `--check` with the exact registry/file and id name on any gap:

- `qualityI18n.ts`'s `checkI18n`/`strategyI18n`/`issueI18n`/`paramI18n` registries.
- `issueRegistry.ts`'s `DETAIL_LABELS`/`DETAIL_DESCRIPTIONS` registries, diffed against every check id **except** ids listed in `NO_DETAIL_CHECKS` (see "New Check without details" above; GitHub issue #405).
- `maze-runner`'s `qc_kind_registry.rs`, specifically the `qc_kind_registry!` table invocation — a check id absent here can never be selected by `build_rule`'s factory (GitHub issue #405, closed via the unified registry in GitHub issue #407).

It does **not** catch a missing `en.json`/`ru.json` message key or a missing `issueRegistry.ts`/`KNOWN_ISSUES` entry — those still need this checklist (see also `feedback_new_check_checklist` in this project's persistent memory for the same recurring gaps).

Instead of hand-typing every flagged `qualityI18n.ts` entry, run:

```
cargo run -p codegen -- --scaffold
```

This auto-appends a TODO-stub entry (`label: "TODO_<id>"`, `description: "TODO"`) to `qualityI18n.ts`'s `checkI18n`/`strategyI18n`/`issueI18n`/`paramI18n` for every id `find_missing` currently flags, plus matching `"<prefix>.<id>.label"`/`.description"` TODO placeholder keys in both `en.json` and `ru.json`. It only covers those four registries — `DETAIL_LABELS`, `issueRegistry.ts`, and any `cardLabel`/`short_label` override still need hand-editing per this checklist. Replace every `TODO_*`/`TODO` placeholder with real text before considering the work done.
