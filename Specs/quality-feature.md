# Quality Feature

The Quality feature manages active checks, their **rules** (the unit a fix strategy attaches to), and fix strategies. When opened, it replaces the canvas with a full-screen two-column UI plus a detail panel (`QualityCanvas`). When closed, the Pixi canvas is restored.

## Feature Card Status

| Condition | Status |
|-----------|--------|
| 0 active checks | `warning` (yellow) |
| ≥1 active checks | `set` (green) |

Subtitle: `"N check(s) active"`.

The card body (`QualityFeature` component) renders a status hint only when the panel is **closed**. When `qualityOpen` is true, `QualityFeature` returns `null`.

## Canvas lifecycle

`qualityOpen` is derived in `App.tsx` as `openCard === "quality"`, not its own store field — opening Quality means calling `setOpenCard("quality")` (the same action every feature card uses to become the active card). `App.tsx` hides the Pixi canvas (`display: none`) and renders `<QualityCanvas />` in its place when `qualityOpen` is true. `MazeScene` subscribes to `qualityOpen` and stops the Pixi ticker when open, restarts it when closed.

## What a rule is

A **rule** (`QcRuleState` in the store) is a user-defined, non-empty-or-empty set of active checks that share one `IssueKind` and one fix strategy. Rules are the feature's central concept — `Issue`/`IssueKind` are internal QC plumbing and never surfaced as their own selectable entity (see `quality_control.md`'s "IssueKind is a semantic category, not a producer id" rule and "`Issue` is an internal-only QC artifact").

Unlike the older one-strategy-per-kind design, **two checks producing the same `IssueKind` no longer have to share a strategy** — each can live in its own rule with its own strategy (e.g. `min_loop_length` repaired by `invalid_loop_random`, `max_loop_length` repaired by `invalid_loop_scored`, both `INVALID_LOOP`). Splitting or merging checks into rules is an explicit user action (see "Rule actions" below), not automatic deduplication by kind.

```typescript
interface CheckInstance {
  localId: number;               // unique only within this rule's `checks`, not globally
  typeId: string;                // check type id (CheckDescriptor.id)
  params: Record<string, string>; // this instance's own param overrides
  disabled: boolean;             // per-check toggle, see below
}

interface QcRuleState {
  id: string;            // opaque, client-generated (rule_${counter}); not derived from `checks`
  name: string;          // user-facing, defaults to the issue kind's own label (resolveIssueLabel), editable
  kind: string;          // IssueKind shared by all member checks, captured at creation time
  checks: CheckInstance[]; // member check instances — can be empty (see below)
  nextLocalCheckId: number; // monotonic per-rule counter minting new CheckInstance.localId — never reused
  strategyId: string | null;
  disabled: boolean;     // strategy-only toggle, see below
  ruleDisabled: boolean; // whole-rule toggle, see below
  collapsed: boolean;    // UI-only card collapse state, see below
}
```

A check only ever exists inside exactly one rule's `checks` — there is no separate flat "active
checks" list or global per-check-type params dict (the old `selectedChecks: string[]` and
`checkParams: Record<typeId, Record<paramId, string>>` were removed; see GitHub issue #60).
Wherever the old flat "which check types are active" list is needed, it's derived inline as
`rules.flatMap(r => r.checks)` (UI filters, analytics, `buildGenerateConfig`), not cached as its
own field.

**Most check types still allow only one active instance at a time, across all rules** —
`CheckDescriptor.allow_multiple_instances` (see `quality_control.md`) gates this per type, and is
`true` only for `min_region_count`. Two or more independent instances of `min_region_count` —
each with its own `region_class`/`count` — is the one supported case (the motivating scenario
for #60: "at least 2 trap regions" and separately "at least 2 alternative regions" at once).
Enforced in `addCheck`/`createRule` (see below — both silently drop/no-op a duplicate of a
single-instance type rather than erroring) and mirrored in candidate filtering
(`RulesColumn.candidatesFor`, `CheckSelectDialog`) so the UI doesn't even offer an already-active
single-instance type as addable.

- `kind` is captured once at rule creation and kept on the rule itself (not derived from `checks[0]`) so it survives `checks` becoming empty.
- A rule's `checks` **can become empty** — e.g. after removing its last member via the check row's own `✖` (not via `removeCheckFromRule`, which moves the check elsewhere instead of leaving it homeless). An empty rule is not auto-dropped: it stays as a card with `strategyId`/`kind` intact so the user can repopulate it via the rule's own `+ Add check`.
- The card title shows `"{name} ({kind label})"` — `kind label` (`resolveIssueLabel(kind)`) is the rule's fixed, non-renamable, translatable title carrying the semantic context (e.g. "Teleport validation"); `name` is the free-text, user-editable label, defaulting to `kind label` itself at creation (`defaultRuleName`, `generationSliceHelpers.ts`). Shown unconditionally (not only for an empty rule) so a check's own label is never seen without its owning rule's context — the audit basis check labels below were trimmed against (GitHub issue #176) — except the `(kind label)` suffix is omitted when it's identical to `name` (the common un-renamed case), to avoid a literal `"Endpoint presence (Endpoint presence)"`-style duplication.
- `disabled` (strategy-only toggle) vs `ruleDisabled` (whole-rule toggle) are independent: `disabled` skips the fix but the rule's checks still run (QC still reports the issue, just unfixed); `ruleDisabled` excludes the rule's checks from generation entirely, as if never selected.
- `CheckInstance.disabled` — a per-check toggle, independent of `disabled`/`ruleDisabled` above. A disabled check is excluded entirely from the next `generate()` call (dropped from its rule's `checks` before crossing the wasm boundary — see "Generate pipeline" below), as if it were never added to the rule, mirroring `ruleDisabled`'s effect at check granularity. Unlike `ruleDisabled`, it still counts as "active" for `isTypeAlreadyActive`'s single-instance-per-type gating (`addCheck`/`createRule` above) — re-enabling the existing disabled instance is the way back to using that type again, not adding a second one. If disabling a check leaves its rule with zero *effective* (non-disabled) checks, that rule itself is omitted from `GenerateConfig` the same way a `ruleDisabled` rule is — core's `build_qc_and_repair` rejects a rule with an empty `checks` array outright.
- `nextLocalCheckId` starts at the rule's initial check count, increments on every check added to this rule, and never resets or reuses a previously-issued `localId` even after that check is removed — addressing a check is always the pair `(ruleId, localId)`, never a bare `localId` searched across all rules. Not serialized to project files (see "Project file persistence" below) — recomputed on load as `max(checks.map(c => c.localId)) + 1` (or `0` if `checks` is empty).
- `collapsed` (GitHub issue #320) — UI-only card collapse state, toggled via `toggleRuleCollapsed`. When `true`, `RulesColumn` hides the whole card body (checks list, `RuleParamsSection`, and `RuleStrategyPanel`), showing only the title row. Purely cosmetic — has no effect on `GenerateConfig` or any other generation-facing behavior, unlike `disabled`/`ruleDisabled` above. Still serialized to project files (see "Project file persistence" below) since it's part of the rule's own persisted UI state, defaulting to `false` for files saved before it existed.

## What a stage is

See GitHub issue #65. A **stage** (`RepairStageState` in the store) is a named, ordered group of rule ids — repair dispatches one stage at a time, in `state.stages` array order, so a rule needing another rule's fix as a precondition can be placed in a later stage than the rule providing it (see `Specs/repair.md`'s "Stages" section for the core-side dispatch semantics). Rule membership lives on the stage (`ruleIds`), not as a field on `QcRuleState` — a rule doesn't know which stage it belongs to; the store answers that by scanning `state.stages` for the rule's id.

```typescript
interface RepairStageState {
  id: string;       // opaque, client-generated (stage_${uuid})
  name: string;      // user-facing; the very first stage defaults to "Waypoints"
                      // (quality.default_stage_name), later stages to "Stage N" at creation time — editable
  ruleIds: string[]; // order = dispatch order within this stage AND UI/serialization order
  disabled: boolean; // whole-stage toggle — see below
  collapsed: boolean; // UI-only section collapse state — see below
}
```

- **No minimum stage count.** `state.stages` can become empty (e.g. after removing every stage) — there is no "at least one stage" invariant. A rule-creating action needing a stage to put its new rule in (`addCheck`'s singleton path, `createRule`, `removeCheckFromRule`'s new-singleton path) creates a fresh one on demand if `state.stages` is currently empty; otherwise it appends to the *last* stage (or a caller-specified target stage — see `createRule`'s `targetStageId` below) — the user reorganizes stages manually afterward.
- A rule can be in **at most one** stage's `ruleIds` at a time — `moveRule` (below) is the only action that relocates a rule between stages; every other rule-removing action (`removeRule`) scrubs the id from whichever stage held it.
- A stage's `ruleIds` **can be empty** (e.g. `addStage()`, or after `moveRule` moves its last rule out) — this is a normal, permanent state, not auto-cleaned-up. `RulesColumn` renders an empty stage as a visible section with a hint (`status.stage_empty`) rather than hiding it, since it's still a valid drop target for `moveRule`.
- **`disabled`** — a whole-stage toggle, independent of any member rule's own `ruleDisabled`. A `disabled` stage is omitted entirely from `GenerateConfig.stages` (not sent with an empty `rules: []`), as if the stage didn't exist for this run — see `toggleStageDisabled` and "Generate pipeline" below.
- `GenerateConfig.stages` (see `quality_control.md`'s `StageConfig`) is built from `state.stages` by `buildGenerateConfig` — `ruleDisabled` filtering happens per-stage there, before any config crosses the wasm boundary (see "Generate pipeline" below), not by sending a disabled rule through as `strategy: null`.
- **`collapsed`** (GitHub issue #320) — UI-only section collapse state, toggled via `toggleStageCollapsed`. When `true`, `RulesColumn` hides the stage's entire `stageCards` block (every member rule card), showing only the stage header/toolbar. Independent of `disabled` and purely cosmetic — no effect on `GenerateConfig`. Both this and rule-level `collapsed` (see "What a rule is" above) share one small `CollapseButton` component (`maze-web/src/components/CollapseButton.tsx`) for the chevron toggle itself, since the two sites are otherwise identical (chevron + collapse/expand title + onToggle). Still serialized to project files, defaulting to `false` for files saved before it existed.

## QualityCanvas layout

Two columns + detail panel, full height, flex row:

```
[ Rules flex ] | [ Detail ~28% ]
```

Divider: `1px solid colors.borderMid`. Background: `colors.bgApp`.

There is no separate "Checks" column — each rule card shows its own member checks inline (left half) next to its strategy (right half), so a check is always seen in the context of the rule it belongs to.

### Rules column (`RulesColumn`)

One card per rule (`slots: StrategySlotVM[]`, one entry per rule in the store, not deduplicated by kind). Each card is split left/right:

- **Left half — checks list** (`RuleCheckRow`, one per member check instance): label, a `Switch` toggle bound to `CheckInstance.disabled` (see "What a rule is" above — dims the row and its params, and disables their controls, while off), params shown always-expanded directly under the row (mirrors the strategy half's param layout — see below), `✖` remove button (calls `removeCheck(ruleId, localId)`, which deletes this `CheckInstance` from the rule's `checks`). Below the member checks: a `+ Add check` row — opens `AddCheckToRuleDialog` listing this rule's `kind`'s check descriptors via `RulesColumn.candidatesFor` (see "AddCheckToRuleDialog" below for which types are offered); if `candidatesFor` returns empty, opens an `AlertModal` instead (`quality.no_checks_for_kind`).
- **Right half — strategy panel** (`RuleStrategyPanel`): strategy label (or `strategy.no_fix.label` if `strategyId` is null), a `WarningIcon` (⚠, shared component) next to the label when `strategy.experimental` is true, its params shown always-expanded underneath (same layout as the checks side), a `Switch` toggle (visible only when a strategy is set) bound to `disabled`, and a `✎` edit button opening `StrategySelectDialog`.
- **Card title row**: rule name (or inline rename input), a `Switch` bound to `ruleDisabled`, `✎` rename button, `✖` remove button (opens a `ConfirmModal` before calling `removeRule`, since it deletes member checks too).

Split rather than stacked so disabling/configuring the fix reads as independent from the checks — the checks still run regardless of whether their rule's fix is enabled.

Below all rule cards: a single `Add new rule` button (no `+` prefix) — opens a three-step flow: `IssueSelectDialog` (pick an issue kind) → `CheckSelectDialog` filtered to that kind (multiselect via per-row checkboxes) → `NewRuleStrategyDialog` (pick a fix strategy, skipped when no strategy handles the kind). Nothing commits to the store until the flow finishes — see `createRule` below. This always creates one **new** rule (never merges into an existing rule — that's `AddCheckToRuleDialog`'s job instead).

Empty state (no rules at all): hint text `status.no_checks`.

### Inline param editing

Both `RuleCheckRow` and `RuleStrategyPanel` run their own `useParamEditor` instance (debounced commit, ~300ms) and must flush it (`flushRef.current()`) before any action that could discard the maze state's column-of-truth or unmount the row — selecting a different row/rule in the detail panel, removing the check, toggling the strategy's disabled switch, or opening the edit dialog. `QualityCanvas`'s own `flushRef` (see "ViewModel" below) only covers `QualityDetailPanel`'s editor; the inline editors flush themselves locally at their own action sites, not through that shared ref.

### Detail panel

Shows details for the current selection:

| Selection | Content |
|-----------|---------|
| None | Empty hint `quality.select_to_view` |
| Check | Label, description, param fields (via `useParamEditor`, through `ParamizedDetail`) |
| Strategy | Label, description, param fields (via `useParamEditor`, through `ParamizedDetail`) |
| `"no_fix"` ("logging") | Static label/description for `strategy.no_fix` — no param fields, since there's no strategy instance to configure |

`QualitySelection` (the union type driving this):

```typescript
type QualitySelection =
  | { type: "check"; id: string }
  | { type: "strategy"; ruleId: string; strategyId: string }
  | { type: "logging"; ruleId: string }
  | { type: "nested_strategy"; ruleId: string; path: PathSegment[] }
  | null;
```

`nested_strategy` selects one nested-strategy entry, anywhere in the nesting chain under a rule's top-level strategy — see "Nested strategies (UI)" below for `PathSegment` and how the detail panel renders this case (same `ParamizedDetail` machinery as `strategy`, plus that entry's own further-nested slots).

`QualityCanvas` holds a `flushRef` it passes into `QualityDetailPanel` (via `ParamizedDetail`) and calls before every selection change, so an in-flight debounced edit in the detail panel is never lost when switching selection. This is separate from — and does not cover — the inline editors in `RuleCheckRow`/`RuleStrategyPanel` (see above).

### Nested strategies (UI)

Files: `maze-web/src/components/features/quality/NestedStrategyPanel.tsx`,
`NestedStrategySelectDialog.tsx`. Mirrors `maze-core`'s nested-strategy mechanism (see
`Specs/repair.md`'s "Nested strategies" and "Weighted nested dispatch" sections) — a strategy can
declare `nested_slots: NestedSlotDescriptor[]` (`{ slot_id, kind, min, max }`, `max: null` = no
upper bound), and the UI lets the user fill each slot with one or more nested strategy
assignments.

**Addressing (`PathSegment`)**: a nested-strategy tree position is a `{ slotId: string; index: number }[]`
chain, not a bare `slotId[]` chain — `slotId` alone is not a unique key once a slot's `max` allows
more than one entry (see `weighted_region_merge`'s `merge_target` slot, GitHub issue #90).
`index` is the entry's position among *siblings sharing that `slotId`* specifically
(`entriesForSlot(list, slotId)[index]`, `maze-web/src/store/storeTypes.ts`), not a position in the
whole (possibly mixed-slot) list. `path[0]` resolves against the rule's own top-level strategy's
`nestedStrategies`; `path[1]` resolves against *that* entry's own `nested`, and so on. `NestedSlotVM`/
`NestedStrategyVM` (`useQualityViewModel.ts`) are the view-model side of `NestedSlotDescriptor`/
`NestedStrategyState`, resolved the same way `StrategySlotVM.strategy` resolves `QcRuleState.strategyId`.

**`NestedStrategyPanel`** renders one slot: every currently-filling entry, plus a `+ {label}` add
row when the slot isn't at its `max` capacity yet (hidden once full for the overwhelming majority
of slots, which are capped at 1). Rendered recursively — once from `RuleStrategyPanel` (rule
card) for the top-level strategy's own slots, and again inside `QualityDetailPanel` (detail panel)
for whichever nested entry is currently selected, so the same slot's entries can appear
simultaneously in the card and in the detail panel, kept in sync by the shared store.

Each entry (`NestedStrategyEntryRow`) renders up to three stacked rows:

1. **Weight row** — shown only when the slot allows more than one entry (`max === null ||
   max > 1`); a single-candidate slot has nothing to weigh against, so this row is omitted
   entirely. `"Weight"` label, a text input bound to `param_overrides["weight"]` (defaulting to
   `"1"` when unset), a live-computed `N%` share of this entry's weight among all its slot
   siblings (rounded down; `null`/hidden when the weight row itself is hidden), and a remove
   button. The percent uses the same fallback-to-`1` parsing as `maze-core`'s `resolve_weight`
   (`weighted_region_merge.rs`) — see `resolveWeight` in `NestedStrategyPanel.tsx` — so the
   displayed share always matches what `dispatch_weighted` will actually do at generation time.
   A thin vertical line down the left, starting just below this row, visually ties the weight to
   the rest of this entry's block underneath it.
2. **Strategy row** — `"Merge strategy"` label, the assigned strategy's name, a `WarningIcon` when
   experimental, and a `✎` edit button opening `NestedStrategySelectDialog`. When the weight row
   is hidden (single-candidate slot), the remove button lives here instead.
3. **Params / further-nested slots** — the assigned strategy's own param fields (`ParamFields`),
   and, if it itself declares nested slots, one more `NestedStrategyPanel` per such slot,
   recursively, up to `MAX_NESTED_STRATEGY_DEPTH`.

Hovering or clicking anywhere in rows 2–3 (the strategy row and everything under it, not just the
strategy's name) highlights/selects that entry — `onSelect({ type: "nested_strategy", ruleId,
path })`. Clicks on an actual control inside the params block (`input`/`select`/the `Switch`
wrapper — `ParamFields` stops propagation only on those, not on labels or empty space around
them) do not trigger this selection, so editing a param never re-selects/re-scrolls the detail
panel.

**`NestedStrategySelectDialog`** — same `ItemSelectDialog` shape as `StrategySelectDialog`, minus
the `no_fix` entry (a nested slot always needs an actual strategy). Candidates are strategies
where `handles === slotKind`. Selecting a different strategy than the one already assigned calls
`setNestedStrategy(ruleId, path, selectedId)`, which also resets that entry's `params` to fresh
defaults (see `setNestedStrategy` below) — any params edited for a not-yet-committed candidate in
this dialog are staged locally and flushed into the store right after, discarded on Cancel.

**Store actions** (`maze-web/src/store/slices/generationSlice.ts`):

```typescript
setNestedStrategy(ruleId: string, path: PathSegment[], strategyId: string | null): void
setNestedStrategyParam(ruleId: string, path: PathSegment[], paramId: string, value: string): void
addNestedStrategy(ruleId: string, path: PathSegment[], slotKind: string): void
removeNestedStrategy(ruleId: string, path: PathSegment[]): void
```

- `setNestedStrategy`: replaces (or clears, if `strategyId` is `null`) the entry at `path` in
  place — never appends. Replacing rebuilds `params` from the new strategy's declared defaults
  (`defaultParamsFor`) and auto-fills that strategy's own mandatory nested slots
  (`buildDefaultNestedStrategies`), discarding whatever was there before. A no-op if `path`
  doesn't resolve to an existing entry (stale path — e.g. the entry was removed elsewhere in the
  same render).
- `setNestedStrategyParam`: updates one param on the entry at `path`. `param_overrides["weight"]`
  (`NESTED_STRATEGY_WEIGHT_PARAM_ID` in `generationSlice.ts`) is set through this same action —
  weight is not a declared `StrategyParam` of the nested strategy itself (it's the dispatcher's
  own convention, see `Specs/repair.md`), so it's forwarded to the generate-config unconditionally
  by `nestedToConfig`, bypassing the normal "only descriptor-known param ids" filter that applies
  to every other param.
- `addNestedStrategy`: appends a fresh entry (defaulted to the first available strategy handling
  `slotKind`) after every existing sibling sharing `path`'s last segment's `slotId` — that
  segment's own `index` is ignored (ambiguous for an append). Callers (the `+` row) are
  responsible for not calling this past the slot's own `max`; the action itself doesn't enforce a
  cap. No-op if no strategy in the registry handles `slotKind`.
- `removeNestedStrategy`: removes the entry at `path` outright — every later sibling sharing that
  `slotId` shifts down one `index`, since `index` is a list position, not a stable id. Distinct
  from `setNestedStrategy(path, null)`, which is reserved for clearing a single-entry (`min: 0`)
  slot back to "unset" rather than shrinking a multi-entry list.

**Project file round-trip**: `NestedStrategyState`/`ProjectFileNestedStrategy`
(`maze-web/src/store/projectExport/types.ts`) share the same shape 1:1 — serialization is a
straight pass-through (no per-entry transform needed), and multiple entries sharing a `slotId`
serialize/deserialize as independent array elements, no different from single-entry slots.
`validateNestedStrategy` recursion is `MAX_NESTED_STRATEGY_DEPTH`-guarded, since a loaded project
file is the one nested-strategy recursion that crosses a real trust boundary (arbitrary data from
disk, not web-UI-generated state).

## IssueSelectDialog ("Add new rule", step 1)

Modal using `ItemSelectDialog`. Lists distinct issue kinds — `Array.from(new Set(availableChecks.map(c => c.issue_kinds[0])))` — not a separate `IssueVM` in the ViewModel, just derived inline (see "no `IssueVM`" note below). Title `quality.select_issue_title` ("Select rule") — despite the `kind`/issue plumbing, labels and descriptions (`issueI18n`) are worded as rule descriptions (e.g. "Loop validation", "Checks loops against configured criteria...") rather than problem descriptions, since this list is the user-facing "what kind of rule do I want" picker.

- Right panel: issue label + description (`resolveIssueLabel`/`resolveIssueDescription`).
- Footer: `[Cancel]` `[Select]`.
- Select: closes this dialog and opens `CheckSelectDialog` with the chosen `kind`, not `addCheck` — no store mutation happens at this step.

## CheckSelectDialog ("Add new rule", step 2)

Modal using `ItemSelectDialog` in single-select mode (row click selects and previews), takes a required `kind` prop from step 1. Shows available checks of that kind only.

- A check type with `allow_multiple_instances` (currently only `min_region_count`, see GitHub issue #60) can always be selected, including one already active elsewhere. Every other type: row disabled, red error text `check.already_active` shown in right panel when previewed, once it's already active in some existing rule.
- Right panel (for the selected row): check label, description, params (edited locally in this dialog's own state — `paramOverrides` — nothing commits to the store here).
- Footer: `[Back]` (returns to `IssueSelectDialog`) `[Cancel]` `[Next]` (disabled when no check is selected or the selected one is already active elsewhere).
- Next: calls `onNext(id, paramOverrides)` — hands the picked id to step 3, no store mutation.

## NewRuleStrategyDialog ("Add new rule", step 3)

Modal using `ItemSelectDialog`, takes a required `kind` prop. Shows `no_fix` plus strategies where `handles === kind` — same candidate filter as `StrategySelectDialog`, but this dialog targets no existing rule (nothing in the store yet) and stages strategy params locally instead of writing through `setStrategyParam`.

- This step is skipped entirely (by `RulesColumn`, before opening it) when `availableStrategies` has no entry with `handles === kind` — the rule is created directly with `strategyId: null`.
- Item list: each candidate whose `experimental` is true shows a `WarningIcon` (⚠) after its label — see "Experimental strategies" below.
- Right panel: strategy description + a `WarningBubble` when the selected strategy's `experimental` is true + param fields (local state, not `useParamEditor`).
- Footer: `[Back]` (returns to `CheckSelectDialog`, step 2) `[Cancel]` `[Add]`.
- Add: calls `onConfirm(strategyId, params)` (`strategyId` is `null` for `no_fix`) — `RulesColumn` then calls `createRule(checkIds, strategyId, checkParamOverrides, strategyParams)` to commit the whole rule atomically, closes the flow.

## AddCheckToRuleDialog ("+ Add check" inside a rule card)

Modal using `ItemSelectDialog`, targets one specific existing rule (`ruleId`, `kind` props). Title: `quality.add_check_dialog_title` ("Add check: {issue}"), where `{issue}` is the rule's kind, localized via `resolveIssueLabel`.

- Candidates: check descriptors sharing the rule's `kind`, computed by `RulesColumn.candidatesFor` (type `CheckCandidateVM[]` — `{ typeId, label, description, params }`, distinct from `CheckVM` — a candidate isn't an active instance yet, so it has no `ruleId`/`localId`). A type with `allow_multiple_instances` (currently only `min_region_count`, see GitHub issue #60) is always offered, including one already active elsewhere or in this same rule. Every other type is filtered out once already active anywhere (adding it would be a no-op in the store anyway).
- Right panel: check label, description.
- Footer: `[Cancel]` `[Add]`.
- Add: calls `addCheck(typeId, ruleId)` — mints a fresh `CheckInstance` directly into the target rule's `checks` array, not as a new rule (see `addCheck`'s `ruleId` parameter below). Closes.
- If `candidatesFor` returns empty when the row is clicked (no check descriptor at all handles this `kind`), this dialog never opens — an `AlertModal` (`quality.no_checks_for_kind`) shows instead.

## StrategySelectDialog

Modal using `ItemSelectDialog`. Targets one rule (`ruleId`, `kind` props). Shows strategies where `handles === kind`, plus `NO_FIX_STRATEGY_ID` ("no_fix") as the first item.

- Selecting `no_fix` calls `clearStrategy(ruleId)` → sets the rule's `strategyId` to `null` and `disabled` to `false`.
- Selecting a real strategy calls `setStrategy(ruleId, strategyId)`.
- Item list: same `WarningIcon` badge on experimental candidates as `NewRuleStrategyDialog` above.
- Right panel: strategy description + a `WarningBubble` when the selected strategy is experimental + param fields (via `useParamEditor` inside `StrategyParamPanel`).
- Footer: `[Cancel]` `[Select]`.

## Experimental strategies

`StrategyDescriptor.experimental` (see `maze-wasm/Specs/api.md`, backed by `RepairStrategy::is_experimental` in `maze-core`, see `Specs/repair.md`) flags a strategy whose results or performance may be unpredictable — currently only `missing_regions`. Three UI surfaces read it, all via the shared `WarningIcon`/`WarningBubble` components (`maze-web/src/components/WarningIcon.tsx`, `WarningBubble.tsx`), both rendering the same fixed `strategy.experimental_warning` message:

- `StrategySelectDialog` / `NewRuleStrategyDialog`: `WarningIcon` next to each experimental candidate's label in the item list; `WarningBubble` under the description in the right panel when the selected candidate is experimental.
- `RuleStrategyPanel` (rule card, right half): `WarningIcon` next to the assigned strategy's label.
- `QualityDetailPanel` → `ParamizedDetail`: `WarningBubble` under the description when the selected strategy is experimental.

## ViewModel: useQualityViewModel

File: `maze-web/src/components/features/useQualityViewModel.ts`

Computed via `useMemo` from store state:

```ts
interface QualityViewModel {
  checks: CheckVM[];                // every active check instance, across all rules
  stages: QualityStageVM[];         // rule cards grouped by stage, in state.stages order — RulesColumn's source of truth
  strategySlots: StrategySlotVM[];  // stages.flatMap(s => s.slots) — one per rule in the store
}

interface QualityStageVM {
  stageId: string;
  name: string;
  slots: StrategySlotVM[];
  disabled: boolean;                // whole-stage toggle
  collapsed: boolean;               // UI-only section collapse state, mirrors RepairStageState.collapsed
}

interface CheckVM {
  id: string;        // composite id, compositeCheckId(ruleId, localId) — React key/selection only, opaque, never parsed
  ruleId: string;
  localId: number;
  typeId: string;
  label: string;
  description: string;
  params: ParamDescriptor[];
}
interface StrategySlotVM {
  ruleId: string;          // join key with the store's `rules` and ruleId-keyed actions below
  name: string;            // rule's user-facing name
  kind: string;            // rule's captured IssueKind
  label: string;           // resolveIssueLabel(kind) — shown for an empty rule's card title
  strategy: StrategyVM | null;
  disabled: boolean;
  ruleDisabled: boolean;
  producedBy: CheckVM[];    // this rule's member check instances, resolved to full CheckVMs
  nestedStrategies: NestedStrategyVM[]; // resolved nested-strategy entries for strategy's nested slots — see "Nested strategies (UI)" above
  collapsed: boolean;       // UI-only card collapse state, mirrors QcRuleState.collapsed
}
interface StrategyVM {
  id: string; label: string; handles: string; params: ParamDescriptor[]; experimental: boolean;
  nestedSlots: NestedSlotVM[]; // nested-strategy slots this strategy accepts, if any
}
interface NestedSlotVM { slotId: string; kind: string; min: number; max: number | null }
interface NestedStrategyVM { slotId: string; strategy: StrategyVM; params: ParamDescriptor[]; nested: NestedStrategyVM[] }
```

`compositeCheckId(ruleId, localId)` (exported from `useQualityViewModel.ts`) is the single point
of generation for `CheckVM.id` on the web side — mirrors the wasm-side `composite_check_id` in
`runner.rs` (same `${ruleId}:${localId}` format), used here purely as a React key/selection
identifier, never parsed back apart, never shown to the user. Any store action addressing a
specific check uses the `(ruleId, localId)` pair directly (see "Store" below), not this id.

`strategySlots` is built **one entry per rule** in `state.rules` — not deduplicated or grouped by kind. `kind` (on `StrategySlotVM`) is the join key with `availableStrategies[].handles` and what `StrategySelectDialog`/`AddCheckToRuleDialog`'s candidate filters use. `kind` is read directly from the rule's own `kind` field (captured at creation, see "What a rule is" above), not derived from `producedBy[0]` — so it survives `producedBy` becoming empty.

`checks` (top-level) is `strategySlots.flatMap(slot => slot.producedBy)` — there is no separate derivation from a flat `selectedChecks` list (removed, see "What a rule is" above).

There is no `IssueVM`/`issues` list in this ViewModel — see "What a rule is" above for why issues aren't surfaced as their own UI entity.

All labels/descriptions pass through i18n resolvers. Param labels are localized via `resolveParamLabel`.

## i18n: qualityI18n.ts

File: `maze-web/src/components/features/qualityI18n.ts`

WASM descriptors have English-hardcoded labels. The web client overrides them via static lookup tables (Paraglide does not support dynamic bracket access `m[key]`):

- `checkI18n` — `check.{id}.label` / `check.{id}.description`
- `issueI18n` — `issue.{kind}.label` / `issue.{kind}.description`
- `strategyI18n` — `strategy.{id}.label` / `strategy.{id}.description` (includes `no_fix`)
- `paramI18n` — `param.{id}.label`

Resolver functions with fallback to raw WASM string:
- `resolveCheckLabel(id, fallback)`, `resolveCheckDescription(id, fallback)`
- `resolveIssueLabel(kind)`, `resolveIssueDescription(kind)`
- `resolveStrategyLabel(id)`, `resolveStrategyDescription(id)`
- `resolveParamLabel(id, fallback)`

`NO_FIX_STRATEGY_ID = "no_fix"` — virtual strategy ID, not present in WASM, handled entirely in UI.

## Param editing: useParamEditor

File: `maze-web/src/components/features/useParamEditor.ts`

```ts
useParamEditor(options: {
  entityId: string
  params: ParamDescriptor[]
  storeValues: Record<string, string>
  onCommit: (paramId: string, value: string) => void
}): {
  values: Record<string, string>
  onChange: (paramId: string, value: string) => void
  flushRef: React.MutableRefObject<() => void>
}
```

- `values` — controlled state for inputs.
- `onChange` — updates local state + debounces (~300ms) commit to store.
- `flushRef.current()` — immediately commits all pending values, cancels debounce timer. The caller is responsible for calling this before any action that could discard the pending edit (selection change, remove, toggle, navigating away) — see "Inline param editing" above for where each of the three editor instances (`ParamizedDetail`/detail panel, `RuleCheckRow`, `RuleStrategyPanel`) does this.
- On `entityId` change: `useEffect` resets `values` from `storeValues` (no flush — caller is responsible for flushing first).
- **Unmount does not flush** — the cleanup effect only clears the pending debounce timer. A caller that unmounts the editor (e.g. removing the check/rule) without calling `flushRef.current()` first silently drops the pending edit.

## Store: rule-related state and actions

```typescript
// State
rules: QcRuleState[]
stages: RepairStageState[]   // see "What a stage is" above — no minimum count
strategyParams: Record<string, Record<string, string>>   // strategyId → paramId → value

// Actions
addCheck(typeId: string, ruleId?: string, initialParams?: Record<string, string>): void
createRule(typeIds: string[], strategyId: string | null, initialCheckParams?: Record<string, Record<string, string>>, initialStrategyParams?: Record<string, string>, targetStageId?: string): void
removeCheck(ruleId: string, localId: number): void
setCheckParam(ruleId: string, localId: number, paramId: string, value: string): void
removeCheckFromRule(ruleId: string, localId: number): void
setStrategy(ruleId: string, strategyId: string): void
clearStrategy(ruleId: string): void
toggleStrategyDisabled(ruleId: string): void
toggleRuleDisabled(ruleId: string): void
toggleRuleCollapsed(ruleId: string): void
renameRule(ruleId: string, name: string): void
removeRule(ruleId: string): void
moveRule(ruleId: string, direction: "up" | "down"): void
addStage(): void
renameStage(stageId: string, name: string): void
removeStage(stageId: string): void
moveStage(stageId: string, direction: "up" | "down"): void
toggleStageDisabled(stageId: string): void
toggleStageCollapsed(stageId: string): void
setStrategyParam(strategyId: string, paramId: string, value: string): void
setNestedStrategy(ruleId: string, path: PathSegment[], strategyId: string | null): void
setNestedStrategyParam(ruleId: string, path: PathSegment[], paramId: string, value: string): void
addNestedStrategy(ruleId: string, path: PathSegment[], slotKind: string): void
removeNestedStrategy(ruleId: string, path: PathSegment[]): void
```

See "Nested strategies (UI)" above for the last four.

There is no `selectedChecks`/global `checkParams` state anymore (see "What a rule is" above) —
every action below addresses a check instance as the pair `(ruleId, localId)`, never a bare check
id searched across all rules.

### addCheck(typeId, ruleId?, initialParams?)

- No-op if `typeId`'s descriptor isn't found in `availableChecks`.
- No-op if the descriptor's `allow_multiple_instances` is `false` (every type except
  `min_region_count`) and `typeId` is already active in some rule. Otherwise mints a fresh
  `CheckInstance` — for `min_region_count`, this always succeeds, including when another
  instance of it is already active elsewhere (see GitHub issue #60). `initialParams` overrides
  the descriptor defaults if given (e.g. values already edited in a select dialog before
  confirming); otherwise the new instance gets the descriptor's default params.
- If `ruleId` is **omitted**: creates a fresh singleton rule for the check (`newRule(kind, [{ localId: 0, typeId, params }], null, false)`) — the top-level "Add new rule" path.
- If `ruleId` is **given** and resolves to an existing rule: mints `localId` from that rule's own `nextLocalCheckId`, appends the new `CheckInstance` to that rule's `checks` instead of creating a new rule — the per-rule "+ Add check" path (`AddCheckToRuleDialog`).
- If `ruleId` is given but does not resolve to any current rule (stale/unknown id): silently falls back to creating a new singleton rule, same as if `ruleId` were omitted. Not expected to happen from the UI (dialogs only ever pass a currently-rendered rule's id) and not surfaced as an error.
- If the check's descriptor reports more than one `issue_kinds` entry: only `issue_kinds[0]` is used as the rule's kind, and a `console.error` is logged (`resolveCheckKind` in `generationSlice.ts`) — rules only support one kind per check; no current check produces more than one, this is a guard against silently dropping the others if that ever changes.

### createRule(typeIds, strategyId, initialCheckParams?, initialStrategyParams?)

- No-op if `typeIds` is empty or none resolve to a known descriptor.
- Drops any `typeId` whose descriptor has `allow_multiple_instances: false` and is already
  active in some existing rule — same restriction as `addCheck`, applied per id rather than
  rejecting the whole call (the multiselect dialog already pre-filters/disables such candidates,
  but the store doesn't rely on that being the only caller).
- Creates exactly **one** new rule with one fresh `CheckInstance` per surviving `typeIds` entry (`localId` 0..n by position) — the multiselect "Add new rule" flow (`IssueSelectDialog` → `CheckSelectDialog` → `NewRuleStrategyDialog`). Unlike calling `addCheck` once per id, this never creates intermediate singleton rules for ids after the first.
- `kind` is taken from `typeIds[0]`'s descriptor — same one-kind-per-rule assumption as `addCheck`; callers pre-filter candidates by kind.
- Each instance's params: `initialCheckParams[typeId]` if given, else descriptor defaults.
- If `strategyId` is given and has no existing `strategyParams` entry: uses `initialStrategyParams` if given, else the strategy descriptor's defaults.

### removeCheck(ruleId, localId)

- Deletes the `CheckInstance` at `(ruleId, localId)` from that rule's `checks`. If this empties the rule, the rule itself is **not** dropped (see "What a rule is" above) — distinct from `removeCheckFromRule` below, which always produces a non-empty new rule.

### removeCheckFromRule(ruleId, localId)

- Moves the `CheckInstance` at `(ruleId, localId)` out of its current rule into a **fresh singleton rule** of its own (`strategyId: null`, `disabled: false`, `localId` reset to `0` in the new rule — safe, since uniqueness is only required within one rule's `checks`, and the new rule is a different rule).
- If this empties the source rule, that rule is **not** dropped — same empty-rule-stays policy as `removeCheck`.
- The check's own `params` move with it (already inline on the `CheckInstance`, no separate lookup needed).

### setStrategy(ruleId, strategyId) / clearStrategy(ruleId)

- `setStrategy`: sets the rule's `strategyId`.
- `clearStrategy`: sets the rule's `strategyId` to `null` **and** `disabled` to `false` — a cleared strategy has no disabled state to preserve.

### toggleStrategyDisabled(ruleId)

- Flips the rule's `disabled` (absent/`false` ↔ `true`).
- Does **not** touch `strategyId` or `strategyParams` — the strategy choice and its parameter overrides survive toggling.
- A disabled rule's strategy is sent as `strategy: null` in its stage's `GenerateConfig.stages[].rules` (not an omitted rule entry — the rule's check composition is still needed for merge/attribution), equivalent to the rule having no strategy assigned. Distinct from `ruleDisabled` (below), which omits the rule entirely rather than sending it with `strategy: null`.

### toggleRuleDisabled(ruleId)

- Flips the rule's `ruleDisabled`.
- When `true`: this rule's member checks are excluded entirely from the next `generate()` call (removed from the `checks` list sent to wasm, not just unfixed) — as if they were never selected.

### toggleRuleCollapsed(ruleId) / toggleStageCollapsed(stageId)

See GitHub issue #320. Flip the rule/stage's own `collapsed` — purely a UI presentation toggle, no effect on `GenerateConfig` or any other generation-facing state, unlike every other toggle in this section. `RulesColumn` renders a `CollapseButton` (`maze-web/src/components/CollapseButton.tsx`, a shared chevron-only toggle) at the front of the stage toolbar and the rule card title row:
- A collapsed stage hides its entire `stageCards` block (every member rule card) — only the header/toolbar row remains visible.
- A collapsed rule hides its whole card body — checks list, `RuleParamsSection`, and `RuleStrategyPanel` — only the title row remains visible.

Both default to `false` (expanded) for a freshly created rule/stage (`newRule`/`newStage` in `generationSliceHelpers.ts`) and for project files saved before this field existed (see "Project file persistence" below).

### renameRule(ruleId, name) / removeRule(ruleId)

- `renameRule`: sets the rule's `name`.
- `removeRule`: deletes the rule and all its member check instances — there is no separate flat "active checks" list for them to also be removed from (see "What a rule is" above). Also scrubs `ruleId` from whichever stage's `ruleIds` currently holds it (see "What a stage is" above) — a stage never keeps a stale reference to a deleted rule. Triggered via a `ConfirmModal` in `RulesColumn`, since it's destructive to more than just the rule card.

### moveRule(ruleId, direction)

See GitHub issue #65 — this action's semantics changed with stage grouping: order **now affects repair dispatch** (crossing a stage boundary moves the rule to a different stage, which core dispatches at a different time — see `repair.md`'s "Stages" section), unlike the pre-#65 flat-list version where reordering was purely cosmetic.

Operates directly on `state.stages` (not a derived flat list):
1. Find the stage containing `ruleId` and its index within that stage's `ruleIds`.
2. **Within the stage** (not already at that stage's own edge in the given direction): adjacent swap within `ruleIds`, stage membership unchanged.
3. **At the stage's own edge**: the rule crosses into the neighboring stage (`"up"` → previous stage, `"down"` → next stage) — physically removed from the source stage's `ruleIds` and inserted into the neighbor's, at the edge nearest the crossing point (front for `"down"`, back for `"up"`), including into an empty neighboring stage. The source stage is not auto-removed even if this empties it (see "What a stage is" above).
4. **No-op only at the global boundary** — the first rule of the first stage moving `"up"`, or the last rule of the last stage moving `"down"` (no neighboring stage exists). Also a no-op if `ruleId` is unknown.

Surfaced in `RulesColumn` as ▲/▼ buttons in each rule card's title row — `isFirst`/`isLast` are computed against the combined stage-then-rule flat order (`stages.flatMap(s => s.slots)`), not per-stage position, so the buttons only disable at the true global boundary.

`createRule`'s optional `targetStageId` — when given and resolving to a known stage, places the new rule there instead of the last stage; used by each stage's own toolbar "+ Add rule" button (see "Stage toolbar" below) so a rule created from within a specific stage's section actually lands in that stage, not always the last one. The three-step new-rule dialog flow (`IssueSelectDialog` → `CheckSelectDialog` → `NewRuleStrategyDialog`) threads this id through every step.

### Stage toolbar: addStage() / renameStage(stageId, name) / removeStage(stageId) / moveStage(stageId, direction) / toggleStageDisabled(stageId)

Each stage section in `RulesColumn` has its own toolbar (below the stage's name header, above its rule cards) with five controls: add-rule, move up, move down, rename, remove — plus a disabled-toggle switch alongside them.

- `addStage`: appends a new empty stage. Default name `"Stage N"` where N = the stage count at creation time + 1 — not renumbered later if stages are added/removed/reordered afterward (same pattern as a rule's default name); the very first stage ever created instead defaults to `"Waypoints"` (`quality.default_stage_name`).
- `renameStage`: sets the stage's `name`.
- `removeStage`: **cascading delete** — removes the stage and every rule it holds (their `CheckInstance`s go with them, same as `removeRule`). No "non-empty" or "last remaining stage" restriction (see "What a stage is" above) — `RulesColumn` gates this behind a `ConfirmModal`, whose message calls out "and all its rules" specifically when the stage isn't empty (`quality.confirm_remove_stage_with_rules` vs. the plain `quality.confirm_remove_stage`). If the removed stage held the currently-selected rule (detail-panel `selection`), the selection is cleared.
- `moveStage`: swaps the stage with its neighbor in `state.stages` order (`"up"` = earlier, `"down"` = later) — a plain adjacent swap of the whole stage, `ruleIds` untouched. No-op only at the global boundary (first/last stage); no other restriction — an empty stage, or the sole stage (naturally a no-op, no neighbor to swap with), moves the same way any other stage does.
- `toggleStageDisabled`: flips the stage's `disabled`. See "What a stage is" above and "Generate pipeline" below for the effect on `buildGenerateConfig`.

## Default State

On first `loadRegistry`, checks without params are auto-selected: `missing_endpoints` and `unreachable_finish`, each given its own singleton rule with a default strategy for its kind (if any) — preserves the old "auto-pick a strategy" behavior for checks without params. The default is `scored_endpoints` when it handles the kind (currently true only for `missing_endpoints`/start-finish placement, since it produces better-scored placements than the first-listed random/farthest strategies); otherwise the first strategy handling the kind. `NewRuleStrategyDialog`'s own initial selection (step 3 of "Add new rule") uses the same `scored_endpoints`-first preference. Checks with params (`min_loops_count`, `min_loop_length`, `max_loop_length`) are not auto-selected. These default rules' ids are placed into `state.stages`' sole (initial-state) stage — see "What a stage is" above.

If `loadRegistry` is called again, `rules` are preserved (each rule's `checks` is filtered to
still-known `typeId`s; a rule left empty by that filter is dropped — this is the registry-reload
path, distinct from the empty-rule-stays policy for direct user actions like `removeCheck`). Any
dropped rule's id is also scrubbed from every stage's `ruleIds` in the same update, so a stage
never keeps a stale reference to a rule the reload just removed.

## Project file persistence

`QcRuleState.nextLocalCheckId` is **not** serialized to project files (`projectExport`) —
recomputed on load as `max(checks.map(c => c.localId)) + 1` (or `0` if `checks` is empty), same
as on `loadRegistry`'s own rule construction. `CheckInstance.localId` itself **is** serialized
(plain `number`, JSON-native) — but is not guaranteed stable across a save/load round-trip;
the only contract is uniqueness within its rule's `checks` at any given moment, not identity
across time.

`RepairStageState[]` is serialized as `quality.stages` (`{ id, name, ruleIds, disabled, collapsed }[]`), a
flat sibling of `quality.rules` — plain structure, nothing computed on load. Two load-time cases:

- **`quality.stages` key absent** (file saved before GitHub issue #65): recovery synthesizes one
  stage containing every loaded rule's id, in `rules` array order — `{ id: "stage_1", name: "Stage 1",
  ruleIds: rules.map(r => r.id), disabled: false, collapsed: false }`. This satisfies "every rule belongs to exactly
  one stage" by construction, so no further validation is needed for this path. This is *not* a
  registered file migration (see this repo's "no migrations without an explicit user request"
  policy) — it's a same-shape default-fill for a field that plainly didn't exist yet, the same
  pattern `repairMaxIterations`/`ruleDisabled` already use in this file for their own
  pre-existing-field gaps.
- **`quality.stages` key present**: each entry's `disabled` defaults to `false` if absent (files
  saved before the whole-stage toggle existed — same pattern as `ruleDisabled`'s own default in
  `validateQcRule`); `collapsed` (GitHub issue #320) likewise defaults to `false` if absent, same
  pattern. The list is then validated for three integrity properties, each a hard parse
  error (not a silent recovery) if violated — a `quality.stages` key that exists but is
  inconsistent means the file is corrupted, not merely old: (1) no `ruleId` appears in two
  different stages' `ruleIds`; (2) every `ruleId` in every stage's `ruleIds` resolves to a rule
  actually present in `quality.rules`; (3) every rule in `quality.rules` appears in at least one
  stage's `ruleIds`. Together (1)+(3) mean every rule appears in **exactly** one stage.

`QcRuleState.collapsed` (GitHub issue #320) is serialized as `quality.rules[].collapsed`, same
default-`false`-if-absent recovery as the fields above (`validateQcRule`).

## Generate pipeline

Each `CheckInstance.params` is sent inline as part of its `CheckInstanceConfig` — there is no
separate global params dict crossing the wasm boundary. The WASM runner reads param values as
strings, parses them per check. Unknown params are ignored; missing params fall back to
descriptor defaults. Values are clamped server-side.

`buildGenerateConfig` (`generationSlice.ts`):

1. Filters out every stage with `disabled: true` entirely — a disabled stage is absent from `stages: StageConfig[]`, not sent as an entry with an empty `rules: []` (that shape means "stage exists but nothing to dispatch", a different thing from "stage doesn't exist for this run").
2. Builds `stages: StageConfig[]` from the remaining (enabled) stages, one entry per stage, **in `state.stages` order** — order is significant now (see `moveRule`'s doc comment above and `repair.md`'s "Stages" section for why).
3. Within each stage: excludes `ruleDisabled` rules entirely from that stage's `rules`, and also excludes any remaining rule left with zero *effective* checks (every member `CheckInstance.disabled`, or `checks` already empty) — same "as if never selected" treatment, since core's `build_qc_and_repair` rejects a rule with an empty `checks` array outright ("rule `<id>` has no checks"). Neither exclusion sends the rule as `strategy: null` (that shape means something different — see below). **Every** remaining rule is sent, including ones with no strategy or with `disabled: true` (`strategy: null` for those, not an omitted entry). The wasm layer needs the rule's check composition to merge/attribute issues correctly even when nothing repairs them — see `Specs/repair.md`. Each rule's `checks` is filtered to its non-`disabled` members, then mapped to `CheckInstanceConfig[]` via `c => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params })` — order preserved from `QcRuleState.checks`, never resorted, so serialization stays deterministic. `localId` is a `number` in the store but crosses the wasm boundary as a `string` (`CheckInstanceConfig.local_id: string`) — the numeric type never crosses; only this conversion point.
4. For a rule with a strategy: resolves the strategy's param overrides from `strategyParams[strategyId]`, filtered to keys the strategy descriptor actually declares.
5. A stage left with an empty `rules` array after step 3's filtering is sent as-is (`{ id, name, rules: [] }`) — core treats a stage with no dispatchable rules as a trivial degenerate case (see `repair.md`'s "Stages" section), no special-casing needed here.

See `quality_control.md`'s "StageConfig"/"QcRuleConfig" sections for the wasm-side shapes this maps onto, and `repair.md`'s "Stages" / "QcRule and rule-based RepairEngine" sections for how core turns it into a `RepairEngine`.

## Issue rendering: IssuesBlock / IssueBubble

`IssuesBlock` (`components/IssuesBlock.tsx`) renders the post-generation issue list (`MazeSnapshot.issues`, `IssueDto[]` — see `quality_control.md`'s "IssueDto" section), separately from the rule-configuration UI above (`QualityCanvas`/`RulesColumn`).

**One bubble per contributing check, not per issue.** A merged `IssueDto` can have multiple entries in `source_checks` (e.g. `min_loop_length` and `max_loop_length` both flagged cycles in the same `invalid_loop` issue, or two `min_region_count` instances in the same `missing_regions` issue — see `quality_control.md`'s "Dedup interaction"). `IssuesBlock` flat-maps each issue into one `IssueBubble` per source check, so each reads as a distinct, specific message rather than one generic bubble covering both reasons. An issue with no source check (currently only `cycle_analysis_overflowed`, not a toggleable `Check<T>`) renders as a single bubble with `sourceCheck: null`.

**Per-bubble label**: `resolveIssueSourceLabel(kind, typeId, issue.details[sourceCheck])` (`issueRegistry.ts`) looks up a check-**type**-specific formatter in `DETAIL_LABELS`, passing that check's own slice of `IssueDto.details` (raw values only, e.g. `{"threshold": "100"}`) to build a localized message via paraglide (e.g. `issue.invalid_loop.max_loop_length_label`: "Loop longer than {max_loop_length} tiles"). `typeId` is resolved from `issue.source_check_types[sourceCheck]` when there is a source check (or falls back to `issue.kind` when there isn't, e.g. `repair_limit_reached`) — `DETAIL_LABELS` is keyed by type id, not by the opaque per-instance `sourceCheck` composite id, since two instances of the same type (GitHub issue #60) format identically. Falls back to the kind's generic label (`resolveIssue(kind).label`) when `typeId` has no `DETAIL_LABELS` entry or no details were recorded. `console.error`s when a check reports non-empty `details` but has no `DETAIL_LABELS` entry — a registry-didn't-keep-up-with-core gap, same class of mistake `resolveCheckKind` warns about for multi-kind checks.

**Per-bubble highlight**: `IssueDto.payload` is a tagged union (`IssuePayloadDto`, `quality_control.md`'s "IssueDto" section) — the web side narrows on `payload.kind`. When `payload.kind === "invalid_loop"`, `payload.edges` is keyed by source check id (`Record<string, [number,number][][]>`), not one flat list — hovering one bubble (`setHoveredIssueLoopEdges`) highlights only the cycles *that check* flagged, not every contributing check's cycles combined. Built in `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) by looking up each invalid cycle's canonical key in `InvalidLoopIssue.invalid_sources` to find which check(s) it belongs to. `region_needs_expansion` issues follow the same pattern via `payload.kind === "region_needs_expansion"` / `payload.nodes`.

Adding a new check that should render a specific message (not just the generic kind label) requires: the check attaching detail(s) via `Issue::with_detail` (core), and a `DETAIL_LABELS[check_id]` entry plus matching paraglide message key(s) here (web) — there is no automatic wiring between the two.
