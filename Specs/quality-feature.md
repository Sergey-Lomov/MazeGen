# Quality Feature

The Quality feature card in `FeaturesPanel` manages the list of active quality checks and their parameters. It provides UI for adding, editing, and removing checks.

## Feature Card Status

| Condition | Status |
|-----------|--------|
| 0 active checks | `warning` (yellow) |
| ≥1 active checks | `set` (green) |

Subtitle: `"N check(s) active"`.

## Default State

On `loadRegistry`, checks without params are auto-selected. Currently: `missing_endpoints` and `unreachable_finish`. Checks with params (`min_loops_count`) are not auto-selected.

If `loadRegistry` is called again (e.g. hot reload), `selectedChecks` and `selectedStrategies` are preserved. Stale check IDs (not in the new registry) are removed from `selectedChecks` and `checkParams`.

## QualityFeature Component

Renders the expanded content of the Quality card:

- List of active checks. Each row: label + `ℹ` (open edit dialog) + `✕` (remove immediately).
- "Add check" button, separated by a divider when the list is non-empty.
- "Add check" is disabled when all available checks are already active (or when `availableChecks` is empty).

## CheckDetailsDialog

Modal dialog rendered via `createPortal` to `document.body`.

### Mode: add

Opened from "Add check" button. Initial selection: first non-active check in `availableChecks` order.

Layout:
- Left column (180px): all available checks. Active checks are greyed out and disabled.
- Right column (510px): check label, description, params (if any).

Footer buttons: `[Cancel]` `[Add and continue]` `[Add]`.

- **Add**: commits local params to store, calls `addCheck`, closes.
- **Add and continue**: commits local params, calls `addCheck`, selects the next non-active check (reads `selectedChecks` from store after the add). If no non-active checks remain, closes.
- **Cancel**: closes without changes.
- Add and "Add and continue" are disabled when the selected check is already active.

### Mode: edit

Opened from `ℹ` button on an active check.

Layout: right column only (no left check selector), 510px wide.

Footer buttons:
- `[Cancel]` `[Delete]` `[Apply]` — when the check has params.
- `[Cancel]` `[Delete]` `[Close]` — when the check has no params.

- **Apply**: commits local params to store, closes.
- **Delete**: calls `removeCheck`, closes.
- **Cancel** / **Close**: closes without changes.

### Local param state

On dialog open, `localParams` is initialized from `store.checkParams[checkId]` (falling back to descriptor defaults). All edits are local until committed. Cancel/Close/✕ discard edits.

Numeric input values are clamped to `[min, max]` from the descriptor when initializing local state. The input enforces `step=1` for integer params, `step=0.1` for float.

## Store: check-related state and actions

```typescript
// State
selectedChecks: string[]
checkParams: Record<string, Record<string, string>>  // checkId → paramId → value string
registryLoaded: boolean

// Actions
addCheck(id: string): void
removeCheck(id: string): void
setCheckParam(checkId: string, paramId: string, value: string): void
```

### addCheck

- No-op if `id` already in `selectedChecks`.
- No-op if descriptor not found in `availableChecks`.
- If `checkParams[id]` exists, keeps it (preserves previous values on re-add).
- If `checkParams[id]` does not exist, initializes from descriptor defaults.
- Appends `id` to `selectedChecks`.

### removeCheck

- Removes `id` from `selectedChecks`.
- Does **not** clear `checkParams[id]` — values are preserved so they can be restored if the check is re-added.

### setCheckParam

- Merges `{[paramId]: value}` into `checkParams[checkId]`.
- Creates the inner map if it does not exist.

## Generate pipeline

`checkParams` is passed as `check_params` in `GenerateConfig`. The WASM runner reads param values as strings and parses them per check. Unknown params are ignored; missing params fall back to the check's default constant. Values are clamped server-side regardless of UI validation.
