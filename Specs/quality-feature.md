# Quality Feature

The Quality feature manages active checks, detected issues, and fix strategies. When opened, it replaces the canvas with a full-screen three-column UI (`QualityCanvas`). When closed, the Pixi canvas is restored.

## Feature Card Status

| Condition | Status |
|-----------|--------|
| 0 active checks | `warning` (yellow) |
| ≥1 active checks | `set` (green) |

Subtitle: `"N check(s) active"`.

The card body (`QualityFeature` component) renders a status hint only when the panel is **closed**. When `qualityOpen` is true, `QualityFeature` returns `null`.

## Canvas lifecycle

Opening Quality sets `qualityOpen = true` in the store. `App.tsx` hides the Pixi canvas (`display: none`) and renders `<QualityCanvas />` in its place. `MazeScene` subscribes to `qualityOpen` and stops the Pixi ticker when open, restarts it when closed.

## QualityCanvas layout

Three columns + detail panel, full height, flex row:

```
[ Checks ~22% ] | [ Issues flex ] | [ Detail ~28% ]
```

Dividers: `1px solid colors.borderMid`. Background: `colors.bgApp`.

### Checks column

Lists only **active** (selected) checks. Each check card shows label + `✖` remove button.

- Remove button: calls `removeCheck(id)` immediately, clears selection if that check was selected.
- `+` button in column header opens `CheckSelectDialog`.
- Empty state: hint text `status.no_checks`.

### Issues column

Lists unique issue kinds produced by all active checks (`issue_kinds` from their descriptors, deduplicated). Each row contains two cards side by side:

- **Issue card** (40% width): issue label, clickable → selects issue in detail panel.
- **Strategy card** (remaining width): label of currently selected strategy, or `strategy.no_fix.label` if none. `✎` edit button opens `StrategySelectDialog`. The strategy card itself is also clickable → selects strategy in detail panel (only if a real strategy is set).
- When a strategy is set, a `Switch` toggle appears before `✎`: disables/re-enables the strategy without clearing its selection or params. Disabled state renders the strategy card dimmed. Hidden when no strategy is set (nothing to disable).

Empty state: hint text `quality.no_issues`.

### Detail panel

Shows details for the current selection:

| Selection | Content |
|-----------|---------|
| None | Empty hint `quality.select_to_view` |
| Check | Label, description, param fields (via `useParamEditor`) |
| Issue | Label, description, list of detecting checks |
| Strategy | Label, description, param fields (via `useParamEditor`) |

## CheckSelectDialog

Modal using `ItemSelectDialog`. Shows **all** available checks (not filtered to unselected).

- Already-active checks: Add button disabled, red error text `check.already_active` shown in right panel.
- Right panel: check label, description, params (read-only preview in dialog; params are edited in the detail panel after adding).
- Footer: `[Cancel]` `[Add]`.
- Add: calls `addCheck(id)`, closes.

## StrategySelectDialog

Modal using `ItemSelectDialog`. Shows strategies where `handles === issueId`, plus `NO_FIX_STRATEGY_ID` ("no_fix") as the first item.

- Selecting `no_fix` calls `clearStrategy(issueId)` → removes the key from `selectedStrategies` → `issueStrategy[id]` becomes `null` in the ViewModel.
- Selecting a real strategy calls `setStrategy(issueId, strategyId)`.
- Right panel: strategy description + param fields (via `useParamEditor` inside `StrategyParamPanel`).
- Footer: `[Cancel]` `[Select]`.

## ViewModel: useQualityViewModel

File: `maze-web/src/components/features/useQualityViewModel.ts`

Computed via `useMemo` from store state:

```ts
interface QualityViewModel {
  checks: CheckVM[];                         // only selectedChecks, in selection order
  issues: IssueVM[];                         // unique issue_kinds from active checks
  issueStrategy: Record<string, StrategyVM | null>;  // issueId → strategy or null
  issueToChecks: Record<string, CheckVM[]>;  // issueId → detecting checks
}

interface CheckVM    { id: string; label: string; description: string; params: ParamDescriptor[] }
interface IssueVM    { id: string; label: string; description: string }
interface StrategyVM { id: string; label: string; handles: string; params: ParamDescriptor[] }
```

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
- `flushRef.current()` — immediately commits all pending values, cancels debounce timer. Called in `QualityCanvas` before changing selection to avoid losing in-flight edits.
- On `entityId` change: `useEffect` resets `values` from `storeValues` (no flush — caller is responsible for flushing first).

## Store: quality-related state and actions

```typescript
// State
selectedChecks: string[]
checkParams: Record<string, Record<string, string>>      // checkId → paramId → value
selectedStrategies: Record<string, string>               // issueKind → strategyId
disabledStrategies: Record<string, boolean>               // issueKind → temporarily disabled
qualityOpen: boolean

// Actions
addCheck(id: string): void
removeCheck(id: string): void
setCheckParam(checkId: string, paramId: string, value: string): void
setStrategy(issueKind: string, strategyId: string): void
clearStrategy(issueKind: string): void
toggleStrategyDisabled(issueKind: string): void
setQualityOpen(open: boolean): void
```

### addCheck

- No-op if `id` already in `selectedChecks`.
- No-op if descriptor not found in `availableChecks`.
- Preserves existing `checkParams[id]` if present; initializes from descriptor defaults otherwise.
- Appends `id` to `selectedChecks`.

### removeCheck

- Removes `id` from `selectedChecks`.
- Does **not** clear `checkParams[id]` — values are preserved for re-add.

### clearStrategy

- Deletes `issueKind` key from `selectedStrategies`.
- Also deletes `issueKind` from `disabledStrategies` — a cleared strategy has no disabled state to preserve.
- Results in `issueStrategy[issueKind] === null` in the ViewModel.

### toggleStrategyDisabled

- Flips `disabledStrategies[issueKind]` (absent/`false` ↔ `true`).
- Does **not** touch `selectedStrategies` or `strategyParams` — the strategy choice and its parameter overrides survive toggling, unlike `clearStrategy`.
- A disabled strategy is omitted entirely from the `strategies` map passed to `buildGenerateConfig`/`GenerateConfig`, so `RepairEngine` has no strategy registered for that `IssueKind` — equivalent to the issue having no strategy assigned (skipped, surfaced as unresolved).
- Re-running `toggleStrategyDisabled` restores the same strategy id and param overrides without reconfiguration.

## Default State

On `loadRegistry`, checks without params are auto-selected: `missing_endpoints` and `unreachable_finish`. Checks with params (`min_loops_count`) are not auto-selected.

If `loadRegistry` is called again, `selectedChecks`, `selectedStrategies`, and `disabledStrategies` are preserved. Stale check IDs are removed from `selectedChecks` and `checkParams`.

## Generate pipeline

`checkParams` is passed as `check_params` in `GenerateConfig`. The WASM runner reads param values as strings, parses them per check. Unknown params are ignored; missing params fall back to descriptor defaults. Values are clamped server-side.

`buildGenerateConfig` skips any `issueKind` whose `disabledStrategies[issueKind]` is `true` when building the `strategies` map — the entry is omitted from `GenerateConfig.strategies` entirely, so the WASM side never registers a `RepairStrategy` for that `IssueKind`.
