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

Its settings panel (`VectorByWallsSettingsPanel.tsx`) has four collapsible sections, backed by `VectorByWallsSettings` (`imageExportSlice.ts`), all collapsed by default:
- **Background** (issue #289) — background color, grid visibility, grid color. Defaults match the editor's own canvas/grid colors (`canvas.stage.background`/`canvas.grid.line`) so the exported image looks identical to the editor view until changed.
- **Tiles** (issues #290/#291) — floor fill color, wall color, corners & ends (round/miter, wall thickness 1-20). Floor and wall settings are folded into one section because both draw on the maze's cells/tiles, unlike Background which draws on the viewport (background rect, grid lines). Defaults match `canvas.floor.default`/`canvas.wall.default`/`WALL_THICKNESS`/round, so the exported image looks identical to the editor view until changed. Wall settings are applied via `WallStyleOverride` (`pixi/renderers/types.ts`) to `WallRenderer`'s `solid` `WallStyle` segments, `SplitJunctionRenderer`'s `wallFaces` segments, and the closed-cells fill color — never the `faint`/`background` `WallStyle` variants or a split passage's own node-identity color, which stay fixed. The "corners & ends" setting drives Pixi's stroke `join` and `cap` together (`round`+`round` or `miter`+`square`) — a `join` only renders where two segments share one continuous stroked path, so `chainSegmentsAtSharedVertices` (`WallRenderer.ts`) first groups wall segments into polylines wherever exactly two segments meet at a vertex (ordinary corners); vertices with any other segment count (T-junctions, dead-ends) stay as separate path endpoints, where `cap` applies instead. **Vertex-chaining only runs when a `WallStyleOverride` is actually passed** — `WallRenderer.render`/`SplitJunctionRenderer.render` fall back to the original independent per-segment stroke (no chaining, no join) when called without one, so `GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer` and `MazeOverlayRenderer` (all default callers) keep their exact prior look unchanged.
- **Waypoints** (issue #296) — start/finish marker appearance, as two plain-label sub-groups ("Start"/"Finish") inside the one collapsible section rather than two separate `SectionHeader`s (too small to warrant independent collapse each). Each sub-group has shape (circle/square/diamond/triangle/star5), fill color, border color and border width (0-10, `0` draws no border — no separate show-border toggle). Backed by `MarkerSettings` (`storeTypes.ts`); defaults are a plain circle matching `canvas.node.start`/`canvas.node.finish` with no border, so the exported image looks identical to the editor view until changed. `buildMazeMarkers` (`mazeSelectors.ts`) takes the marker style as an optional `MarkerStyle` parameter (defaulting to a borderless circle) so every other caller — `GenerationRenderer`, `PostEditRenderer`, `MazeOverlayRenderer` — is unaffected; `VectorByWallsRenderer` is the only caller passing a user-configured style. `WaypointsRenderer` (`pixi/renderers/WaypointsRenderer.ts`) draws the shape (`polygonPoints` for square/diamond/triangle/star5, a plain `Graphics.circle` for circle) then strokes a border on top when `borderWidth > 0`.
- **One-ways** (issue #292, placed after Waypoints per the issue's own section order) — the one-way indicator's pattern (triangle/chevron/arrow), its own color (always set — no toggleable custom-color fallback), a border whose color always mirrors the Tiles section's floor color (only its width is settable, 0-10px, `0` draws no border), corners & ends (round/miter join, independent of the Tiles section's own wall join/cap) and two independent scale knobs: size (0.05-0.5 of the tile size — geometric scale) and thickness (1-10px — chevron/arrow's own line width, no effect on the filled triangle pattern). Built into an `OneWayStyleOverride` (`pixi/renderers/types.ts`) by `buildOneWayStyle` (`VectorByWallsRenderer.ts`, a pure function extracted for unit-testability alongside `buildWallStyle`/`viewportWorldRect`), applied only to `WallRenderer`'s plain wall one-way indicators — never a split passage's own connector arrow (`SplitJunctionRenderer` always draws that with the node's own identity color via `drawDirectionArrow`, unaffected). Defaults to a brighter standalone color (`0xffaa00`) than the editor's own `canvas.edge.oneWay`, plus a 3px border and larger-than-editor size/thickness, matching the new shared default described below.

### One-way indicator default changed everywhere, not just "Vector by walls"

`WallRenderer.drawOneWayIndicator` (`pixi/renderers/WallRenderer.ts`) draws a bordered, larger triangle by default now — `drawOneWayTriangle(g, cx, cy, dx, dy, { borderColor: canvas.floor.default, borderWidth: 3, size: TILE_SIZE * 0.3 })` — whenever no `OneWayStyleOverride` is passed at all. This is a deliberate shared visual change (GitHub issue #292 follow-up) affecting every caller of `WallRenderer`, not just `VectorByWallsRenderer`: `GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer` and `MazeOverlayRenderer` all pick up the bordered triangle look automatically, unlike the wall-stroke override above (which is opt-in per caller). `drawOneWayTriangle` itself (`pixi/renderers/wallUtils.ts`) draws via `Graphics.roundPoly` rather than a hand-built `poly` path — `join`/`stroke` alone can't round a filled shape's own corners, only `roundPoly`'s per-corner `corner` radius can — and positions the triangle asymmetrically along its pointing direction: the tip sits 65% of the triangle's length ahead of the wall segment's midpoint, the base 35% behind it (not centered), so the arrowhead reads as protruding from the wall rather than floating over its center. A one-way indicator is always drawn on top of its wall segment (`WallRenderer.render` strokes all wall segments first, then draws every one-way indicator in a second pass) — in every caller, not just `VectorByWallsRenderer`.

`drawOneWayChevron`/`drawOneWayArrow` (also in `wallUtils.ts`) are the two alternative patterns exposed only through `VectorByWallsSettingsPanel`'s "One-ways" section (no other caller ever passes an override, so they never see anything but the default triangle). Both share an `OneWayDrawStyle`'s `thickness` knob for their own line width, independent of `size` (the indicator's geometric scale) — chevron draws two strokes meeting at the tip in a shallow `>` shape (its own `join`/`cap` apply at the vertex and open ends), arrow draws a shaft (ending at the arrowhead's own base, not the tip, so a `square` cap never protrudes past the narrower arrowhead) plus a line-only two-stroke arrowhead. Both support the same outward-only border as the triangle, implemented as a second, wider stroke pass underneath the main one (rather than `alignment: 0`, which only applies to a closed/filled shape's own stroke).

## Scene integration

`MazeScene` wires `ImageExportRenderer` the same way as every other feature-renderer: its own synced layer container, its own entry in `viewportListeners`, `image_export` added to `TESSELLATION_CONFIG_BY_CARD` (resolves to `activeTessellationConfig`, same as generation/post-edit/analytics) and to `refit()`'s `showsMaze` gate.
