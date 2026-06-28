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
- A rule's `checks` **can become empty** — e.g. after removing its last member via the check row's own `✖` (not via `removeCheckFromRule`, which moves the check elsewhere instead of leaving it homeless). An empty rule is not auto-dropped: it stays as a card with `strategyId`/`kind` intact so the user can repopulate it via the rule's own `+ Add check`. The card title shows `"{name} ({kind label})"` for an empty rule, since there's no member check left to imply what it's for.
- `disabled` (strategy-only toggle) vs `ruleDisabled` (whole-rule toggle) are independent: `disabled` skips the fix but the rule's checks still run (QC still reports the issue, just unfixed); `ruleDisabled` excludes the rule's checks from generation entirely, as if never selected.
- `nextLocalCheckId` starts at the rule's initial check count, increments on every check added to this rule, and never resets or reuses a previously-issued `localId` even after that check is removed — addressing a check is always the pair `(ruleId, localId)`, never a bare `localId` searched across all rules. Not serialized to project files (see "Project file persistence" below) — recomputed on load as `max(checks.map(c => c.localId)) + 1` (or `0` if `checks` is empty).

## QualityCanvas layout

Two columns + detail panel, full height, flex row:

```
[ Rules flex ] | [ Detail ~28% ]
```

Divider: `1px solid colors.borderMid`. Background: `colors.bgApp`.

There is no separate "Checks" column — each rule card shows its own member checks inline (left half) next to its strategy (right half), so a check is always seen in the context of the rule it belongs to.

### Rules column (`RulesColumn`)

One card per rule (`slots: StrategySlotVM[]`, one entry per rule in the store, not deduplicated by kind). Each card is split left/right:

- **Left half — checks list** (`RuleCheckRow`, one per member check instance): label, params shown always-expanded directly under the row (mirrors the strategy half's param layout — see below), `✖` remove button (calls `removeCheck(ruleId, localId)`, which deletes this `CheckInstance` from the rule's `checks`). Below the member checks: a `+ Add check` row — opens `AddCheckToRuleDialog` listing this rule's `kind`'s check descriptors via `RulesColumn.candidatesFor` (see "AddCheckToRuleDialog" below for which types are offered); if `candidatesFor` returns empty, opens an `AlertModal` instead (`quality.no_checks_for_kind`).
- **Right half — strategy panel** (`RuleStrategyPanel`): strategy label (or `strategy.no_fix.label` if `strategyId` is null), its params shown always-expanded underneath (same layout as the checks side), a `Switch` toggle (visible only when a strategy is set) bound to `disabled`, and a `✎` edit button opening `StrategySelectDialog`.
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
  | null;
```

`QualityCanvas` holds a `flushRef` it passes into `QualityDetailPanel` (via `ParamizedDetail`) and calls before every selection change, so an in-flight debounced edit in the detail panel is never lost when switching selection. This is separate from — and does not cover — the inline editors in `RuleCheckRow`/`RuleStrategyPanel` (see above).

## IssueSelectDialog ("Add new rule", step 1)

Modal using `ItemSelectDialog`. Lists distinct issue kinds — `Array.from(new Set(availableChecks.map(c => c.issue_kinds[0])))` — not a separate `IssueVM` in the ViewModel, just derived inline (see "no `IssueVM`" note below). Title `quality.select_issue_title` ("Select rule") — despite the `kind`/issue plumbing, labels and descriptions (`issueI18n`) are worded as rule descriptions (e.g. "Loop validation", "Checks loops against configured criteria...") rather than problem descriptions, since this list is the user-facing "what kind of rule do I want" picker.

- Right panel: issue label + description (`resolveIssueLabel`/`resolveIssueDescription`).
- Footer: `[Cancel]` `[Select]`.
- Select: closes this dialog and opens `CheckSelectDialog` with the chosen `kind`, not `addCheck` — no store mutation happens at this step.

## CheckSelectDialog ("Add new rule", step 2)

Modal using `ItemSelectDialog` in multiselect mode (per-row checkbox, toggled independent of row-click which only changes the right-panel preview), takes a required `kind` prop from step 1. Shows available checks of that kind only.

- A check type with `allow_multiple_instances` (currently only `min_region_count`, see GitHub issue #60) can always be checked, including one already active elsewhere. Every other type: checkbox disabled, red error text `check.already_active` shown in right panel when previewed, once it's already active in some existing rule.
- Right panel (for the previewed/clicked row, not necessarily checked): check label, description, params (edited locally in this dialog's own state — `paramOverrides` — nothing commits to the store here).
- Footer: `[Back]` (returns to `IssueSelectDialog`) `[Cancel]` `[Next]` (disabled until at least one checkbox is on).
- Next: calls `onNext(checkedIds, paramOverrides)` — hands the picked ids to step 3, no store mutation.

## NewRuleStrategyDialog ("Add new rule", step 3)

Modal using `ItemSelectDialog`, takes a required `kind` prop. Shows `no_fix` plus strategies where `handles === kind` — same candidate filter as `StrategySelectDialog`, but this dialog targets no existing rule (nothing in the store yet) and stages strategy params locally instead of writing through `setStrategyParam`.

- This step is skipped entirely (by `RulesColumn`, before opening it) when `availableStrategies` has no entry with `handles === kind` — the rule is created directly with `strategyId: null`.
- Right panel: strategy description + param fields (local state, not `useParamEditor`).
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
- Right panel: strategy description + param fields (via `useParamEditor` inside `StrategyParamPanel`).
- Footer: `[Cancel]` `[Select]`.

## ViewModel: useQualityViewModel

File: `maze-web/src/components/features/useQualityViewModel.ts`

Computed via `useMemo` from store state:

```ts
interface QualityViewModel {
  checks: CheckVM[];               // every active check instance, across all rules
  strategySlots: StrategySlotVM[]; // one per rule in the store
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
}
interface StrategyVM { id: string; label: string; handles: string; params: ParamDescriptor[] }
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
strategyParams: Record<string, Record<string, string>>   // strategyId → paramId → value

// Actions
addCheck(typeId: string, ruleId?: string, initialParams?: Record<string, string>): void
createRule(typeIds: string[], strategyId: string | null, initialCheckParams?: Record<string, Record<string, string>>, initialStrategyParams?: Record<string, string>): void
removeCheck(ruleId: string, localId: number): void
setCheckParam(ruleId: string, localId: number, paramId: string, value: string): void
removeCheckFromRule(ruleId: string, localId: number): void
setStrategy(ruleId: string, strategyId: string): void
clearStrategy(ruleId: string): void
toggleStrategyDisabled(ruleId: string): void
toggleRuleDisabled(ruleId: string): void
renameRule(ruleId: string, name: string): void
removeRule(ruleId: string): void
moveRule(ruleId: string, direction: "up" | "down"): void
setStrategyParam(strategyId: string, paramId: string, value: string): void
```

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
- A disabled rule's strategy is sent as `strategy: null` in `GenerateConfig.check_rules` (not an omitted rule entry — the rule's check composition is still needed for merge/attribution), equivalent to the rule having no strategy assigned.

### toggleRuleDisabled(ruleId)

- Flips the rule's `ruleDisabled`.
- When `true`: this rule's member checks are excluded entirely from the next `generate()` call (removed from the `checks` list sent to wasm, not just unfixed) — as if they were never selected.

### renameRule(ruleId, name) / removeRule(ruleId)

- `renameRule`: sets the rule's `name`.
- `removeRule`: deletes the rule and all its member check instances — there is no separate flat "active checks" list for them to also be removed from (see "What a rule is" above). Triggered via a `ConfirmModal` in `RulesColumn`, since it's destructive to more than just the rule card.

### moveRule(ruleId, direction)

- Swaps `ruleId` with its neighbor in `rules` order (`"up"` = earlier index, `"down"` = later index). No-op if the rule is already at that end of the list, or if `ruleId` is unknown.
- Purely organizational: core's `RepairEngine` dispatches rules independently via a `HashMap`-keyed lookup, not by array position (see `repair.md`'s "QcRule and rule-based RepairEngine" — order has no effect on which rule's strategy runs first or on fixpoint convergence). `moveRule` only changes how rules are listed in the UI and serialized into `check_rules` — surfaced in `RulesColumn` as ▲/▼ buttons in each rule card's title row, disabled at the respective end of the list.

## Default State

On `loadRegistry`, checks without params are auto-selected: `missing_endpoints` and `unreachable_finish`, each given its own singleton rule with a default strategy for its kind (if any) — preserves the old "auto-pick a strategy" behavior for checks without params. The default is `scored_endpoints` when it handles the kind (currently true only for `missing_endpoints`/start-finish placement, since it produces better-scored placements than the first-listed random/farthest strategies); otherwise the first strategy handling the kind. `NewRuleStrategyDialog`'s own initial selection (step 3 of "Add new rule") uses the same `scored_endpoints`-first preference. Checks with params (`min_loops_count`, `min_loop_length`, `max_loop_length`) are not auto-selected.

If `loadRegistry` is called again, `rules` are preserved (each rule's `checks` is filtered to
still-known `typeId`s; a rule left empty by that filter is dropped — this is the registry-reload
path, distinct from the empty-rule-stays policy for direct user actions like `removeCheck`).

## Project file persistence

`QcRuleState.nextLocalCheckId` is **not** serialized to project files (`projectExport`) —
recomputed on load as `max(checks.map(c => c.localId)) + 1` (or `0` if `checks` is empty), same
as on `loadRegistry`'s own rule construction. `CheckInstance.localId` itself **is** serialized
(plain `number`, JSON-native) — but is not guaranteed stable across a save/load round-trip;
the only contract is uniqueness within its rule's `checks` at any given moment, not identity
across time.

## Generate pipeline

Each `CheckInstance.params` is sent inline as part of its `CheckInstanceConfig` — there is no
separate global params dict crossing the wasm boundary. The WASM runner reads param values as
strings, parses them per check. Unknown params are ignored; missing params fall back to
descriptor defaults. Values are clamped server-side.

`buildGenerateConfig` (`generationSlice.ts`):

1. Excludes `ruleDisabled` rules' checks entirely from `check_rules` — as if never selected.
2. Builds `check_rules: QcRuleConfig[]` — **every** remaining rule is sent, including ones with no strategy or with `disabled: true` (`strategy: null` for those, not an omitted entry). The wasm layer needs the rule's check composition to merge/attribute issues correctly even when nothing repairs them — see `Specs/repair.md`. Each rule's `checks` is mapped to `CheckInstanceConfig[]` via `c => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params })` — order preserved from `QcRuleState.checks`, never resorted, so serialization stays deterministic. `localId` is a `number` in the store but crosses the wasm boundary as a `string` (`CheckInstanceConfig.local_id: string`) — the numeric type never crosses; only this conversion point.
3. For a rule with a strategy: resolves the strategy's param overrides from `strategyParams[strategyId]`, filtered to keys the strategy descriptor actually declares.

See `quality_control.md`'s "QcRuleConfig" section for the wasm-side shape this maps onto, and `repair.md`'s "QcRule and rule-based RepairEngine" section for how core turns it into a `RepairEngine`.

## Issue rendering: IssuesBlock / IssueBubble

`IssuesBlock` (`components/IssuesBlock.tsx`) renders the post-generation issue list (`MazeSnapshot.issues`, `IssueDto[]` — see `quality_control.md`'s "IssueDto" section), separately from the rule-configuration UI above (`QualityCanvas`/`RulesColumn`).

**One bubble per contributing check, not per issue.** A merged `IssueDto` can have multiple entries in `source_checks` (e.g. `min_loop_length` and `max_loop_length` both flagged cycles in the same `invalid_loop` issue, or two `min_region_count` instances in the same `missing_regions` issue — see `quality_control.md`'s "Dedup interaction"). `IssuesBlock` flat-maps each issue into one `IssueBubble` per source check, so each reads as a distinct, specific message rather than one generic bubble covering both reasons. An issue with no source check (currently only `cycle_analysis_overflowed`, not a toggleable `Check<T>`) renders as a single bubble with `sourceCheck: null`.

**Per-bubble label**: `resolveIssueSourceLabel(kind, typeId, issue.details[sourceCheck])` (`issueRegistry.ts`) looks up a check-**type**-specific formatter in `DETAIL_LABELS`, passing that check's own slice of `IssueDto.details` (raw values only, e.g. `{"threshold": "100"}`) to build a localized message via paraglide (e.g. `issue.invalid_loop.max_loop_length_label`: "Loop longer than {max_loop_length} tiles"). `typeId` is resolved from `issue.source_check_types[sourceCheck]` when there is a source check (or falls back to `issue.kind` when there isn't, e.g. `repair_limit_reached`/`qc_no_progress`) — `DETAIL_LABELS` is keyed by type id, not by the opaque per-instance `sourceCheck` composite id, since two instances of the same type (GitHub issue #60) format identically. Falls back to the kind's generic label (`resolveIssue(kind).label`) when `typeId` has no `DETAIL_LABELS` entry or no details were recorded. `console.error`s when a check reports non-empty `details` but has no `DETAIL_LABELS` entry — a registry-didn't-keep-up-with-core gap, same class of mistake `resolveCheckKind` warns about for multi-kind checks.

**Per-bubble highlight**: `IssueDto.invalid_loop_edges` is keyed by source check id (`Record<string, [number,number][][]>`), not one flat list — hovering one bubble (`setHoveredIssueLoopEdges`) highlights only the cycles *that check* flagged, not every contributing check's cycles combined. Built in `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) by looking up each invalid cycle's canonical key in `IssueData::InvalidLoops.invalid_sources` to find which check(s) it belongs to.

Adding a new check that should render a specific message (not just the generic kind label) requires: the check attaching detail(s) via `Issue::with_detail` (core), and a `DETAIL_LABELS[check_id]` entry plus matching paraglide message key(s) here (web) — there is no automatic wiring between the two.
