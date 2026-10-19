# maze-web Store

## Purpose

Single Zustand store (`useMazeStore`) for all application state. No local component state for maze-related data.

## State Shape

### Tessellation

| Field | Type | Description |
|-------|------|-------------|
| `tessellationKind` | `"square" \| "hex" \| "tri" \| "cairo" \| "square_octagon" \| "brick" \| "trihexagonal" \| "snub_hexagonal" \| "rhombitrihexagonal" \| "truncated_hexagonal" \| "truncated_trihexagonal" \| "elongated_triangular" \| "snub_square" \| "curved_quadrilateral" \| "radial"` | Confirmed tessellation kind |
| `tessellationParams` | `Record<string, unknown>` | Params of the confirmed kind: `{}` for the parameterless kinds, `first_ring_cells`, `ring_layout` and `max_cells` for `radial`; they define the cell set, so changing them resets the maze like a kind change |
| `hexOrientation` | `"flat_top" \| "pointy_top"` | Confirmed hex orientation |
| `triOrientation` | `"r0" \| "r90" \| "r180" \| "r270"` | Confirmed triangle orientation |
| `tessellationConfirmed` | `boolean` | Whether tessellation has been confirmed |
| `previewKind` | `TessellationKind` | Preview (changes on every dropdown change) |
| `previewParams` | `Record<string, unknown>` | Preview params; `setPreviewKind` resets them to the kind's registry defaults, `setPreviewParams` edits them |
| `previewHexOrientation` | `HexOrientation` | Preview hex orientation |
| `previewTriOrientation` | `TriOrientation` | Preview tri orientation |
| `previewFieldConfig` | `FieldConfig` | Drives canvas grid during field setup |
| `squareShape` | `"rect" \| "circle" \| "triangle" \| "free"` | Active square shape |
| `hexShape` | `"rect" \| "circle" \| "triangle" \| "parallelogram" \| "hexagon" \| "free"` | Active hex shape |
| `triangleShape` | `"rect" \| "triangle" \| "circle" \| "hexagon" \| "free"` | Active triangle shape |
| `savedShapes` | `Partial<Record<PresetFieldShapeName, PresetFieldShape>>` | Saved params per preset shape, survives shape switches |
| `fieldConfig` | `FieldConfig` | Active config for field setup: `{ tessellation: { kind, params }, orientation?, shape }` |
| `activeFieldConfig` | `ResolvedField` | Config that was active at last generation, its shape resolved to `custom` cells |

### Field

| Field | Type | Description |
|-------|------|-------------|
| `freeFieldPoints` | `Record<TessellationKind, Set<number>>` | Encoded free-draw points per kind |
| `isEditingField` | `boolean` | True when shape is "free" or fieldEditMode is "custom" |
| `fieldPoints` | `Set<number>` | Active custom cell set (encoded points) |
| `fieldEditMode` | `"default" \| "custom"` | Card-based edit mode |
| `fieldPrimitive` | `"point" \| "rectangle" \| "circle" \| "triangle" \| "equilateral_triangle" \| "hexagon" \| "parallelogram"` | Active draw primitive for free editing |
| `showFieldOverlay` | `boolean` | Whether field overlay is visible |
| `showFieldOrigin` | `boolean` | Whether field origin crosshair is shown |

### Maze Data

| Field | Type | Description |
|-------|------|-------------|
| `nodes` | `NodeDto[]` | Generated maze nodes |
| `edges` | `EdgeDto[]` | Generated directed edges |
| `start` | `number \| null` | Start node id |
| `finish` | `number \| null` | Finish node id |
| `navNodes` | `NavNodeDto[]` | Navigation graph nodes |
| `navEdges` | `NavEdgeDto[]` | Navigation graph edges |
| `components` | `number[][]` | Strongly connected components (arrays of node ids) |
| `nodeStats` | `NodeStatsDto \| null` | Node degree statistics |
| `edgeStats` | `SpatialEdgeStatsDto \| null` | Edge pair statistics |
| `routeInfo` | `RouteInfoDto \| null` | Route analysis result |

### Generation Config

| Field | Type | Description |
|-------|------|-------------|
| `seed` | `number` | RNG seed |
| `randomSeed` | `boolean` | Use random seed on each generate |
| `lastUsedSeed` | `number \| null` | Seed from last generate (used by `buildExactGenerateCallPayload` debug export) |
| `seedHistory` | `number[]` | Stack of past generate seeds, oldest first, capped at 20 (oldest dropped) |
| `seedHistoryIndex` | `number` | Index into `seedHistory` of the currently-shown seed; meaningful only when `seedHistory.length > 0` |
| `seedAttachedToHistory` | `boolean` | True right after history navigation; false after a hand-edited seed. Only affects whether `generate()` mutates history, not the truncation point (always `seedHistoryIndex`) |
| `generationStatus` | `"idle" \| "done" \| "error"` | Last generation result |
| `initialConfig` | `InitialGenerationConfig` | Algorithm + params |
| `elementsConfig` | `ElementsConfig` | One-way chance etc. |
| `selectedChecks` | `string[]` | Active quality check ids |
| `selectedStrategies` | `Record<string, string>` | issueKind → strategyId |
| `strategyParams` | `Record<strategyId, Record<paramId, string>>` | Raw string param values |
| `checkParams` | `Record<checkId, Record<paramId, string>>` | Raw string param values |
| `registryLoaded` | `boolean` | WASM check/strategy registry loaded |
| `availableChecks` | `CheckDescriptor[]` | All checks from WASM registry |
| `availableStrategies` | `StrategyDescriptor[]` | All strategies from WASM registry |

### Preset Connections

| Field | Type | Description |
|-------|------|-------------|
| `presetConnections` | `Map<string, PresetConnectionEntry>` | Key = `"x1,y1-x2,y2"` |
| `presetConnectionsTool` | `PresetConnectionTool` | Active tool |
| `defaultEdgeState` | `"undefined" \| "wall" \| "passage"` | Implicit state for unset edges; drives `source:"default"` entries |
| `presetStart` | `[number, number] \| null` | Forced start cell |
| `presetFinish` | `[number, number] \| null` | Forced finish cell |
| `presetGenSource` | `[number, number] \| null` | Generator start cell; overrides `presetStart` in WASM config |
| `presetConnectionsOpen` | `boolean` | Preset connections panel open |
| `highlightInvalidPresets` | `boolean` | Highlight out-of-field presets |
| `highlightIsolatedNodes` | `boolean` | Highlight isolated nodes |
| `showPresetOrigin` | `boolean` | Show origin marker in preset view |
| `lockedNodes` | `Map<string, NodeLockKind>` | Key = `"x,y"`, manual locks |
| `autoLock` | `boolean` | Auto-lock fully-constrained nodes |
| `autoLockedNodes` | `Set<string>` | Keys of auto-locked nodes (always `"both"` kind) |

### UI State

| Field | Type | Description |
|-------|------|-------------|
| `generationOpen` | `boolean` | Generation feature card open |
| `fieldSetupOpen` | `boolean` | Field setup feature card open |
| `selectedNode` | `number \| null` | Currently selected node id |
| `showNodeIds` | `boolean` | Show node id labels on graph |
| `showCoords` | `boolean` | Show coordinate labels on graph |
| `showMaze` | `boolean` | Show maze tile renderer |
| `warnings` | `string[]` | Generation warnings |
| `error` | `GenerationError \| null` | Last generation-run error as data (`free_field_too_small` or `run_failed` + raw WASM message); written only by generation runs |
| `registryError` | `string \| null` | WASM registry load failure (`loadRegistry`) |
| `postEditRefreshError` | `string \| null` | Last failed `confirmPostEdit` analytics refresh |

### Debug

Event-tree based (GitHub issue #124/#125) — replaces the old per-step full-graph-snapshot model.

| Field | Type | Description |
|-------|------|-------------|
| `debugMode` | `boolean` | Debug mode active |
| `debugArena` | `DebugArenaHandle \| null` | Raw event tape + node list from the last debug generation run; reconstructed maze state at `debugStep` is derived via `selectDebugMazeView`, memoized per `(debugArena, debugStep)` pair (GitHub issue #139) |
| `debugStep` | `number` | Current mutating-event step index into `debugArena.tape` |
| `debugStale` | `boolean` | Arena is outdated (config changed since last generate) |
| `debugAutoPlayDelay` | `number` | Delay (ms) between steps during auto-play |

## Key Invariants

- `fieldConfig` = config driving field setup UI; `activeFieldConfig` = config used at last generation. They diverge when user changes config after generating.
- `fieldPoints` mirrors `freeFieldPoints[tessellationKind]` when `isEditingField`.
- `autoLockedNodes` is recomputed whenever `presetConnections`, `fieldConfig`, or `autoLock` change.
- `debugStale = true` whenever any generation-relevant config changes after an arena exists.
- `debugMode = false` clears `debugStale`.

## Actions

### Tessellation
- `setPreviewKind/setPreviewHexOrientation/setPreviewTriOrientation` — update preview only
- `confirmTessellation()` — copies preview → confirmed; resets maze data if kind changed
- `syncPreviewToConfirmed()` — sync preview dropdowns to confirmed values
- `setTessellationKind/setSquareShape/setHexShape/setTriangleShape/setHexOrientation/setTriOrientation` — update confirmed tessellation
- `setFieldConfig(cfg)` — full config override, derives kind/shape from `cfg.tessellation.kind` and `cfg.shape`

### Generation
- `generate()` — generates with current (possibly random) seed; sets `debugArena` if `debugMode`. Also updates `seedHistory`: truncates from `seedHistoryIndex` and appends the used seed (capped at 20, oldest dropped), unless this is a repeat-generate on the exact seed just navigated to via history (`seedAttachedToHistory` and unchanged)
- `seedHistoryBack()` / `seedHistoryForward()` / `seedHistoryJump(index)` — move `seedHistoryIndex` and copy that seed into `seed`; does not trigger generation. Also turns `randomSeed` off. No-op past either end of history
- `reset()` — clears maze data
- `setDebugMode(v)` — enable/disable; disabling also clears `debugStale`
- `setDebugStep(n)` — set current step
- `setDebugAutoPlayDelay(ms)` — set auto-play delay

### Field
- `addFieldPoint/removeFieldPoint/addFieldPoints/removeFieldPoints/clearFieldPoints` — mutate free-draw cell set
- `setFieldEditMode("custom"|"default")` — switch edit mode; "custom" seeds points from predefined config

### Checks & Strategies
- `loadRegistry()` — async, loads check/strategy descriptors from WASM
- `addCheck/removeCheck/setCheckParam` — manage selected checks
- `setStrategy/setStrategyParam` — manage repair strategies

### Preset Connections
- `applyPresetConnectionsTool(key, from, to)` — apply the active tool to a connection
- `applyPresetConnectionsToolAt(tool, key, from, to)` — apply a specific tool (bypassing `presetConnectionsTool`) to a connection; `tool: "reset"` clears a connection back to the current default. `key` is only a hint — both actions rebuild the real, level-aware key from `from`/`to` internally via `applyTool`, so a caller can pass the bare geometric key safely
- `clearInvalidPresetConnections()` — remove connections outside current field
- `resetPresetConnections()` — clear all presets, locks, start/finish

### Debug Flags
- `setDebugFlag(key, value)` — toggle `showNodeIds`, `showCoords`, or `showMaze`

## Error Handling

`generate()` catches WASM exceptions and stores `{ kind: "run_failed", message }` in `error`; a free field with fewer than 2 cells stores `{ kind: "free_field_too_small" }`. The generation card turns it into text at render time (`generationErrorText`), so a locale switch re-translates it. Does not throw. `error` is cleared on successful generate or `setSeed`. It is shown only in the generation card while `generationStatus === "error"`; no other code writes it (GitHub issue #769).

Other failures go through toasts (`Specs/notifications.md`):

- `loadRegistry` failure sets `registryError` (untouched by seed changes and generation; cleared by a successful `loadRegistry`) and raises an `error` toast. The generation card shows it as a persistent status line and disables Generate with a `Tooltip` reason; the card header (`computeGenerationCard`) reads `critical` regardless of other config. Overlapping `loadRegistry` calls share one in-flight promise (React StrictMode mounts twice in dev), so one failure is one toast occurrence; a call after it settles starts a fresh load.
- `confirmPostEdit` failure sets `postEditRefreshError` and raises an `error` toast; the post-edit card shows it as a persistent status line. Cleared by the next successful refresh and whenever post-edit state is rebuilt (generation, project load, downstream reset).
- Project / style preset / quality preset load failures are `error` toasts; the load is aborted before any state change.
- Removing a split node assigned as start/finish (post-edit) or start/finish/gen-source (presets) is rejected with a `notice` toast.
