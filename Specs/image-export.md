# Image Export Feature

The Image Export feature card lets the user pick one maze **rendering mode** for image export, then configure that mode's own settings. Actual image export (saving/downloading) is out of scope for this ticket — infrastructure only.

## Feature Card Status

| Condition | Status | Comment |
|-----------|--------|---------|
| No maze generated (`nodes.length === 0`) | `unavailable` | "Generate maze first" |
| Maze exists, no render mode selected | `warning` | "Render mode not selected" |
| Maze exists, a render mode is active | `set` | "Active: {mode label}" |

Computed by `computeImageExportCard` (`FeaturesPanel.tsx`), covered by `featuresPanel.test.ts`.

## Switcher: one active mode, no default

`activeRenderMode: RenderModeId | null` (`imageExportSlice.ts`) starts as `null` — the switcher has **no default selection**. The user must explicitly pick a mode; until then the card shows the `warning` status above.

Clicking a switcher item (`ImageExportFeature.tsx`):
- **Inactive item** → becomes the active mode (`setActiveRenderMode`) and its own settings `SidePanel` opens (`setOpenRenderModeSettings(mode)`) — one click both switches and shows that mode's settings, never leaving a panel open for the previously active mode.
- **Active item** → toggles its own settings `SidePanel` open/closed (`setOpenRenderModeSettings`).

`openRenderModeSettings: RenderModeId | null` is independent of `openCard` — closing the whole Image Export card doesn't clear it, but the panel itself only renders while the card is open (rendered on the canvas's `SidePanel` slot, same interaction pattern as post-edit/preset split-node panels).

## Render mode registry

`imageExportRegistry.ts`'s `RENDER_MODES: RenderModeDescriptor[]` is the single source of truth for the switcher's items:

```typescript
interface RenderModeDescriptor {
  id: RenderModeId;
  label: () => string;
  SettingsPanel: React.ComponentType | null; // null = no settings yet
}
```

Adding a new mode: one `RenderModeId` union member, one `RENDER_MODES` entry, one `ImageExportRenderer.createModeRenderer` case, and (if it has settings) one `SettingsPanel` component. No other list to keep in sync.

`resolveRenderMode(id)` looks up a descriptor by id and **returns `null` for an unknown id — it never throws**. This matters once `activeRenderMode` starts getting persisted to project files (planned, alongside per-mode settings, in a future ticket): a project file naming a since-removed/renamed mode must degrade to "no mode selected," not crash the whole `FeaturesPanel`. Every caller (`FeaturesPanel`'s card comment, `ImageExportFeature`'s open-panel lookup) treats a `null` resolution exactly like `activeRenderMode === null`.

## Rendering modes are one-renderer-per-mode, not one-renderer-per-feature

Per `maze-web/CLAUDE.md`'s feature-renderer ownership rule, `ImageExportRenderer` owns the Image Export feature's canvas layer — but internally it delegates to **one renderer instance per active render mode**, since different modes will draw the maze completely differently (walls-as-vectors vs. a future passages-based mode, etc.). `ImageExportRenderer.createModeRenderer` is the only place that switches on `RenderModeId`; each mode renderer gets its own `Container` and is never shared across modes or with any other feature's renderer, even when the visual output happens to match (e.g. "Vector by walls" vs. `GenerationRenderer`).

### "Vector by walls" (`VectorByWallsRenderer`)

Renders the maze **1:1 identically** to the main generation/post-edit view — same walls, same colors — built from the same low-level primitives `GenerationRenderer` uses (`GridRenderer`, `CellFillRenderer` ×2 for floor/closed-cells, `WallRenderer`, `SplitJunctionRenderer`, `TeleportRenderer`, `WaypointsRenderer` for markers), but as its own instances in its own container tree. Visible only while `openCard === "image_export"`.

Its settings panel (`VectorByWallsSettingsPanel.tsx`) has two collapsible sections, backed by `VectorByWallsSettings` (`imageExportSlice.ts`):
- **Background** (issue #289) — background color, grid visibility, grid color. Defaults match the editor's own canvas/grid colors (`canvas.stage.background`/`canvas.grid.line`) so the exported image looks identical to the editor view until changed.
- **Floor** (issue #290) — floor fill color. Defaults to `canvas.floor.default`.

Future tickets may add further style controls (e.g. line thickness, wall color).

## Scene integration

`MazeScene` wires `ImageExportRenderer` the same way as every other feature-renderer: its own synced layer container, its own entry in `viewportListeners`, `image_export` added to `TESSELLATION_CONFIG_BY_CARD` (resolves to `activeTessellationConfig`, same as generation/post-edit/analytics) and to `refit()`'s `showsMaze` gate.
