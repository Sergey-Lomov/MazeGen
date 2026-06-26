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
interface QcRuleState {
  id: string;            // opaque, client-generated (rule_${counter}); not derived from `checks`
  name: string;          // user-facing, defaults to "Rule N", editable
  kind: string;          // IssueKind shared by all member checks, captured at creation time
  checks: string[];      // member check ids — can be empty (see below)
  strategyId: string | null;
  disabled: boolean;     // strategy-only toggle, see below
  ruleDisabled: boolean; // whole-rule toggle, see below
}
```

- `kind` is captured once at rule creation and kept on the rule itself (not derived from `checks[0]`) so it survives `checks` becoming empty.
- A rule's `checks` **can become empty** — e.g. after removing its last member via the check row's own `✖` (not via `removeCheckFromRule`, which moves the check elsewhere instead of leaving it homeless). An empty rule is not auto-dropped: it stays as a card with `strategyId`/`kind` intact so the user can repopulate it via the rule's own `+ Add check`. The card title shows `"{name} ({kind label})"` for an empty rule, since there's no member check left to imply what it's for.
- `disabled` (strategy-only toggle) vs `ruleDisabled` (whole-rule toggle) are independent: `disabled` skips the fix but the rule's checks still run (QC still reports the issue, just unfixed); `ruleDisabled` excludes the rule's checks from generation entirely, as if never selected.

## QualityCanvas layout

Two columns + detail panel, full height, flex row:

```
[ Rules flex ] | [ Detail ~28% ]
```

Divider: `1px solid colors.borderMid`. Background: `colors.bgApp`.

There is no separate "Checks" column — each rule card shows its own member checks inline (left half) next to its strategy (right half), so a check is always seen in the context of the rule it belongs to.

### Rules column (`RulesColumn`)

One card per rule (`slots: StrategySlotVM[]`, one entry per rule in the store, not deduplicated by kind). Each card is split left/right:

- **Left half — checks list** (`RuleCheckRow`, one per member check): label, params shown always-expanded directly under the row (mirrors the strategy half's param layout — see below), `✖` remove button (calls `removeCheck`, which removes the check from `selectedChecks` **and** from this rule's `checks` atomically — never leaves a check "in a rule but not active"). Below the member checks: a `+ Add check` row — opens `AddCheckToRuleDialog` filtered to not-yet-active checks of this rule's `kind`; if none exist, opens an `AlertModal` instead (`quality.no_checks_for_kind`).
- **Right half — strategy panel** (`RuleStrategyPanel`): strategy label (or `strategy.no_fix.label` if `strategyId` is null), its params shown always-expanded underneath (same layout as the checks side), a `Switch` toggle (visible only when a strategy is set) bound to `disabled`, and a `✎` edit button opening `StrategySelectDialog`.
- **Card title row**: rule name (or inline rename input), a `Switch` bound to `ruleDisabled`, `✎` rename button, `✖` remove button (opens a `ConfirmModal` before calling `removeRule`, since it deletes member checks too).

Split rather than stacked so disabling/configuring the fix reads as independent from the checks — the checks still run regardless of whether their rule's fix is enabled.

Below all rule cards: a single `Add new rule` button (no `+` prefix) — opens `CheckSelectDialog`, titled `quality.select_initial_check_title` ("Select initial check for new rule"), which always creates a **new** singleton rule for whichever check is picked (never merges into an existing rule — that's `AddCheckToRuleDialog`'s job instead).

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

## CheckSelectDialog ("Add new rule")

Modal using `ItemSelectDialog`. Shows **all** available checks (not filtered to unselected). Static title `quality.select_initial_check_title` — does not change based on the current selection (deliberately non-interactive title, unlike the rule-targeted dialog below).

- Already-active checks: Add button disabled, red error text `check.already_active` shown in right panel.
- Right panel: check label, description, params (read-only preview in dialog; params are edited inline in the rule card / detail panel after adding).
- Footer: `[Cancel]` `[Add]`.
- Add: calls `addCheck(id)` with no `ruleId` — always creates a fresh singleton rule for the check (see `GenerationActions.addCheck` below), closes.

## AddCheckToRuleDialog ("+ Add check" inside a rule card)

Modal using `ItemSelectDialog`, targets one specific existing rule (`ruleId`, `kind` props). Title: `quality.add_check_dialog_title` ("Add check: {issue}"), where `{issue}` is the rule's kind, localized via `resolveIssueLabel`.

- Candidates: checks sharing the rule's `kind` that aren't active anywhere yet (`!selectedChecks.includes(c.id)`) — computed by `RulesColumn.candidatesFor`.
- Right panel: check label, description.
- Footer: `[Cancel]` `[Add]`.
- Add: calls `addCheck(id, ruleId)` — activates the check directly into the target rule's `checks` array, not as a new rule (see `addCheck`'s `ruleId` parameter below). Closes.
- If `candidatesFor` returns empty when the row is clicked, this dialog never opens — an `AlertModal` (`quality.no_checks_for_kind`) shows instead.

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
  checks: CheckVM[];               // only selectedChecks, in selection order
  strategySlots: StrategySlotVM[]; // one per rule in the store
}

interface CheckVM { id: string; label: string; description: string; params: ParamDescriptor[] }
interface StrategySlotVM {
  ruleId: string;          // join key with the store's `rules` and ruleId-keyed actions below
  name: string;            // rule's user-facing name
  kind: string;            // rule's captured IssueKind
  label: string;           // resolveIssueLabel(kind) — shown for an empty rule's card title
  strategy: StrategyVM | null;
  disabled: boolean;
  ruleDisabled: boolean;
  producedBy: CheckVM[];    // this rule's member checks, resolved to full CheckVMs
}
interface StrategyVM { id: string; label: string; handles: string; params: ParamDescriptor[] }
```

`strategySlots` is built **one entry per rule** in `state.rules` — not deduplicated or grouped by kind. `kind` (on `StrategySlotVM`) is the join key with `availableStrategies[].handles` and what `StrategySelectDialog`/`AddCheckToRuleDialog`'s candidate filters use. `kind` is read directly from the rule's own `kind` field (captured at creation, see "What a rule is" above), not derived from `producedBy[0]` — so it survives `producedBy` becoming empty.

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
selectedChecks: string[]
checkParams: Record<string, Record<string, string>>      // checkId → paramId → value
rules: QcRuleState[]
strategyParams: Record<string, Record<string, string>>   // strategyId → paramId → value

// Actions
addCheck(id: string, ruleId?: string): void
removeCheck(id: string): void
setCheckParam(checkId: string, paramId: string, value: string): void
removeCheckFromRule(checkId: string): void
setStrategy(ruleId: string, strategyId: string): void
clearStrategy(ruleId: string): void
toggleStrategyDisabled(ruleId: string): void
toggleRuleDisabled(ruleId: string): void
renameRule(ruleId: string, name: string): void
removeRule(ruleId: string): void
moveRule(ruleId: string, direction: "up" | "down"): void
setStrategyParam(strategyId: string, paramId: string, value: string): void
```

### addCheck(id, ruleId?)

- No-op if `id` already in `selectedChecks`.
- No-op if descriptor not found in `availableChecks`.
- Preserves existing `checkParams[id]` if present; initializes from descriptor defaults otherwise.
- Appends `id` to `selectedChecks`.
- If `ruleId` is **omitted**: creates a fresh singleton rule for the check (`newRule(kind, [id], null, false)`) — the top-level "Add new rule" path.
- If `ruleId` is **given** and resolves to an existing rule: appends `id` to that rule's `checks` array instead of creating a new rule — the per-rule "+ Add check" path (`AddCheckToRuleDialog`).
- If `ruleId` is given but does not resolve to any current rule (stale/unknown id): silently falls back to creating a new singleton rule, same as if `ruleId` were omitted. Not expected to happen from the UI (dialogs only ever pass a currently-rendered rule's id) and not surfaced as an error.
- If the check's descriptor reports more than one `issue_kinds` entry: only `issue_kinds[0]` is used as the rule's kind, and a `console.error` is logged (`resolveCheckKind` in `generationSlice.ts`) — rules only support one kind per check; no current check produces more than one, this is a guard against silently dropping the others if that ever changes.

### removeCheck(id)

- Removes `id` from `selectedChecks` **and** from whatever rule's `checks` array contains it, atomically in one `set` call — there is no intermediate state where a check is "in a rule but not active." If this empties the rule, the rule itself is **not** dropped (see "What a rule is" above) — distinct from `removeCheckFromRule` below, which always produces a non-empty new rule.
- Does **not** clear `checkParams[id]` — values are preserved for re-add.

### removeCheckFromRule(checkId)

- Moves `checkId` out of whatever rule it's currently in (filtered out of that rule's `checks`) into a **fresh singleton rule** of its own (`strategyId: null`, `disabled: false`).
- If this empties the source rule, that rule is **not** dropped — same empty-rule-stays policy as `removeCheck`.
- Distinct from `removeCheck`: this does not deactivate the check (`selectedChecks` is untouched), it only changes which rule the check belongs to.

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
- `removeRule`: removes the rule **and** its member checks from `selectedChecks` — the inverse of a rule existing only ever meaning its checks are active. Triggered via a `ConfirmModal` in `RulesColumn`, since it's destructive to more than just the rule card.

### moveRule(ruleId, direction)

- Swaps `ruleId` with its neighbor in `rules` order (`"up"` = earlier index, `"down"` = later index). No-op if the rule is already at that end of the list, or if `ruleId` is unknown.
- `rules` array order is execution order in the repair pipeline's fixpoint loop (see `repair.md`), so this is how the user controls rule priority — surfaced in `RulesColumn` as ▲/▼ buttons in each rule card's title row, disabled at the respective end of the list.

## Default State

On `loadRegistry`, checks without params are auto-selected: `missing_endpoints` and `unreachable_finish`, each given its own singleton rule with the first strategy that handles its kind (if any) — preserves the old "auto-pick the only strategy" behavior for checks without params. Checks with params (`min_loops_count`, `min_loop_length`, `max_loop_length`) are not auto-selected.

If `loadRegistry` is called again, `selectedChecks` and `rules` are preserved (rules' member-check lists are filtered to still-known check ids; rules left empty by that filter are dropped — this is the registry-reload path, distinct from the empty-rule-stays policy for direct user actions like `removeCheck`). Stale check IDs are removed from `selectedChecks` and `checkParams`.

## Generate pipeline

`checkParams` is passed as `check_params` in `GenerateConfig`. The WASM runner reads param values as strings, parses them per check. Unknown params are ignored; missing params fall back to descriptor defaults. Values are clamped server-side.

`buildGenerateConfig` (`generationSlice.ts`):

1. Excludes `ruleDisabled` rules' checks entirely from both `checks` and `check_rules` — as if never selected.
2. Builds `check_rules: QcRuleConfig[]` — **every** remaining rule is sent, including ones with no strategy or with `disabled: true` (`strategy: null` for those, not an omitted entry). The wasm layer needs the rule's check composition to merge/attribute issues correctly even when nothing repairs them — see `Specs/repair.md`.
3. For a rule with a strategy: resolves the strategy's param overrides from `strategyParams[strategyId]`, filtered to keys the strategy descriptor actually declares.

See `quality_control.md`'s "QcRuleConfig" section for the wasm-side shape this maps onto, and `repair.md`'s "QcRule and rule-based RepairEngine" section for how core turns it into a `RepairEngine`.

## Issue rendering: IssuesBlock / IssueBubble

`IssuesBlock` (`components/IssuesBlock.tsx`) renders the post-generation issue list (`MazeSnapshot.issues`, `IssueDto[]` — see `quality_control.md`'s "IssueDto" section), separately from the rule-configuration UI above (`QualityCanvas`/`RulesColumn`).

**One bubble per contributing check, not per issue.** A merged `IssueDto` can have multiple entries in `source_checks` (e.g. `min_loop_length` and `max_loop_length` both flagged cycles in the same `invalid_loop` issue — see `quality_control.md`'s "Dedup interaction"). `IssuesBlock` flat-maps each issue into one `IssueBubble` per source check, so each reads as a distinct, specific message rather than one generic bubble covering both reasons. An issue with no source check (currently only `cycle_analysis_overflowed`, not a toggleable `Check<T>`) renders as a single bubble with `sourceCheck: null`.

**Per-bubble label**: `resolveIssueSourceLabel(kind, sourceCheck, issue.details[sourceCheck])` (`issueRegistry.ts`) looks up a check-specific formatter in `DETAIL_LABELS`, passing that check's own slice of `IssueDto.details` (raw values only, e.g. `{"threshold": "100"}`) to build a localized message via paraglide (e.g. `issue.invalid_loop.max_loop_length_label`: "Loop longer than {max_loop_length} tiles"). Falls back to the kind's generic label (`resolveIssue(kind).label`) when `sourceCheck` has no `DETAIL_LABELS` entry or no details were recorded. `console.error`s when a check reports non-empty `details` but has no `DETAIL_LABELS` entry — a registry-didn't-keep-up-with-core gap, same class of mistake `resolveCheckKind` warns about for multi-kind checks.

**Per-bubble highlight**: `IssueDto.invalid_loop_edges` is keyed by source check id (`Record<string, [number,number][][]>`), not one flat list — hovering one bubble (`setHoveredIssueLoopEdges`) highlights only the cycles *that check* flagged, not every contributing check's cycles combined. Built in `build_analytics_snapshot` (`maze-wasm/src/analytics.rs`) by looking up each invalid cycle's canonical key in `IssueData::InvalidLoops.invalid_sources` to find which check(s) it belongs to.

Adding a new check that should render a specific message (not just the generic kind label) requires: the check attaching detail(s) via `Issue::with_detail` (core), and a `DETAIL_LABELS[check_id]` entry plus matching paraglide message key(s) here (web) — there is no automatic wiring between the two.
