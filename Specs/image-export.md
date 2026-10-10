# Image Export Feature

The Image Export feature card lets the user pick one maze **rendering mode** for image export, then configure that mode's own settings, then export it through one of the **export formats** the card's second button group offers. Only PNG is implemented today.

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
- **Inactive item** → becomes the active mode (`setActiveRenderMode`) and its own settings `SidePanel` opens (`setOpenRenderModeSettings(mode)`) — one click both switches and shows that mode's settings.
- **Active item** → toggles its own settings `SidePanel` open/closed (`setOpenRenderModeSettings`).

`openRenderModeSettings: RenderModeId | null` is independent of `openCard` — closing the whole Image Export card doesn't clear it, but the panel itself only renders while the card is open (rendered on the canvas's `SidePanel` slot, same interaction pattern as post-edit/preset split-node panels). It's also independent of `openExportFormatSettings` (below, GitHub issue #629) — opening one no longer clears the other; both may stay mounted at once, and `SidePanel`'s own mount-order stack (`maze-web/Specs/architecture.md`'s "Side panel stacking" section) decides which is actually shown, since both dock to the same slot.

## Render mode registry

`imageExportRegistry.ts`'s `RENDER_MODES: RenderModeDescriptor[]` is the single source of truth for the switcher's items:

```typescript
interface RenderModeDescriptor {
  id: RenderModeId;
  label: () => string;
  SettingsPanel: React.ComponentType | null; // null = no settings yet
}
```

Adding a new mode: one `RenderModeId` union member, one `createModeRenderer` case (`modeRendererFactory.ts` — shared by `ImageExportRenderer` and `PngExporter`, see "PNG export" below), one `resolveExportMargin`/`resolveWallExportMargin`/`resolveBackgroundColor` case each (`exportMargins.ts`), and (if it has settings) one `SettingsPanel` component. No other list to keep in sync.

`resolveRenderMode(id)` looks up a descriptor by id and **returns `null` for an unknown id — it never throws**. This matters because `activeRenderMode`/`openRenderModeSettings` are persisted to project files, alongside per-mode settings (`ProjectFileImageExport`, GitHub issue #295): a project file naming a since-removed/renamed mode degrades to "no mode selected" at load time (`validate.ts`'s `optRenderModeId`, checked against a known-ids whitelist), not a crash of the whole `FeaturesPanel`. Every caller (`FeaturesPanel`'s card comment, `ImageExportFeature`'s open-panel lookup) treats a `null` resolution exactly like `activeRenderMode === null`.

## Rendering modes are one-renderer-per-mode, not one-renderer-per-feature

Per `maze-web/CLAUDE.md`'s feature-renderer ownership rule, `ImageExportRenderer` owns the Image Export feature's canvas layer — but internally it delegates to **one renderer instance per active render mode**, since different modes will draw the maze completely differently (walls-as-vectors vs. a future passages-based mode, etc.). `createModeRenderer` (`modeRendererFactory.ts`) is the only place that switches on `RenderModeId` to build one; each mode renderer gets its own `Container` and is never shared across modes or with any other feature's renderer, even when the visual output happens to match (e.g. "Vector by walls" vs. `GenerationRenderer`).

Every mode renderer implements `ModeRenderer` (`ViewportListener` plus `getRequiredExportMargin()`, `getRequiredWallExportMargin()`, `getBackgroundColor()`, `destroy()`) — the three getters exist so PNG export's canvas-fit math (below) and the settings panel's live preview can ask "how big is this mode's own drawn content, actually" and "what color is its background" without depending on a specific mode's settings shape.

### "Vector by walls" (`VectorByWallsRenderer`)

Renders the maze **1:1 identically** to the main generation/post-edit view — same walls, same colors — built from the same low-level primitives `GenerationRenderer` uses (`GridRenderer`, `CellFillRenderer` ×2 for floor/closed-cells, `WallRenderer`, `SplitJunctionRenderer`, `TeleportRenderer`, `WaypointsRenderer` for markers), but as its own instances in its own container tree. Visible only while `openCard === "image_export"`.

Its settings panel (`VectorByWallsSettingsPanel.tsx`) has six collapsible sections, backed by `VectorByWallsSettings` (`imageExportSlice.ts`), all collapsed by default.

**Section visibility is project-wide, not per-floor** (GitHub issue #484) — a section that only shows when the maze has a given component (One-ways, Teleports, Splits, and each "Vertical connections" sub-group) checks the *unscoped* `nodes`/`edges` (every floor), not `selectFloorScopedMaze`'s active-floor cut. A section is visible when its component exists on **at least one floor**, so switching the displayed floor never changes the set of visible sections (which otherwise flickered the panel). The floor-scoped `nodes`/`edges` are still used for the export-warnings computation, which genuinely describes only what the active floor's image draws. `VectorByCorridorsSettingsPanel` mirrors this.

Sections:
- **Background** (issue #289) — background color plus the original viewport grid's visibility and color. `showGrid`/`gridColor` draw this grid behind the maze and keep their editor-matching defaults (`canvas.stage.background`/`canvas.grid.line`). Vector by walls additionally has independent `showInnerGrid`/`innerGridColor` settings (off by default, color defaulting to `#3a3a3a`): this second grid is an overlay on the active floor's actual maze cells, above their fills and below walls/markers, so it stays inside the maze/export content area.
- **Tiles** (issues #290/#291) — floor fill color, wall color, random wall color toggle/mode, corners & ends (round/miter, wall thickness 1-20). Floor and wall settings are folded into one section because both draw on the maze's cells/tiles, unlike Background's viewport-sized fill. Defaults match `canvas.floor.default`/`canvas.wall.default`/`WALL_THICKNESS`/round, so the exported image looks identical to the editor view until changed. Wall settings are applied via `WallStyleOverride` (`pixi/renderers/types.ts`) to `WallRenderer`'s `solid` `WallStyle` segments, `SplitJunctionRenderer`'s `wallFaces` segments, and the closed-cells fill color — never the `faint`/`background` `WallStyle` variants or a split passage's own node-identity color, which stay fixed. The random wall color toggle is off by default; when enabled, `per_pass` assigns one contrast-controlled deterministic color to each joined wall path, while `per_segment` assigns one to every wall segment independently. Generated colors are selected to maximize their minimum contrast against both floor and export background colors. The "corners & ends" setting drives Pixi's stroke `join` and `cap` together (`round`+`round` or `miter`+`square`) — a `join` only renders where two segments share one continuous stroked path, so `chainSegmentsAtSharedVertices` (`WallRenderer.ts`) first groups wall segments into polylines wherever exactly two segments meet at a vertex (ordinary corners); vertices with any other segment count (T-junctions, dead-ends) stay as separate path endpoints. In Vector-by-walls, round style keeps round caps at every such endpoint, including T-junctions; miter style uses non-protruding butt caps at non-free junction endpoints and restores square caps only at genuine free ends. Synthetic clip-cut points remain uncapped for miter style. **Vertex-chaining only runs when a `WallStyleOverride` is actually passed** — `WallRenderer.render`/`SplitJunctionRenderer.render` fall back to the original independent per-segment stroke (no chaining, no join) when called without one, so `GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer` and `MazeOverlayRenderer` (all default callers) keep their exact prior look unchanged.
- **Waypoints** (issue #296, corner style/size/gap width added in #302) — start/finish marker appearance, as two collapsible sections ("Start"/"Finish", `MarkerSettingsGroup`'s own `SectionHeader`, `sectionId` `"markers_start"`/`"markers_finish"`) inside the one "Waypoints" section, each split (GitHub issue #697 follow-up) into two collapsible sub-sections — "Marker" and "Caption" — rather than one flat field list. "Marker" (`${sectionId}_marker`) holds shape, corner style (sharp/round — own per-marker setting, not shared with the Teleports section's `teleportMarker.cornerStyle`), size (0-1, fraction of the tile size — same convention as `teleportMarker.size`), fill color, border color, border width (0-10, `0` draws no border — no separate show-border toggle), gap width (0-10, `0` draws no gap — no separate show-gap toggle). "Caption" (`${sectionId}_text`, rendered only when the caller passes `showTextSection={true}` — an explicit required prop, not inferred from `settings.text !== undefined` — true for start/finish only; every other `MarkerSettingsGroup` caller, the three vertical-connection markers, passes `false` and renders flat with no own section/sub-section split) holds, in order: a "Show caption" toggle (`textEnabled`, default `false`), the text field, font weight (regular/bold, default bold), text color (`textColor`, GitHub issue #697 second follow-up — independently configurable, same convention as `ElevatorBadgeSettings.textColor`/`TeleportFloorBadgeSettings.textColor`; defaults to `floorColor` for "Vector by walls" and the corridor line color for "Vector by corridors", matching each mode's own former knockout base) and font size (`textSize`, absolute px, 6-32, default 17 — GitHub issue #701; no longer a fraction of the marker diameter). The text field is currently restricted to a single glyph — not a conceptual limit of the `text` field itself, just the current input/validation behavior — so it takes one keystroke (multi-character paste/typeahead truncates to its first character), uppercases it, and accepts only glyphs in the baked MSDF charset (`sanitizeMarkerGlyph`/`isValidMarkerGlyph`, `pixi/renderers/markerGlyph.ts`: uppercase Latin + uppercase Cyrillic + digits, no space/punctuation); an out-of-charset keystroke is simply rejected — shown on screen but never committed — same draft/commit convention as `NumberInput`'s own invalid-input handling (`TextInput`'s `normalize`/`isValid`, `pixi/renderers/markerGlyph.ts`'s `normalizeMarkerGlyphInput`/`isValidMarkerGlyph`); no error styling or tooltip of its own. "Show caption" off hides every other Caption row (text, font weight, color, size and Auto-fit; GitHub issue #723) and marks those paths inactive in the parameter-links dialog (`isPathActive`); it suppresses the rendered badge (`buildMarkerData` substitutes `undefined` for `text` when `textEnabled === false`) — the stored text itself is untouched, so switching it back on restores exactly what was there before. Backed by `MarkerSettings` (`storeTypes.ts`); `shape`/`fillColor`/`borderColor` default to a plain circle matching `canvas.node.start`/`canvas.node.finish`, while `cornerStyle`/`size`/`borderWidth`/`gapWidth` default to whatever the "Shared style" section's own defaults are (round corners, size 0.16, border/gap width 3 — see the "Shared style" section below; these four fields are centralized, not independently hardcoded here). `buildMazeMarkers` (`mazeSelectors.ts`) takes the marker style as an optional `MarkerStyle` parameter, defaulting (GitHub issue #347 follow-up) to that same "Shared style" look (round corners, size 0.16, border/gap width 3) rather than a once-separate fixed editor radius/no-border look, so every post-generation caller — `GenerationRenderer`, `PostEditRenderer`, `MazeOverlayRenderer`, `VectorByWallsRenderer` — renders start/finish markers identically out of the box. `buildPresetMarkers` uses the same canonical start/finish styles with its preset-specific plain-cell-center positions (GitHub issue #448), including the floor-colored gap. `VectorByWallsRenderer` is the only caller passing a user-configured style, built by its own `buildMarkerStyle` helper which merges `gapColor: floorColor` into the `MarkerSettings` (`gapColor` is not itself a `MarkerSettings` field — always mirrors the floor color, same convention as the one-way indicator's own gap color). `WaypointsRenderer` (`pixi/renderers/WaypointsRenderer.ts`) draws the shape via the shared `drawMarkerShape` (`pixi/renderers/markerShapes.ts` — see "Shared marker shape set" below, `rounded` param driven by `cornerStyle`), then, when `gapWidth > 0`, a floor-colored gap ring underneath — a single true outward offset of the marker's own plain fill path by `borderWidth + gapWidth` (`drawMarkerUnderlay`, see "Shared marker shape set" below for why it's one combined offset rather than a pre-widened base shape), matching the connector gap's own draw-wider-underneath convention — then strokes a border on top (`alignment: 0`, pixi's outer alignment) when `borderWidth > 0`. Every border/gap stroke in this codebase now uses `alignment: 0` uniformly (GitHub issue #302 follow-up — previously the waypoint marker's border defaulted to pixi's centered `0.5`, the only one that didn't match) specifically so a marker/indicator's own `radius`-like field always denotes its true fill/inner edge and its gap-ring formula is always `radius + borderWidth + gapWidth` everywhere (teleport edge marker, one-way indicator, waypoint marker alike) rather than needing a per-caller `borderWidth/2` correction. When `text` is set and not suppressed by "Show caption", `WaypointsRenderer` additionally draws a centered label (`makeCenteredLabel`, the same baked-MSDF-font mechanism as the elevator badges/marker-index labels) in its own `labels` child `Container`, in `textColor` (`buildMarkerData` resolves it as `style.textColor ?? style.gapColor` — the `gapColor` fallback only matters for the three vertical-connection markers, which never set `textColor`/`text` at all and never reach this draw path) at `textSize` px (absolute, defaulting to `DEFAULT_MARKER_TEXT_SIZE`), font family resolved from `textFontWeight` via `msdfFontFamily`; the label container's children are explicitly destroyed (not just detached) on every `removeChildren()` before the next render, matching `MarkerIndexRenderer`'s own per-child-destroy convention for Pixi text objects. The parameter-links dialog's tree (`ParameterLinksDialog.tsx`, driven by `ParamDescriptor.group` in `parameterLinksRegistry.ts`) nests every linkable Start/Finish marker field one level deeper under an added "Marker" group segment, mirroring the panel's own Marker/Caption split; four of the five Caption fields — `textEnabled` (`"boolean"`), `textFontWeight` (`"labelFontWeight"`), `textSize` (`"number"`), `textColor` (`"color"`) — are registered the same way under a "Caption" group segment and are fully linkable. Only `text` itself (free text) stays `linkTarget={null}` (permanent "unsupported" link-status icon) — no `ParamType` models free text, so linking it isn't structurally possible. `startMarker`/`finishMarker`'s own defaults set `textEnabled: false`, `textFontWeight: "bold"`, `textSize: 17`, `textColor` explicitly (not left `undefined` with only a runtime `??` fallback) so every registered path still resolves to a concrete value, matching every other linkable field's convention. `textColor` is also registered as a "Project colors" field (`PC.startText`/`PC.finishText`, "Start: Text"/"Finish: Text") with the marker's own fill/border colors (and the floor/corridor color) as its priority picks, and participates in the shared "label vs. its own fill" contrast warning (`label_low_contrast`) alongside the elevator-badge and marker-index text colors.
- **One-ways** (issue #292, placed after Waypoints per the issue's own section order; gap width renamed from border width in #302 follow-up, consistent with the marker/connector gap convention — it's a floor-colored separation gap, not a real border) — the one-way indicator's pattern (triangle/chevron/arrow), its own color (always set — no toggleable custom-color fallback), a gap whose color always mirrors the Tiles section's floor color (only its width is settable, 0-10px, `0` draws no gap), corners & ends (round/miter join, independent of the Tiles section's own wall join/cap) and two independent scale knobs: size (0.05-0.5 of the tile size — geometric scale) and thickness (1-10px — chevron/arrow's own line width, no effect on the filled triangle pattern). Built into an `OneWayStyleOverride` (`pixi/renderers/types.ts`) by `buildOneWayStyle` (`VectorByWallsRenderer.ts`, a pure function extracted for unit-testability alongside `buildWallStyle`/`viewportWorldRect`), applied only to `WallRenderer`'s plain wall one-way indicators — never a split passage's own connector arrow (`SplitJunctionRenderer` always draws that with the node's own identity color via `drawDirectionArrow`, unaffected). Defaults come from `DEFAULT_MAZE_RENDER_STYLE.oneWay` (`pixi/defaultMazeRenderStyle.ts`): color `0xffaa00`, a 3px floor-colored gap, size `0.3 * TILE_SIZE`, thickness 4, and round joins/caps. `WallRenderer` uses that same section when no override is supplied, while image export maps it into `VectorByWallsSettings`, so editor and export cannot drift.

  **`arrow` pattern's shaft/arrowhead joint** (`drawOneWayArrow`, `wallUtils.ts`, GitHub issue #690) — the shaft and the arrowhead's two wing strokes are drawn as separate open paths (the shaft ends on the arrow's own axis, each wing starts off-axis), so neither path's own stroke cap (round or miter) can close the notch between them on its own: round left a visible gap at the default wall one-way proportions (a small arrowhead with an independently-set, comparatively thick `thickness`), while miter's square cap poked sideways past the wings instead. A filled pentagon patch (the shaft's own two side edges extended forward to where each meets its own wing's outer edge, then straight to the tip) plugs this notch solid, drawn after both the main stroke and — when `gapWidth` is set — a second, wider copy of the same patch in the gap color, matching the gap ring's own wider notch. Below `size` 20 the patch is skipped entirely (`JOINT_PATCH_MIN_SIZE`) — at that scale the patch's own geometry (clamped against the arrow's short axis) produced visible artifacts of its own, so the plain unpatched shaft+wing strokes are used there instead. Purely a rendering-geometry fix; no style field or default changed.
- **Teleports** (issue #293, placed after One-ways; edge gap width added in #302) — teleport display style plus per-group customization, both backed by `TeleportRenderer`'s extended `render` API (`pixi/renderers/TeleportRenderer.ts`; every other caller — `GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer`, `MazeOverlayRenderer` — omits the new params entirely and gets `DEFAULT_MAZE_RENDER_STYLE.teleport`: diamond, round corners, size 0.16, border/connector/connector-gap/edge-gap width all 3, orthogonal connector, periodic arrows (period 5, size 10). `VectorByWallsSettings` is derived from that same section, so every teleport-drawing feature shares one visual baseline by construction). One shared `teleportCornerStyle` (`"sharp"`/`"round"`) rounds the four regular-polygon `MarkerShape`s (`triangle`/`square`/`diamond`/`pentagon`/`hexagon`, via the shared `drawRoundedPolygon`) only; `circle` has no corners, `star`/`cross` have no regular-polygon equivalent — `star`'s reflex corners stay sharp regardless of `cornerStyle` (see "Shared marker shape set" below for why). The edge marker is a nested `teleportMarker: MarkerSettings` (GitHub issue #701 — same shape/cornerStyle/fillColor/borderColor/borderWidth/gapWidth/size base as start/finish and the vertical markers; replaces the former flat `teleportLine*`/`teleportEdge*` fields, with no migration of old project files). Marker size (`teleportMarker.size`) is a fraction of the tile size (0-1), same convention as the One-ways section's own `size` knob, not a fixed pixel radius. Edges subsection row order: shape, corner style, size, color, border color, border width, then gap width (0-10px, default 3, `0` draws no gap — `teleportMarker.gapWidth`/`TeleportLineStyle.edgeGapWidth`, GitHub issue #302) — a floor-colored ring drawn outside the marker's own border. Every border/gap stroke in this codebase draws with `alignment: 0` (pixi's outer alignment, grows entirely outward from its own shape) uniformly, so a marker's true outer edge is always `radius + borderWidth`, and every gap-ring formula follows the same `radius + borderWidth + gapWidth` shape regardless of caller (teleport edge marker, waypoint marker, one-way indicator alike). Unlike the marker/one-way/connector gaps (which only ever sit under their own single shape), an edge gap ring can visually overlap the point's own connector — so `TeleportRenderer.renderGroups` draws each group as its own 3-sub-pass block (that group's gap rings, then that group's connectors, then that group's points) rather than a single interleaved pass. A gap only ever needs to stay clear of its *own* group's connector/marker geometry; a later group's whole block (gaps, connectors and points alike) still draws on top of an earlier group's whole block, same "later group wins" rule the pre-#302 single interleaved pass used. `planGroupDrawOrder` still buckets connectors per group; `drawGroupGaps`/`drawGroupPoints` are separate per-group draw calls, both invoked inside the same per-group loop as `drawRoutedConnector`.

  **Floor badges subsection** (GitHub issue #485) — a cross-floor teleport (one whose two endpoints sit on different floors, `NodeDto.level ?? 0`) draws a floor-number badge in place of the off-floor endpoint's marker (`drawFloorBadge`, see `Specs/floors.md`'s "Cross-floor teleport badges"). Before #485 that badge was a hardcoded circle + Arabic digit at the edge marker's own teleport marker's own size. Now a `TeleportFloorBadgeSettings` (`imageExportTypes.ts`, on the shared `TeleportSettingsFields`, so both vector modes get it) drives these fields — `shape` (`MarkerShape`), `labelType` (`"arabic"`/`"roman"`/`"letters"`, formatted by `formatIndexLabel`, shared with #430's elevator badges and #471's marker indices), `cornerStyle`, `size` (px diameter, like every `MarkerAppearance`), `fillColor`/`borderColor`/`borderWidth`/`gapWidth` (the badge body's own colours — GitHub issue #503 follow-up made these independent; before it they always followed the connector colour, and a group override does not touch them), `textColor` (the label colour, independent of the floor colour — before the #485 follow-up the label always drew in `floorColor` as a knockout digit), plus `textFontWeight` and `textSize` (px, see "Label text" below). GitHub issue #701: `TeleportFloorBadgeSettings = BadgeSettings` (`MarkerAppearance` + `TextStyleFields` + `labelType`, `imageExportTypes.ts`) — the badge owns its `borderWidth` (default 3, `0` draws no border ring), `gapWidth` (default 3, `0` draws no gap ring; the ring is drawn in the floor colour) and `cornerStyle` (default `round`, drives `drawFloorBadge`'s `opts.rounded`) instead of borrowing the edge marker's. Defaults: `size` 10, `textSize` 10. The panel renders it with the shared `MarkerAppearanceRows` + `TextStyleRows` (`MarkerFieldRows.tsx`), the same rows start/finish and elevator badges use. Threaded into `TeleportLineStyle.floorBadge` by `buildTeleportLineStyle`; `TeleportRenderer.drawGroupPoints`/`drawGroupGaps` size the badge and its floor-colored gap ring (both in `floorBadge.shape`, drawn rounded) from `floorBadge.size`, not `style.size`, and `attachFloorBadgeNavigation`'s hit radius follows the same (`floorBadge.size / 2 + floorBadge.borderWidth`).

  **Label text** (GitHub issue #701) — the badge label draws at an absolute px size, `textSize` (6-32, default 10), in `textFontWeight` (regular/bold, default bold), `textMargin` (0-10 px in 0.5 steps, default 1) and `textColor`; these four are the shared `TextStyleFields` (`imageExportTypes.ts`) also used by start/finish captions and elevator badges. There is no per-maze shared fit any more: every badge uses its own configured size, and a label too wide for its badge simply overflows (overflow warnings and auto-fit are tracked in GitHub issue #707). `fitTeleportBadgeFontSize` (`floorBadge.ts`) and `fitElevatorBadgeFontSize` (`VerticalConnectionRenderer.ts`) are kept, currently unused, for that follow-up.

  Panel placement: a `teleport_subsection_floor_badges` subsection after the Connector/Arrow groups and before the group-customization toggle, in `TeleportSettingsSection` (both `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel`), hidden entirely when the project has no cross-floor teleport (`hasCrossFloorTeleports` prop, from the `hasCrossFloorTeleport(unscopedNodes, unscopedEdges)` selector in `mazeSelectors/teleport.ts` — a `teleport` edge whose two endpoints differ in `NodeDto.level ?? 0` — checked project-wide against the *unscoped* nodes/edges like every other section-visibility check in #484). Persistence: `validateTeleportFloorBadgeSettings` (`validateImageExport.ts`), lenient recovery like `validateElevatorBadgeSettings` — a project file predating the fields recovers to the default `{ shape: "circle", labelType: "arabic", size: 0.16, textColor: <floor color>, textFontWeight: "bold", textSize: 10 }`. Defaults (retuned in GitHub issue #701, no longer the pre-#485 look): a circle (default `size` 10 px since GitHub issue #701), an Arabic digit in a floor-colored knockout, a 3px border (the shared `borderWidth`), and a 10 px bold label.
- **Vertical connections** — both vector export renderers expose `replaceTwoFloorElevatorsWithStairs`, enabled by default. When enabled, an elevator whose reachable target set contains exactly one other floor is rendered with the two-way passage (stairs) settings; multi-floor elevators retain their elevator styling and badges. The setting does not alter the maze graph and is applied only while building export markers.

  There is no longer a `"line"`/`"grouped"` pattern switch — every teleport pair always merges into connection **groups** wherever an endpoint coordinate coincides across pairs (`buildTeleportGroups`, `pixi/selectors/teleportGroups.ts`, union-find over rounded coordinate keys), and grouping alone (independent of whether group *customization* is toggled on) drives canvas **draw order**: `TeleportRenderer.renderGroups` walks `buildTeleportGroups`' groups in order and, for each visible group, draws that group's own connectors immediately before that group's own points, then moves to the next group — not "every connector, then every marker" as two globally-ordered passes. This interleave is resolved by the pure `planGroupDrawOrder` (bucketing a style's routed connectors by the group their endpoints belong to), unit-tested independently of `Graphics`. Everything — connectors and markers, every mode — is drawn into one shared `Graphics` (`TeleportRenderer.view`); there is no separate line-layer/marker-layer split, since draw order between a group's own connector and marker only means anything within one shared surface. A connector's own color/border can be overridden by either endpoint's group. Each group point's fill state — filled (own `color`), outline (empty, `floorColor` fill) or mixed (disagreeing edges through the same point) — is resolved by `resolvePointFillState`. A `"mixed"` point draws a diagonal-split look (shared `drawMarker` helper in `TeleportRenderer.ts`): the filled half is drawn at a slightly larger radius (`r` grown by half the border width) than the outline, masked by a same-formula-at-the-enlarged-scale diagonal cut, so it reaches fully under the border stroke with no visible gap at the seam.

  `buildTeleportGroups` groups by coordinate regardless of whether `fromNode`/`toNode` are set on an edge — the union-find itself only needs coordinates. `fromNode`/`toNode` (populated by `buildTeleportEdges` for `VectorByWallsRenderer`'s caller only) matter solely for `teleportEdgeKey`'s node-id-based group identity (stable across a merge chain the way a position-based fallback key can't fully guarantee for *persisted* customization); callers without node ids (e.g. `PresetConnectionsRenderer`'s `buildPresetTeleportEdges`) still group and draw correctly via the position-based fallback, just without a guaranteed-stable `TeleportGroup.key` across merges — irrelevant to them since they never persist per-group overrides.

- **Splits** (issue #294, placed after Teleports, hidden entirely when no floor of the maze has a split point — `maxSplitNodeCount(unscopedNodes) === 0`, see "Section visibility is project-wide" above; `maxSplitNodeCount` groups nodes by `(level, x, y)`, not `(x, y)` alone, so a stack of one node per floor at the same cell — routine in a multi-floor project — is not mistaken for a split point and does not force the section open) — per-split-node-slot identity colors (`splitNodeColors: number[]`) plus a "Special shapes" toggle (`splitSpecialShapes`, on by default). The panel shows exactly as many color rows as the maze's largest split point actually needs (`maxSplitNodeCount`); an untouched slot displays (and, until edited, renders with) `splitSlotColor`'s own default palette (`canvas.node.splitSlots` for slots 0-2, `buildPalette`'s rotating hue wheel beyond that) — `buildEffectiveSplitNodeColors` (`VectorByWallsRenderer.ts`) is what backfills any slot the user hasn't touched yet with that same default before building the render geometry, so the panel's displayed color and the canvas's drawn color never disagree. `setVectorByWallsSplitNodeColor` grows the `splitNodeColors` array on demand, filling any skipped intermediate slots with their own default rather than leaving them sparse.

  The "Special shapes" toggle recognizes a split point's topology (`SplitSpecialShapeKind`, `pixi/renderers/types.ts`, `detectSplitSpecialShapeKind` in `splitFaceLayout.ts`) and draws dedicated geometry instead of the generic per-node segment reading. Degree-4 **"bridge"** points use two 4-point edges: full width at the cross faces, a flat 60%-wide deck, and the original gradual 20% taper at each end. Degree-4 **"diagonal"** points use the real dividing corner pair. Degree-6 **"hex_bridge"** points use the same bridge construction at 60°, but retain the sharp taper of `0.08 * (1 - 0.6) / (1 - 0.4)` (approximately 5.33% of the bridge length); **"hex_triple_bridge"** points draw two narrower bridges sharing the same through corridor. **"hex_diagonal"** endpoints come from `buildHexDiagonalEndpoints` according to whether the two face pairs share two, one, or zero real corners. For **"hex_triple_corridor"**, a through pair `{0,3}` with adjacent pairs `{1,2}`/`{4,5}` contributes two three-point wall polylines between boundary-corner pairs `1-3` and `4-0`; both bend toward the cell center, with their central points exactly one third of the cell's vertex-to-vertex diameter apart.

  All shapes draw in the plain wall color/width (`WallStyleOverride`, same as `wallFaces`), never a node's own identity color. Their geometry is no longer drawn by `SplitJunctionRenderer` itself (removed in the #319 follow-up) — `SplitJunctionRenderer.collectSplitWallPaths(wallFaces, specialShapes, includeSpecialShapes)` instead returns `{ paths, noCapPoints }`, plain joinable `Point[][]` geometry with no style, which every caller feeds into `WallRenderer.render`'s `extraWalls`/`extraWallsNoCap` params so special-shape lines join with ordinary walls in one shared stroked `Graphics` pass (a Pixi `join` only renders within one continuous stroke of a single `Graphics`, never across two independently-stroked ones). `WallRenderer` chains `extraWalls` together with its own solid segments via `chainPathsAtSharedVertices` and computes each chained path's own vertex degree (`vertexDegrees`): a degree-1 endpoint is a genuine free end and gets the caller's own `cap` (patched in separately as a filled circle/quad after an unconditional `cap: "butt"` stroke — see "Cap patching at T-junctions" below); any other degree (a T-junction, or a triple-point where three special-shape/wall lines converge) always draws `cap: "butt"`, since a protruding round/square cap there has no shared join with the other lines converging at that angle and visibly pokes across them. A `hex_triple_bridge` point's earlier-drawn crossing bridge, cut open wherever the later bridge's own silhouette crosses over it (`clipPolylineOutsidePolygon`, replacing an older opaque-fill occlusion that stopped working once both bridges joined into one shared stroke), produces synthetic cut-point endpoints that must never get a protruding cap even if they coincidentally round to the same vertex key as some unrelated nearby wall end — collected into `noCapPoints` and forced to `cap: "butt"` unconditionally regardless of their computed degree.

  `detectSplitSpecialShapeKind`/the shape geometry itself live in `buildSplitPassagesCore` (`mazeSelectors/split.ts`) and are computed unconditionally alongside a point's ordinary `SplitPassage` entries (`SplitPassagesResult.specialShapes`) — every split-drawing feature gets them, not just `VectorByWallsRenderer`: `SplitJunctionRenderer.render`'s `specialShapes` toggle (`SplitStyleOverride`) defaults to **on** when the caller passes no override at all, so `GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer` and `MazeOverlayRenderer` all draw recognized special-shape points via `collectSplitWallPaths` automatically; only `VectorByWallsRenderer` exposes it as a user-toggleable setting (`splitSpecialShapes`, defaulting to `true`).

  **One-way connections are never a special shape** (GitHub issue #477): `detectSplitSpecialShapeKind` returns `null` as soon as any face carries a one-way passage (`one_way_out`/`one_way_in`). Every special-shape silhouette is symmetric with no arrowhead, so recognizing one would hide the directionality; the point falls back to the ordinary per-node hub connectors instead, which draw the one-way arrow. Applies to both the drawing path and the node-point positioning below (`splitPointFaceKindsByNode` distinguishes `passage`/`one_way_out`/`one_way_in`, not just connected-or-not).

  **Not just special drawing — special node-point positioning too** (GitHub issue #318): a recognized special-shape node's marker/teleport-endpoint/debug-overlay point also moves off the generic evenly-spaced hub circle onto a shape-specific point (`specialSplitNodePoint`, `tessellationGeometry.ts`) — see `Specs/post-edit.md`'s "Marker/teleport anchoring" and "Shape-aware node point" notes for the exact per-shape geometry. Same detection (`detectSplitSpecialShapeKind`, shared via `splitFaceLayout.ts`), independent of this drawing toggle — positioning always applies once a shape is recognized, it isn't gated by `specialShapes`/`splitSpecialShapes`.

  **"Vector by corridors" drawing of the same shapes** (`VectorByCorridorsRenderer.drawSplitPassages`) is independent of wall-mode geometry and uses the corridor's plain color/thickness. `drawSplitPassages` dispatches on `renderStyle` (GitHub issue #510): `"legacy_line"` → `drawSplitPassagesLegacy` (restored pre-#493 renderer), `"contour"` → `drawSplitPassagesContour` (everything the rest of this paragraph describes). Both call the shared `setupSplitPassageDraw` for the per-call boilerplate + plain-connector pass, then run their own independent special-shape block — see the "Rendering mode" section below. Plain corridor paths always use `butt` at split-touching ends and restore round/square caps only at non-split endpoints. Bridge and triple-bridge crossings retain background-colored gap patches when `splitGapWidth > 0`. Round style draws diagonal/triple-corridor connectors as outward-bowed ribbons and may frame them with the configured gap; miter style draws straight sharp ribbons with miter seam patches and suppresses diagonal/triple-corridor gaps. The `hex_diagonal_divider` pattern (`0-1-2` / `3-4-5`) uses rounded three-port contours; its outer arcs receive the same wider background gap pass as diagonal ribbons. Ordinary three-port junctions and this divider use a dedicated shallower fillet style, while other junction arities retain the default contour geometry. The split-gap slider range is 0-10px. The UI labels `splitDiagonalBowAmount` as **Bow** and disables it for miter style.

  **Miter join stubs at ordinary corridor T-junctions** (GitHub issue #443) — the plain corridor's own chained paths (`chainSegmentsAtSharedVertices`) each draw as their own independent `stroke()` call, so a Pixi `join` never forms between two chained paths that happen to meet at the same point where chaining itself declined to extend through it (a degree != 2 vertex — an ordinary 3+-corridor T-junction, not a split hub, which `drawSplitPassages` owns entirely and is untouched by this fix): separate `moveTo`/`stroke` calls at a shared vertex draw independent caps, not a join, so a `"miter"` setting's own `cap: "square"` visibly poked out at every such T-junction instead of mitering cleanly. Every chained path here draws `butt` unconditionally first (never protrudes), then each of its own two non-split ends is patched back in separately — a genuine free end (nothing else meets it there) gets a plain round/square cap same as an ordinary stroke would draw, but a T-junction where 2+ chained paths' own ends meet gets one shared **miter polygon** instead of each path patching its own end independently (an earlier attempt at the latter left visible gaps between the independent per-path patches at non-perpendicular junction angles — each path's own patch only ever follows *that* path's own direction, not its neighbors'). The polygon comes from `computeMiterJunctionPatch` (`vectorByCorridorsGeometry.ts`) — pure geometry, no `Graphics` dependency: given every ray converging on the junction (direction + own stroke width), it sorts them by angle and, for each pair of angularly-adjacent rays, intersects the two offset edges facing each other (each ray's own edge offset `width/2` perpendicular to its direction) — exactly the same construction a real stroke `join` computes for two adjacent segments of one path, generalized to N rays with no shared path to stroke them as one. A near-180° adjacent pair (mirrors Pixi's own `miterLimit`) falls back to the two edges' own endpoints instead of an arbitrarily far corner. On a fixed tessellation the same small set of ray-angle patterns repeats at every T-junction, so the function is pure/side-effect-free specifically to allow memoizing by a rounded-angle+width key, though the renderer itself doesn't cache yet. Diagonal ribbons use the sharp seam geometry described above; other split-shape connectors retain their own per-line cap behavior.

  **Group customization** (`teleportGroupCustomization` toggle) layers per-group overrides on top of the base style: every group shares one style unless overridden via `TeleportGroupOverride` (fillColor/borderColor/shape, each falling back to the shared style when unset), stored in `VectorByWallsSettings.teleportGroupOverrides` keyed by `TeleportGroup.key`. `borderColor` is the group's "secondary" color (the panel's own tooltip, GitHub issue #503 follow-up, calls it out by name) — besides the marker's own border and this group's connector color, it also drives this group's own cross-floor badge fill *and* border, in place of the base style's `floorBadge.fillColor`/`borderColor` (`TeleportRenderer.drawGroupPoints`). Each override is named in the color picker's "Project colors" list (GitHub issue #503 follow-up) as "Teleports: Group N fill"/"Group N border" — `N` is the group's 1-based *display* order (`PC.teleportGroup(index, role)`, `projectColorsSelector.ts`), not its internal `key` (an unstable coordinate-pair string) — both the selector and the panel sort by the same `key.localeCompare` `buildTeleportGroups` already uses, so a color's "Group N" always matches the row numbered N on the panel. Each group row's own fill/border swatch lists, as its own "Project colors" priority group: this group's own other color first, then every other group's fill+border colors (in the same group order), then the section's common teleport colors (edge/border/connector/badges) last. The settings panel's group list is built over the *whole project* (GitHub issue #484), so every teleport connection group is customizable regardless of which floor is displayed and switching floors never changes the list. `useTeleportGroupsAndCollisions` (`TeleportSettingsSection.tsx`) builds the list **one floor at a time** — for each floor, `selectFloorScopedMaze` + `buildTeleportEdges` with the *exact same* `TeleportFloorContext` and badge-spread inputs that floor's own `VectorByWallsRenderer`/`VectorByCorridorsRenderer` passes, then `buildTeleportGroups` — and merges the per-floor results by `TeleportGroup.key`. Those `{ floorContext, spread }` inputs come from the shared `buildTeleportFloorInputs` helper (`mazeSelectors/teleport.ts`) — the same helper every floor-aware `buildTeleportEdges` caller uses (`GenerationRenderer`, `AnalyticsRenderer`, `PostEditRenderer`, both vector export renderers), so the hook can't drift from what the renderers pass; `spread` is floor-independent, built once, and only `floorContext.activeFloorIndex` is swapped per floor in the loop. Per-floor (not once over the unscoped `nodes`/`edges`) is required because `buildNodePositions` keys nodes by `(x, y)` with no floor component and `buildTeleportGroups`' union-find merges by rounded coordinate: two unrelated teleports at the same cell on different floors, built together, would collapse into one group whose `key` no per-floor renderer ever produces, and an override set against it would silently never apply. Building per floor keeps every list key identical to the key that floor's renderer resolves overrides against. A cross-floor pair is built once, on its `from` node's floor (far endpoint resolved via the `floorContext`), so it appears exactly once in the merged list. The on-canvas hit areas and selection stay per-floor (a group whose pair is entirely on another floor has a row but nothing to click on the canvas). Each group's canvas hit area (only wired while the Teleports section is expanded — `interactive: true`, gated on `vectorByWallsSectionsExpanded.teleports` AND `teleportGroupCustomization`) is its own invisible circle of radius `size + 4px`, bucketed into a `hitRadius`-sized spatial grid so a click only scans its own 3x3 cell neighborhood instead of every point of every group. The Teleports section's group list (one `TeleportGroupRow` per group, in `buildTeleportGroups`' sorted-key order) shows an `AlertTriangle` warning icon on any group whose *resolved* color+shape (after its own override falls back to the shared style) exactly matches another group's, but only when the connector style is `"none"` (with a connector drawn, two groups sharing a look are still visually distinguishable by which links connect to what).

  **Selection is click-driven, not hover-driven** (`selectedTeleportGroupKey` in the store, `setSelectedTeleportGroupKey`) — clicking a group's marker on the canvas, or its row in the settings list, selects it; clicking the already-selected group/row again, or pressing `Escape`, clears the selection. Selecting a group hides every other group entirely (`renderGroups` skips the draw call for a non-visible group's connectors/points — cheaper than the alpha-based dimming an earlier version used, since `Container.alpha` composited overlapping translucent shapes independently and showed them through each other at the seam; a hidden group's points still get an invisible hit-circle so it stays clickable to re-select). Collapsing the Teleports section, or turning group customization off, synchronously clears `selectedTeleportGroupKey` (in the same click handler that triggers the collapse/toggle, not a `useEffect` reacting to it afterward) so a stale selection can't dangle invisibly and reappear already-selected next time the section reopens or customization is turned back on. The row's own mouse-over highlight is native CSS `:hover` (`.teleport-group-row` in `global.css`), a separate concern from the `data-selected` attribute driving the actual selection look (both can be true independently without one overriding the other's specificity).

- **Vertical connections** (issue #347, placed after Teleports; hidden entirely unless the maze has at least one `VerticalPassage`/`Elevator` edge of some kind — GitHub issue #686, a multi-floor maze with no vertical connections no longer shows this section at all) — `VerticalPassage`/`Elevator` edges (`EdgeDto.kind`, GitHub issue #337; see `Specs/generation.md`'s "Vertical Connections") draw as a single point-anchored marker on the edge's `from` node's own cell, never as a connector line to another drawn point — the `to` node lives on a different floor, entirely absent from this image (`VerticalConnectionMarker`, `buildVerticalConnectionMarkers` in `mazeSelectors.ts`). `VectorByWallsRenderer` is the first (and so far only) mode renderer that's actually floor-aware: `selectFloorScopedMaze` (`mazeSelectors.ts`) narrows `state.nodes`/`state.edges` down to `activeFloorId` before handing them to every geometry selector below — the same scoping `GenerationRenderer`'s own `debugView` used inline before this issue factored it out into a shared function. An edge survives the floor cut once its `from` is on the active floor, even though `to` never is by construction; `selectNodeLevelResolver` (also `mazeSelectors.ts`), built from the *unscoped* node list, is the narrow "ask a node's own floor by id" interface a floor-scoped caller uses to resolve `to`'s floor without needing the whole unscoped list passed around — used here to compare a `VerticalPassage`'s target floor against the active one for its direction arrow.

  Once the section itself is shown, settings split into **three always-visible sub-groups** (GitHub issue #464), each with its own plain-weight, collapsible header (chevron + click-to-toggle, same mechanism as every top-level `SectionHeader` but styled at the sub-group's own smaller visual weight — GitHub issue #347 third follow-up; keyed `vertical_two_way`/`vertical_one_way`/`vertical_elevator` in `vectorByWallsSectionsExpanded`, starting collapsed like every other section) — Two-way passage, One-way passage, Elevator. A header is disabled and cannot be expanded when the current maze has no edge of that specific kind. Presence is checked against the *unscoped* `rawEdges` (the full, not floor-scoped, edge list), not the same `selectFloorScopedMaze`-narrowed `edges` the rest of the section's geometry selectors use — a two-way `VerticalPassage` is stored as two directed edges (`a->b`, `b->a`) whose own `from` ends sit on *different* floors by construction (`try_add_bidirectional_vertical_passage`, `maze-core/src/generation/edge_ops.rs`), so `selectFloorScopedMaze` (which keeps an edge only when its own `from` is on the active floor) can never let both halves of one forward/reverse pair survive together for any single floor — checking the reverse-pair match against floor-scoped edges would make the "two-way passage" sub-group structurally unable to ever appear (GitHub issue #347 third follow-up fix). A two-way `VerticalPassage` edge counts once its reverse pair (`to->from`) is also present in `rawEdges`; a one-way `VerticalPassage` edge counts once it isn't; `Elevator` presence is a plain `kind === "elevator"` check (always two-way by construction, no pairing needed). The one lone shared control across all three sub-groups is `VectorByWallsSettings.verticalStyle` — it gates the whole section's display style, not any single sub-group.

  When `verticalStyle === "abstract"` (GitHub issue #347), each sub-group owns its own `MarkerSettings` (`twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`) and its own arrow color/size/style/corner-style quadruple (`twoWayArrowColor`/`twoWayArrowSize`/`twoWayArrowStyle`/`twoWayArrowCornerStyle`, and the `oneWay`/`elevator`-prefixed equivalents) — before the #347 follow-up, two-way and one-way `VerticalPassage` markers shared one `verticalPassageMarker`/arrow-color/arrow-size triple, which meant changing a one-way passage's arrow color also (invisibly) changed the two-way passage's, and vice versa for fill color.

  When `verticalStyle === "decorative"` (GitHub issue #428), each sub-group instead owns a `DecorativeLineStyle` (`decorativeStairsTwoWay`/`decorativeStairsOneWay`/`decorativeElevator` — `lineColor`/`lineWidth`/`size`, no fill/border/gap/shape concept, since the pictogram is a stroke-only icon, not a filled marker shape; default line width `2`, GitHub issue #428 fifth follow-up, lower than the marker-shape sub-groups' own default border width since a stroke-only pictogram reads better thinner) drawn by `VerticalConnectionRenderer.ts`'s `drawStairsIcon` (an open stairs zigzag for `VerticalPassage`) or `drawElevatorIcon` (a shaft box outline, a center doors-split line, two cable strokes above it, for `Elevator`). The stairs zigzag (`stairsZigzagPoints`) draws `STAIRS_STEPS` (3) ascending risers interleaved with `STAIRS_STEPS - 1` horizontal shelves — starting on a vertical riser (a fourth follow-up reverted an earlier attempt at a horizontal-start shape, which read as a landing stub rather than stairs at this scale) but ending on a horizontal shelf, since one more riser than shelf nets a shelf as the last drawn segment; this start/end asymmetry is intentional, confirmed during the GitHub issue #428 review follow-up, not a bug.

  Only the stairs pictogram draws a direction arrow, via a dedicated primitive (`drawStairsArrow` — a line parallel to the stairs' own diagonal run, offset well above it (perpendicular, screen-up, clear of the top-most riser — GitHub issue #428 fourth follow-up widened this offset after the arrow was found running right through the steps), with an arrowhead at one end (`headLen`, GitHub issue #428 fifth follow-up enlarged from `0.5 * halfLen` to `0.7 * halfLen`), not `OneWayPattern`, which reads as a point indicator rather than a direction-along-a-line one): a two-way passage draws it in `decorativeStairsArrowColor`/`decorativeStairsArrowSize` — defaulting to the same color as the stairs line itself (`canvas.vertical.default`, GitHub issue #428 fourth follow-up), not a separate gray — every marker, two-way or one-way, gets an arrow, since `VerticalConnectionMarker.direction` is set for both (see below); a one-way passage draws it in its own `decorativeStairsOneWayArrowColor`/`decorativeStairsOneWayArrowSize` (GitHub issue #583 — previously named `decorativeStairsAccentColor` and shared the two-way passage's own `decorativeStairsArrowSize`, with no independent size control of its own) at both ends. Both ends draw a perpendicular tick, same color, same gap (`halfLen * 0.5` from the shaft's own nearest end, GitHub issue #693 tick-gap follow-up — matching gaps so both ends read consistently): the arrival end (`arrowFilled: false`) draws **crossed-out** — the ordinary arrowhead at the tip, plus the tick placed just *past* the tip, in the direction the head itself points (`"->|"`, GitHub issue #428 seventh follow-up moved the tick from just short of the tip — where it read as sitting at the head's own base — to just past it; sixth follow-up before that moved it here from the line's own tail entirely; fifth follow-up fix before that made the crossed-out arrow draw a head at all, having previously omitted it and drawn only the tick); the departure end (`arrowFilled: true`) draws the same tick **tail-ticked** instead — past the shaft's own bare tail, with no arrowhead there (GitHub issue #693, decorative follow-up) — the line-icon analogue of the abstract marker style's own wall-tick pair (see below), both ticks reading as the same physical wall seen from each end. Which end of the diagonal gets the arrowhead mirrors `marker.direction` (GitHub issue #428 third follow-up: "the arrow must point toward the marker's own connection target, not always the same end") — `"up"` points the head at the diagonal's own up (top-right) end, `"down"` at its down (bottom-left) end. `Elevator` never draws an arrow of its own, decorative or not, per the original issue's own no-decorative-elevator rationale for the *marker-shaped* treatment — a line icon reads fine without a literal illustration, so `Elevator` still gets its own decorative pictogram, just never an arrow.

  `VectorByWallsSettings.verticalStyle` (`"abstract"` default / `"decorative"`, GitHub issue #347 follow-up renamed from `verticalPassageDisplayStyle`, `"marker"` renamed to `"abstract"` — a pre-follow-up project file's legacy field name/value still loads correctly via `validateVerticalSettingsFields`'s own fallback) — `"abstract"` draws a plain shape (same `MarkerSettings`-shaped fields as the start/finish markers: shape/corner style/fill/border/gap/size, own defaults per marker so two-way passage/one-way passage/`Elevator` read apart with no configuration), matching the issue's own "cut an opening here" build-marker rationale; `"decorative"` draws a line-only pictogram instead (see above), meaningful for a maze printed as separate per-floor sheets. A third `"realistic"` value (more literal/detailed rendering — shaded steps, railings, an elevator shaft look) was considered (GitHub issue #429) and rejected — it doesn't fit the schematic nature of the vector-by-walls renderer.

  Every marker — two-way passage, one-way passage, and elevator alike — draws a direction arrow on top of its own marker/stairs: `VerticalConnectionMarker.direction` is set for every marker, including two-way ones, since a two-way connection still has a real "which floor(s) does this lead to" to point at. There's no geometric "up/down" in a single 2D floor image, so the arrow always points straight up or down (or both, for a bidirectional elevator) on screen rather than toward any particular geometric direction. The arrow's own **shape** is one of the same three patterns the plain wall one-way indicator uses (`OneWayPattern`: triangle/chevron/arrow, `<kind>ArrowStyle`) with its own corner style (round/miter, `<kind>ArrowCornerStyle`) — dispatched to the shared `drawOneWayTriangle`/`drawOneWayChevron`/`drawOneWayArrow` primitives (`wallUtils.ts`, same ones the "One-ways" section's own indicator uses) via `drawArrowPattern` (`VerticalConnectionRenderer.ts`), rather than a bespoke hand-built triangle (GitHub issue #347 third follow-up — previously always a fixed filled triangle). In addition to those glyphs, `"sign"` renders a compact `+` for up and `-` for down; for a bidirectional marker it renders both signs. `drawArrowPattern` derives the stroke's own `cap` from `<kind>ArrowCornerStyle` the same way `buildOneWayStyle` (`exportStyleBuilders.ts`) does for the wall one-way indicator (`cap: "square"` for `"miter"`, `"round"` otherwise) — `join` and `cap` are two separate pixi stroke options (corner vs. line-end), so a chevron/arrow pattern's own open stroke ends need `cap` set too, not just `join`, or the corner-style picker would only ever visibly affect the filled triangle pattern's own rounded corners.

  `<kind>ArrowSize` (0-1, a fraction of the marker's own radius) is normalized so `1` always makes the arrow's own **tip** reach exactly the marker's own radius, for every pattern — `drawArrowPattern` rescales the `size` it passes down to `wallUtils.ts` by `1 / patternTipFraction(pattern)` first (GitHub issue #347 fourth follow-up), since the three shared primitives don't agree among themselves on what fraction of their own `size` param reaches the tip: `drawOneWayChevron`/`drawOneWayArrow` both put their tip at exactly `size` (`patternTipFraction: 1`, no rescale needed), but `drawOneWayTriangle`'s own tip sits at only `0.65 * size` (its own "tip 65% ahead" convention, GitHub issue #292 follow-up) — left unrescaled, a triangle at `arrowSizeFraction: 1` visibly fell well short of the marker's own edge while a chevron/arrow already reached it exactly.

  A two-way passage/elevator's arrow(s) draw filled, solid, in the sub-group's own arrow color (`marker.filled === true` -> `drawArrowFilled`, an ordinary single pattern draw); a one-way passage's two ends (GitHub issue #347 fourth follow-up redesign) now both draw a solid arrow too — the old outline-only arrival-end treatment (a larger pass in the arrow color underneath a smaller pass in the gap color) is gone, replaced by the arrival/departure distinction described below on the marker's own fill/border instead. Each sub-group's own `<kind>ArrowColor`/`<kind>ArrowSize` directly set that sub-group's arrow color/size, defaulting to `twoWayArrowStyle`/`oneWayArrowStyle`/`elevatorArrowStyle: "triangle"` and `*ArrowCornerStyle: "round"`, `<kind>ArrowSize: 0.75` (raised from `0.6` in GitHub issue #347's fifth follow-up) — every live-canvas renderer without a settings panel of its own (`GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer`, `AnalyticsRenderer`) uses the same fixed values via its own fixed `VerticalConnectionStyle`. `chevron`/`arrow`'s own stroke thickness (`triangle` has no stroke of its own, being a filled shape) scales linearly with `arrowSizeFraction` too (`arrowThickness`, `VerticalConnectionRenderer.ts`, GitHub issue #347 fifth follow-up) — `2`px at the slider's own minimum (`0.2`) up to `4`px at its maximum (`1`), so a shrunk arrow doesn't keep drawing with the same fixed-width stroke a full-size one does.

  A bidirectional elevator's two arrows (one per direction) spread apart by a **fixed fraction of the marker's own `radius`** — `originOffset = radius * 0.4` for `triangle`/`arrow`, `radius * 0.5` for `chevron` (GitHub issue #347 sixth follow-up: chevron's own pair widened again after the fifth follow-up's `0.55 -> 0.4` tightening read too cramped for that pattern specifically) — never of the arrow-size fraction itself, otherwise shrinking the arrow-size slider would also shrink the gap between the two arrows, making them visually converge toward the marker center instead of shrinking in place around their own fixed spot (GitHub issue #347 third follow-up regression fix). Which **axis** the pair spreads along depends on the pattern: `chevron`/`triangle` spread **vertically** — stacked one above the other, each still pointing its own up/down, matching how it used to be positioned before the pattern dispatch existed; `arrow` spreads **sideways** (its own shaft/head reads cramped if stacked vertically). The sixth follow-up had briefly moved `triangle` onto the sideways spread too, but the seventh follow-up reverted that — a vertically-stacked triangle pair reads better once each triangle also draws smaller, so a stacked `triangle` pair now additionally draws at `0.75 *` the ordinary `arrowSizeFraction`-derived size (`pairArrowSizeFraction`, only for `dys.length > 1 && arrowStyle === "triangle"`; a single triangle and every other pattern/pair combination still draw at the ordinary size). Their shared `oy` is additionally compensated per pattern (`patternMidpointOffset`, expressed as a fraction of the caller's own tip-reach `size` — the *pair's own, possibly `0.75`-scaled* size for a stacked triangle pair, not the rescaled `drawnSize` passed further down) so both arrows' own visual tip/base midpoints land symmetrically around the marker's own center regardless of which pattern is selected — none of the three shared primitives is actually centered on its own `(cx, cy)` input: `drawOneWayChevron` draws its tip/back directly off the input with no internal recentering (visual midpoint `0.2 * size` ahead of the input); `drawOneWayTriangle` recenters internally around a `roundPoly` centroid, netting a much smaller residual offset (`-size/39`, after folding in the tip-reach rescale above) than its own input-relative tip/base numbers alone would suggest; `drawOneWayArrow`'s tail/tip are exactly symmetric (offset `0`). Mirrors the old hand-built `drawDirectionArrow`'s own single `size*0.25` compensation constant, generalized to one constant per pattern when the pattern dispatch was introduced. A **single** (non-paired) `chevron` uses a stronger empirical midpoint fraction, `0.3` instead of the pair's own `0.2` (GitHub issue #347 sixth follow-up: a lone chevron read visibly off-center toward its own back/base with the pair's compensation value) — `triangle`/`arrow` use the same `patternMidpointOffset` value whether alone or paired, only `chevron`'s single case differs.

  Rendered by `VerticalConnectionRenderer` (`pixi/renderers/`), its own instance per `maze-web/CLAUDE.md`'s feature-renderer ownership rule — factored out as a standalone low-level primitive (alongside `WaypointsRenderer`/`TeleportRenderer`) specifically so a future floor-aware `GenerationRenderer` could own its own instance the same way.

  `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`'s `cornerStyle`/`size`/`borderWidth`/`gapWidth` are wired into "Shared style" (GitHub issue #322 follow-up, generalized to the generic `ParamLink` engine by #643) the same mechanism `startMarker`/`finishMarker` use — a `"twoWayPassageMarker.<field>"`/`"oneWayPassageMarker.<field>"`/`"elevatorMarker.<field>"` link per group in `DEFAULT_VECTOR_BY_WALLS_LINKS`/`DEFAULT_VECTOR_BY_CORRIDORS_LINKS`, and the panel's own per-field `OverrideResetButton`s on each sub-group's `MarkerSettingsGroup` corner-style/size/border-width/gap-width rows — but those links **start `enabled: false`** in all four groups, unlike `startMarker`/`finishMarker` (whose links start out enabled, following the shared value). This is deliberate: all three vertical markers' own default (`DEFAULT_VERTICAL_SETTINGS`) is derived from `DEFAULT_MAZE_RENDER_STYLE.verticalConnections` (also exposed to existing live-canvas callers through the `DEFAULT_VERTICAL_STYLE` alias) — border width 3 for all three of `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker` — raised from `2` in GitHub issue #347's sixth follow-up for the first two, seventh follow-up for `elevatorMarker`; size 0.22 for all three, rather than the Shared style baseline (border width 3, size 0.16) — so the exported image looks identical to the editor view until changed — the user can still pull a field onto the shared value via its own reset button. `shape`/`fillColor`/`borderColor` stay independent, same as `startMarker`/`finishMarker`'s own fill/border colors. Default fill colors are chosen so the three sub-groups read apart out of the box: all three fill with `canvas.vertical.default` (elevator additionally uses a diamond shape to read apart from the passage's circle) — a one-way passage's two ends draw with the same ordinary fill/border as the two-way marker (GitHub issue #693); they're told apart from each other by the wall-tick indicator described below, not by a distinct fill color.

  **Vertical "Shared style" group** (GitHub issue #668) — one level up from the per-group
  `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker` links above: a dedicated "Shared
  style" subsection inside the "Vertical connections" section itself, so all three sub-groups'
  marker look and arrow look can be driven from one place without touching the panel-level
  "Shared style" section (which stays reserved for fields shared with the start/finish/teleport
  markers too). `VerticalSharedStyleFields` (`imageExportTypes.ts`) mirrors `MarkerSettings`' own
  shape, for both `VectorByWallsSettings` and `VectorByCorridorsSettings`: `verticalCornerStyle`,
  `verticalShape`, `verticalSize`, `verticalBorderWidth`, `verticalGapWidth`, `verticalFillColor`,
  `verticalArrowColor`, `verticalArrowSize`, `verticalArrowStyle`, `verticalArrowCornerStyle` — plus,
  walls-only, `verticalDecorativeLineColor`/`verticalDecorativeLineWidth`/`verticalDecorativeSize`/
  `verticalDecorativeArrowSize` for the decorative pictogram style. `verticalSize`/`verticalArrowSize`
  are abstract-only (GitHub issue #677 follow-up, split from an earlier shared pair) — the decorative
  style's own "size"/"arrow size" (the stairs line's length / the arrow drawn along it) are visually
  unrelated to the abstract marker's own radius/internal arrow, so they're independent fields
  (`verticalDecorativeSize`/`verticalDecorativeArrowSize`), not the same field reused across modes.
  Each source field links to its three per-group counterparts
  (`"twoWayPassageMarker.<field>"`/`"oneWayPassageMarker.<field>"`/`"elevatorMarker.<field>"`, or the
  matching `<kind>Arrow*`/`decorativeStairs*`/`decorativeElevator.lineColor`/`lineWidth`/`size` field;
  `verticalDecorativeArrowSize` links only to `decorativeStairsArrowSize`/`decorativeStairsOneWayArrowSize`
  — `decorativeElevator` has no arrow of its own, see "Vertical connections" above) via
  `DEFAULT_VECTOR_BY_WALLS_LINKS`/`DEFAULT_VECTOR_BY_CORRIDORS_LINKS`, same disabled-by-default
  convention as every other vertical link — editing a sub-group's own field through its per-group
  setter disables just that one link, leaving the other two groups still following the shared value.
  The panel splits this subsection's fields the same way the per-group sub-groups do: a "Marker" row
  block (shape/corner style/size/border/gap/fill) shown only for `verticalStyle === "abstract"`
  ("Vector by corridors" has no `verticalStyle` at all, so it always shows this block) and an "Arrow"
  block (color/size/style/corner style) shown the same way, plus a decorative-only flat row block
  (size/arrow size/line width/line color) for walls-mode `verticalStyle === "decorative"` —
  `parameterLinksActivity.ts`'s `VERTICAL_SHARED_STYLE_ABSTRACT_ONLY`/`_DECORATIVE_ONLY` sets gate
  which half is active in the parameter-links dialog, mirroring this same split. Both the abstract and
  decorative field sets are registered under the very same `group` path (`G.verticalSharedStyle()` —
  the settings panel has exactly one "Shared style" subsection, not a separate one per mode) rather
  than a mode-specific group each: since their `label`s would otherwise collide (e.g. both pairs read
  as "Marker size"/"Arrow size"), each decorative-only label instead carries an appended
  "(Декоративный)" suffix (`decorativeLabel`, `parameterLinksRegistry.ts`) and each abstract-only one
  a "(Абстрактный)" suffix (`abstractLabel`) — this one-shared-group-plus-label-suffix convention is
  used throughout the "Vertical connections" section below for every field that exists in only one
  `verticalStyle` mode, not just here; fields that render identically in both modes
  (`elevatorBadges.*`, `replaceTwoFloorElevatorsWithStairs`) carry no suffix, having no same-group
  counterpart to disambiguate from. `verticalFillColor`/
  `verticalArrowColor`/`verticalDecorativeLineColor` are registered in the color picker's "Project
  colors" list as `PC.verticalFill`/`PC.verticalArrow`/`PC.verticalDecorLine` (`projectColorsSelector.ts`,
  `verticalSharedStyleColors`) under the dedicated `vertical` section label "Верт. общий стиль" — shown
  only for the matching `verticalStyle` (`verticalFill`/`verticalArrow` for abstract, `verticalDecorLine`
  for decorative; corridors is always abstract), same mode-gating as the panel rows themselves. Every
  per-group marker/arrow fill/border/arrow color row's own `priorityColors` ends with these two shared
  colors (then the floor/background tail) so a user editing e.g. `twoWayPassageMarker.fillColor` sees
  the vertical shared-style fill/arrow colors as nearby picks; symmetrically, `verticalFillColor`'s own
  priority list leads with `verticalArrowColor` (and vice versa), never both at once via a shared tail
  constant — the two are siblings of each other, not each other's own downstream receiver.

  **One-way passage wall-tick indicator** (GitHub issue #693, replacing the earlier GitHub issue #347 fourth/fifth follow-up accent-color redesign): a one-way `VerticalPassage`'s two markers (`filled: false` on both ends, `VerticalConnectionMarker`'s own doc comment) draw the ordinary fill/border — same `oneWayPassageMarker.fillColor`/`borderColor` on both ends, no accent tint, matching the two-way/elevator marker's own look. Directionality is instead shown by `drawOneWayWallTick` (`VerticalConnectionRenderer.ts`): a filled rounded rect perpendicular to the direction arrow, drawn in the arrow's own color — not a stroked line, so its own ends read with the same corner style as the triangle arrowhead rather than a stroke's round-cap bulge. Its corner radius (`ONE_WAY_WALL_TICK_CORNER_RADIUS_FRACTION`) matches `drawOneWayTriangle`'s own `roundPoly` corner radius exactly (both derived from the same `size`-fraction geometry), and its length (`ONE_WAY_WALL_TICK_LENGTH_FRACTION`) matches the triangle's own base width, so the tick reads as "the wall this end runs into" at the same visual scale as the arrowhead itself; its thickness is the arrow's own stroke thickness, thinned 25% (a rounded rect reads visually heavier than the old stroked line at the same thickness value). Placed along the arrow's axis near its **tail** for the departure end (`arrowFilled: true`, "from" — the wall you'd meet walking back the way you came) or near its **tip** for the arrival end (`arrowFilled: false`, "to" — the wall this passage dead-ends into, the reason you can't walk back out); both ticks mark the same physical wall, seen from each end. The arrow+tick pair is centered as a whole on the marker (`patternVisualTipFraction`/`patternBaseFraction`, both exported from `VerticalConnectionRenderer.ts` and reused by `toolGlyphs.ts`'s own glyph copy) — not just the arrow alone, which would leave the tick sitting off to one side of the marker's true visual center; `patternVisualTipFraction` accounts for the triangle pattern's own `roundPoly` corner rounding, which cuts its sharp tip back along the axis by a non-negligible amount relative to its nominal unrounded reach. Never drawn for the `"sign"` arrow style (a plain +/- glyph has no directional axis to place it against) or for an elevator's bidirectional arrow pair (no single departure/arrival end to anchor it to). The former `oneWayAccentColor` field and its "Secondary color" settings row are gone — the one-way sub-group's `MarkerSettingsGroup` now shows the ordinary "Border color" row, same as the two-way sub-group.

  Each of the three vertical sub-groups (`vertical_two_way`/`vertical_one_way`/`vertical_elevator`) is itself split into two further sub-subsections (GitHub issue #347 seventh/eighth follow-up), scoped to this section only — no other panel section got this treatment: "Marker" (the sub-group's own `MarkerSettingsGroup`, identical shape/corner-style/size/fill/border/gap rows for all three sub-groups, including one-way — GitHub issue #693 removed the one-way sub-group's former "Secondary color" row) and "Arrow" (`<kind>ArrowColor`/`<kind>ArrowSize`/`<kind>ArrowStyle`/`<kind>ArrowCornerStyle`, renamed from "Arrows" in the eighth follow-up; each of these four rows also dropped its own trailing "arrow" word — "Color"/"Size"/"Style"/"Corner style" — since the "Arrow" sub-subsection header already establishes that). Unlike the outer sub-group, these two are **plain indented labels, not collapsible** (GitHub issue #347 eighth follow-up: the sixth/seventh follow-ups' own nested-collapsible treatment was reverted) — always visible once their parent sub-group is expanded, following the same plain-label pattern `MarkerSettingsGroup`'s own `title` prop already uses for "Start"/"Finish".

  This "Marker"/"Arrow" split also applies when `verticalStyle === "decorative"` (GitHub issue #583): the two-way sub-group's `DecorativeLineStyleGroup` (line color/width/size) sits under "Marker", with its own "Arrow" sub-subsection below it (`decorativeStairsArrowColor`/`decorativeStairsArrowSize`) — and the one-way sub-group now mirrors this exactly, with its own "Arrow" sub-subsection (`decorativeStairsOneWayArrowColor`/`decorativeStairsOneWayArrowSize`) below its `DecorativeLineStyleGroup`, so the one-way pictogram's arrow size is configurable independently of its own image size the same way the two-way pictogram's already was. Before #583, the one-way sub-group had no "Arrow" sub-subsection at all — its single "Secondary color" row (`decorativeStairsAccentColor`, renamed to `decorativeStairsOneWayArrowColor` by the same issue since the field only ever colors the arrow, never a marker accent) doubled as the arrow's color with no way to size it independently of the two-way passage's own `decorativeStairsArrowSize`, which it silently shared.

  **`vertical_on_special_split` export warning** — mirrors `waypoint_on_split`/`teleport_on_special_split`: a marker's `from` node lands on a split point recognized as a special shape (bridge/diagonal), only when `splitSpecialShapes` is on. Folded into `computeVectorByWallsWarnings` (`exportWarnings.ts`), "Vector by walls"-only — "Vector by corridors" has no vertical-connection reading of its own.

  **Elevator floor-number badges** ("Floor badges" section, GitHub issue #430) — a small ring of badges around an `Elevator` marker, one per floor its own node's fan actually reaches, layered on top of whichever `verticalStyle` is active (abstract or decorative alike — orthogonal to marker look, since it's drawn by the same `VerticalConnectionRenderer` regardless of which marker-drawing branch ran). Off by default (`elevatorBadges.enabled`). Which floors to badge is resolved once in `buildVerticalConnectionMarkers` (`mazeSelectors/vertical.ts`): `VerticalConnectionMarker.targetFloorIndices` collects every distinct floor an `Elevator`'s own fan of edges (all edges sharing that marker's `from` node) resolves to via `resolveNodeLevel`, deduplicated and sorted ascending — `undefined` for a `vertical_passage` marker (already covered by the singular `targetFloorIndex`) and for an `elevator` marker whose fan resolves no floor at all. Settings (`ElevatorBadgeSettings`, `imageExportTypes.ts`): `enabled`, `labelType` (`"arabic"`/`"roman"`/`"letters"` — a badge always displays `targetFloorIndex + 1`, the same 1-based convention `drawFloorBadge` uses, formatted by `formatElevatorBadgeLabel`), `size` (px diameter of the badge fill, default 12 — GitHub issue #701; before it a fraction of the elevator marker's radius; the outer edge adds `borderWidth`, so `badgeRadius = size / 2 + borderWidth` for layout, hit area and the overlap/too-many warnings), `placement` (`"full_circle"`/`"left_right"`/`"right_left"`/`"top_bottom"`/`"bottom_top"`, `"full_circle"` listed and offered first in the panel — see below), `evenDistribution` (off by default — see below), `distance` (px past the marker's own radius), `gap` (px between adjacent badges' own edges, default `2` — badges never touch by default, unlike `distance` which defaults to allowing it; disabled in the settings panel only for `"full_circle"` *with* `evenDistribution` on, since that's the one combination where it has no effect), `gapWidth` (px, default `2` — a floor-colored ring drawn around each badge's own border, same visual convention `MarkerSettings.gapWidth`/`WaypointsRenderer`'s gap ring uses: within one elevator's own badge set, all gap rings draw first, then all badge fills on top, so a neighboring badge's gap ring can never end up drawn over an already-drawn badge's own fill (`drawElevatorBadgeGap`/`drawElevatorBadgeBody`, round-4 GitHub issue #430 follow-up two-pass split of what used to be one combined per-badge draw call). Colored from `elevatorMarker.gapColor`, which already mirrors the caller's own floor color — no separate floor-color parameter threaded through for this. **Still no inter-badge collision handling** — a gap ring can still overlap a neighboring badge's own gap ring; only the fill-never-covered guarantee above is new), `cornerStyle` (`TeleportCornerStyle`, default `"round"` — drives polygon-shape corner rounding for badges, reusing `optTeleportCornerStyle` for validation; wired into "Shared style" (GitHub issue #322 follow-up, generalized by #643) the same mechanism `elevatorMarker.cornerStyle` uses — an `"elevatorBadges.cornerStyle"` link in `DEFAULT_VECTOR_BY_WALLS_LINKS`/`DEFAULT_VECTOR_BY_CORRIDORS_LINKS` (GitHub issue #701: badges are also reachable from the shared `markerSize`/`markerBorderWidth`/`gapWidth`/`markerShape`/colors via disabled-by-default links), `setVectorByWallsElevatorBadgesCornerStyle` disabling that link before writing, and the panel's own `OverrideResetButton` on the corner-style row — that link starts `enabled: false`, same as `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`'s own), `shape` (`MarkerShape`, same shapes `MarkerSettings` offers), `fillColor`, `borderColor`/`borderWidth` (GitHub issue #701: own border, default colour = fill, width 0, linkable like the marker ones), `textColor` — independently visible fill and text colors, not the knockout/cutout text `drawFloorBadge`'s off-floor navigation stand-in uses, since these badges carry no click-to-navigate behavior of their own; `textFontWeight` (`"regular"`/`"bold"`, default `"bold"` — selects the regular vs. bold baked MSDF atlas via `msdfFontFamily`, see `maze-web/Specs/renderer.md`'s "MSDF label font"; each weight is a separately baked atlas, since MSDF glyph shapes can't be synthesized bold at runtime. A `"semibold"` third option was tried and dropped back when badges used pixi `Text` — the canvas font had no real semibold face, so pixi rounded weight `"600"` up to the same rendered result as `"bold"`; there is likewise no semibold atlas). Font size is `textSize` (absolute px, 6-32, default 10 — GitHub issue #701; the former per-maze shared fit across all elevator badges was removed, `fitElevatorBadgeFontSize` is kept unused for GitHub issue #707).

  **Gap-then-fill draw order** (round-4 GitHub issue #430 follow-up) — `drawElevatorBadges` draws every badge's own gap ring first, then every badge's own body second (`drawElevatorBadgeGap`/`drawElevatorBadgeBody`, split out of what was one combined per-badge draw call), rather than gap-then-body-then-gap-then-body per badge in sequence. A badge's `gapWidth` ring still never actively avoids a neighboring badge (see above — no inter-badge collision handling), but the two-pass order guarantees a badge's own fill is never drawn *underneath* a neighboring badge's gap ring — only the reverse (a gap ring can still visually extend into a neighbor's own gap ring, never into that neighbor's actual body).

  Pure layout math lives in `elevatorBadgeLayout.ts` (`computeElevatorBadgePositions`/`elevatorBadgesOverlap`/`elevatorBadgesTooMany`/`formatElevatorBadgeLabel`/`slotsPerRow`) so the same geometry backs both drawing (`VerticalConnectionRenderer.drawElevatorBadges`) and the two overlap/overflow warning checks below — the same "one geometry function, several consumers" convention `chevronRowStep` uses for "Vector by corridors"' one-way overflow check.

  `"left_right"`/`"right_left"`/`"top_bottom"`/`"bottom_top"` always split the badge count between two sides (a left row and a right row, or a top column and a bottom column) and lay each out as its own single row (`layoutMarkerSide`), its near edge `distance` past the marker radius: `slotsPerRow(radius, gap)` (`floor((TILE_SIZE + gap) / (2*radius + gap))`, minimum 1 — the inter-badge `gap` counts toward how many fit, computed before any badge position is placed, so a fit decision never gets made without first accounting for it) gives one side's row capacity, but there is no second sub-row to wrap into — a side whose own count exceeds capacity still draws as one (visually overflowing) row, and separately trips the `elevator_badges_too_many` warning below. A placement's name identifies its *leading* side — the one that fills first and gets the extra badge on an odd `evenDistribution` split (`"left_right"` leads left, `"right_left"` leads right, `"top_bottom"` leads top, `"bottom_top"` leads bottom); `evenDistribution` on splits the count in half (ceil/floor, leading side gets the extra); off (the default) the leading side fills to `slotsPerRow` capacity before any remainder spills onto the other side — ascending floor order is preserved either way (never an interleaved round-robin), so with `evenDistribution` off a run of consecutive floor numbers group onto one side before the next run starts on the other. **Fallback to even** (`splitBadgeCount`, round-4 GitHub issue #430 follow-up): once `count > 2 * capacity`, an uneven leading-fill split can no longer keep either side within capacity any better than an even split would, so `evenDistribution` off degrades to the same ceil/floor even split `evenDistribution` on uses — the uneven layout's own "ascending run per side" benefit only holds while at least one side can still fit.

  `"full_circle"` spreads badges around a ring of radius `markerRadius + distance + badgeRadius`. `evenDistribution` on spaces all badges evenly around the whole ring, starting at 12 o'clock and going clockwise, ignoring `gap` entirely — the only layout whose spacing can't guarantee touching-not-overlapping by construction, since a ring's own chord length shrinks as more badges share it. `evenDistribution` off instead lays badges out one after another `gap` apart (chord distance, same convention `gap` uses everywhere else) as a single contiguous arc centered on the 12-o'clock mark, rather than spreading around the full circle — an odd count centers its middle badge exactly at 12 o'clock, an even count centers the gap between its two middle badges there. **Fallback to even** (round-4 GitHub issue #430 follow-up): the contiguous arc's own total span (`angleStep * (count - 1)`) is computed before laying anything out, and once it would reach or exceed a full `2π` (badges would have to wrap back around and overlap themselves), the layout falls back to the same even-spaced full ring `evenDistribution` on uses instead of drawing an impossible arc.

  **`elevator_badges_overlap` export warning** — folded into `computeVectorByWallsWarnings`, checked only when `elevatorBadges.enabled`: for every `elevator` marker with 2+ `targetFloorIndices`, lays out its badge ring via `computeElevatorBadgePositions` and flags it when `elevatorBadgesOverlap` finds any two badge centers closer than `2 * badgeRadius` apart — real geometric overlap, not a fixed floor-count threshold. Its description is deliberately terse (no restated size/distance/placement fix suggestions — the settings panel is right there). Populates `crossFloorTargets` (see "Hover highlight" below).

  **`elevator_badges_too_many` export warning** (GitHub issue #430 follow-up) — a two-sided elevator (`"left_right"`/`"right_left"`/`"top_bottom"`/`"bottom_top"`) whose badge count, split per `evenDistribution`, has either side exceed `slotsPerRow` capacity (`elevatorBadgesTooMany`); never fires for `"full_circle"`, which has no per-row capacity to exceed. Independent of `elevator_badges_overlap` — an overflowing row and an overlapping ring are different failure shapes (a side that overflows its row doesn't necessarily overlap, since badges in that row still space `2*radius + gap` apart from each other; it visually runs past its own cell's bounds instead). Same `crossFloorTargets`/`nodes` hover-highlight treatment `elevator_badges_overlap` gets (round-4 GitHub issue #430 follow-up) — both warnings point at the same kind of layout problem on the same marker, so both are worth navigating to.

  Both warnings share the *unscoped* node resolution: since this function's own `nodes`/`edges` are floor-scoped (`selectFloorScopedMaze`, matching every other check in this section), resolving a badge's target floor needs the *unscoped* node list the same way `resolveNodeLevel` always has — `computeVectorByWallsWarnings` takes an optional `unscopedNodes` parameter for exactly this (defaults to `nodes`, so every other existing call site/test is unaffected and neither elevator-badge warning fires without real cross-floor data).

  **Hover highlight** — hovering `elevator_badges_overlap` or `elevator_badges_too_many` in the panel's warning list highlights every flagged elevator's own cell (`ExportWarningHighlight`, the same cell-fill mechanism every other export warning uses, driven by `warning.nodes`) — no per-marker cross-floor navigation bubbles are drawn on the canvas itself for these two warnings (round-4 GitHub issue #430 follow-up: an earlier version drew a ring of click-to-navigate bubbles around the flagged marker, same geometry `RegionOverlayRenderer`'s own cross-floor region badges use — removed as not what "floor badges" meant). `ExportWarningHighlight`'s own `render` now also threads an `unscopedNodes` parameter into `computeVectorByWallsWarnings`/`computeVectorByCorridorsWarnings` (`VectorByWallsRenderer.renderWarningHighlight` passes `state.nodes`, the unscoped list, alongside the floor-scoped `nodes`/`edges` it already used) — needed for `resolveNodeLevel` to resolve a badge's cross-floor target at all, since this class's own `nodes`/`edges` are always floor-scoped.

  **Floor badges in the warning bubble** (round-4 GitHub issue #430 follow-up) — a row of solid `L{n}` buttons rendered *inside* the warning list bubble itself, below its label/info-icon row, one per distinct floor `warning.crossFloorTargets` reaches (deduplicated across every flagged marker the warning covers). Uses the shared `FloorBadgeRow` component (`components/FloorBadgeRow.tsx`, extracted this same follow-up out of what were previously three near-identical copies — `IssuesBlock`'s `IssueFloorBadges`, Preset Connections' `OrphanSplitFloorBadges`, and this one) rather than a fourth bespoke copy: `ExportWarningBubble` passes it `warning.crossFloorTargets`'s deduplicated, sorted `targetFloorIndex` list directly (no node-id resolution needed, unlike `IssueFloorBadges`'s own node-id-to-level lookup), the bubble's own palette-derived badge colors, and `hoverable-tint-counter` to cancel the parent bubble's own hover-brightness filter — same composition every `FloorBadgeRow` caller uses. `FloorBadgeRow` itself owns the single-floor-maze hide check and the `navigateToFloor`/`stopPropagation` click wiring, so every caller gets identical behavior for free.

  **Marker indices** ("Marker indices" section, GitHub issue #471) — a rectangular framed plate carrying a shared index drawn *under* every cross-floor connection marker (staircase / elevator / teleport), so a player matching the per-floor export images can tell where each one leads. A **separate, independent mechanism** from the elevator floor-number badges above (#430/#478) and the cross-floor teleport navigation badges (#480) — it is not wired into "Shared style". Off by default (`markerIndex.enabled`). Both vector modes draw it (`VectorByWallsRenderer`, `VectorByCorridorsRenderer`); it is **not** drawn on the Generation/Analytics canvas. Own renderer `MarkerIndexRenderer` (per `maze-web/CLAUDE.md`'s feature-renderer ownership rule). Like `borderColorFromMarker`, `borderWidthFromMarker` optionally makes each plate inherit its endpoint marker's border thickness; when off, the plate uses its own `borderWidth`.

  **Two-layer draw order.** `MarkerIndexRenderer` takes *two* caller containers: a **gap layer** the vector renderer places *below* the teleport/vertical/waypoint marker containers, and a **body layer** it places *above* them. So the sequence is: every plate's gap ring → the connection markers → every plate body. A plate's floor-colored gap ring thus lands *under* the marker it hangs off and never occludes it, even when `offset` is small enough that the plate overlaps the marker. `offset` is the distance from the marker's outer edge to the plate's **center** (`0` = plate center on the marker's bottom edge).

  Link identity is **direction-independent** and computed from the *unscoped* `nodes`/`edges` (cross-floor edges never survive `selectFloorScopedMaze` intact): a `teleport` or `vertical_passage` link is its unordered endpoint node pair (a bidirectional pair of directed edges, or a one-way edge plus a separate reverse directed edge, collapses to one link); an `elevator` link is its connected component of `elevator` edges (`elevatorComponent`, `postEditVerticalUtils.ts`), so an elevator fan spanning 3+ floors gets **one** index for the whole shaft. Graph invariants relied on (no defensive code): at most one `teleport` edge between a node pair; one elevator shaft owns at most one node per floor (a shared node ⟹ one shaft). Links are numbered `1..N` by a canonical sort key — `[kindRank (teleport 0, vertical 1, elevator 2), then each endpoint's (node.level, nodeId) sorted]` — deterministic regardless of node/edge input order. `node.level ?? 0` is the true 0-based floor; the client-side `floors` array order is not used. Labels are formatted by `formatIndexLabel` from the neutral `indexLabel.ts` (shared with #430's badge labels), `labelStyle` = `"arabic"`/`"roman"`/`"letters"`.

  `buildMarkerIndexLabels` (`mazeSelectors/markerIndex.ts`) takes a `resolveEndpointVisual(nodeId, kind)` callback supplied by the vector renderer (`buildMarkerIndexEndpointResolver`, `exportStyleBuilders.ts`) — the selector itself carries no per-kind marker-settings or teleport-group-override knowledge. The resolver returns each endpoint marker's real `outerRadius` (`size * TILE_SIZE + borderWidth`) and a `borderMatchColor` for `borderColorFromMarker`: the marker's own border color when it has a border (`borderWidth > 0`), else its fill color — for a teleport endpoint, resolved through any `TeleportGroupOverride` covering its cell, exactly as `TeleportRenderer.drawGroupPoints` does; for an abstract vertical/elevator endpoint, the `elevatorMarker` style for elevators and the `twoWayPassageMarker` style otherwise. In Vector-by-walls' decorative vertical style, the decorative element's `lineWidth` supplies the inherited index thickness and its `lineColor` supplies the match color. `buildMarkerIndexLabels` returns `allLabelStrings` (all N formatted indices — the renderer sizes the plate width to the widest of these so a given index looks identical on every floor) and `labels` for the active floor (`pos` = cell center, plus `markerOuterRadius` / `borderMatchColor` from the resolver). An elevator fan with several nodes in one cell of the drawn floor yields a **single** plate there (dedup by `(level, x, y)`); distinct links sharing a cell (a teleport and a staircase, say) stack — the issue only requires distinguishing elevators.

  **Coverage.** Only the master `enabled` toggle sits at the section's top level; everything else is nested one indent deep under three sub-groups: "Coverage", "Caption" (label style, font weight, text size with Auto-fit, text color) and "Backplate" (width, height, position, rounding, gap, border width/color, plate color). "Coverage" is four per-kind toggles — `coverage.singleFloorTeleport` (off by default), `coverage.crossFloorTeleport`, `coverage.verticalPassage`, `coverage.elevator` (the last three on) — filtering which connection kinds `buildMarkerIndexLabels` builds a link for at all (a filtered-out kind takes no index; numbering closes up over what remains). A `teleport` link counts as cross-floor when its two endpoints differ in `node.level`, single-floor otherwise. The `elevator_indistinguishable` warning treats elevator indices as "shown" only when `enabled && coverage.elevator`.

Settings (`MarkerIndexSettings`, `imageExportTypes.ts`; all geometric fields are in px; `borderWidth` and `gap` are whole pixels): `enabled`, `coverage` (above), `labelStyle`, `width` (fixed plate width, 8–20 px, independent of the text; GitHub issue #725), `height` (plate height, minimum 8 px), `textSize` (label font size in px, `TEXT_SIZE_RANGE`, with an "Auto-fit" button; with `textFontWeight` and `textColor` it is the shared `TextStyleFields`, rendered by `TextStyleRows` in the order weight, size, color), `offset` (marker edge → plate center), `cornerRadius` (`roundRect` corner, 0 = sharp), `gap` (floor-colored gap ring around the plate, whole pixels, 0 = none — drawn in the gap layer so it never eats into the marker; wraps the plate's *outer* edge, i.e. `gap + borderWidth / 2` beyond the box since the border stroke is centered on the box edge; a member of the "Shared style" `gapWidth` group, default 3 = the shared default, so it follows the shared value until overridden), `fillColor`, `borderColor`, `borderColorFromMarker` (on by default; when on, the plate border takes the endpoint marker's `borderMatchColor` and the `borderColor` row is disabled in the panel), `borderWidth`. The plate is a fixed `width` x `height` rectangle, identical for every index. The label is an MSDF `BitmapText` (see `maze-web/Specs/renderer.md`'s "MSDF label font"). A label that does not fit the plate rectangle (`textMargin` per side, glyph-ink outline — same rules as the other texts, `textFit.ts` with `plateWidth`/`plateHeight`) raises the `marker_index_text_overflow` export warning (`export-warnings.md`); the font-size row's Auto-fit button picks the largest fitting size over all labels (`TextFitKind` `markerIndex`), and when indexes are enabled the Shared style text-size Auto-fit also takes them into account. `markerTextSize` also links to `markerIndex.textSize` (disabled by default). `textFontWeight` (`"regular"`/`"bold"`) picks the atlas via `msdfFontFamily`. Both marker-index containers are included in `measureContentMargin` so an enabled plate near the content's bottom edge grows the export margin. Panel section is the last item in both settings panels (before `ExportWarningsSection`), a self-contained collapsible; only its `gap` field is wired to "Shared style" (the `gapWidth` group), with an `OverrideResetButton` like the other `gapWidth` members. Persistence: `validateMarkerIndexSettings` (`validateImageExport.ts`), lenient recovery like `validateElevatorBadgeSettings`.

  One-way vertical passages use their one-way-specific marker color for the index border. In
  abstract mode this is `oneWayPassageMarker.borderColor` (or its `fillColor` when borderless, same
  `borderColorFromMarker` convention every other endpoint resolver follows); in decorative mode it is
  `decorativeStairsOneWay.lineColor`. Their plate radius also follows the one-way marker/line size,
  rather than the hidden two-way abstract marker variant.

  `borderWidthFromMarker` mirrors `borderColorFromMarker`: when enabled, the plate uses the
  endpoint marker's border thickness; for decorative vertical elements in Vector-by-walls, this
  thickness is the decorative element's `lineWidth`. The plate's own `borderWidth` is used when
  inheritance is disabled.

### "Vector by corridors" (`VectorByCorridorsRenderer`)

Renders the maze the inverse way "Vector by walls" does: instead of walls-as-gaps, every basic
passage between two geometrically adjacent cells draws as a stroked line between their centers
(`buildCorridorSegments`, `pixi/selectors/mazeSelectors.ts`) — the passage itself is the visible
line, not the wall around it. GitHub issue #310 (scaffolded in #315).

Its settings panel (`VectorByCorridorsSettingsPanel.tsx`) has a collapsible "Cells" section, a
collapsible "Waypoints" section, a "One-ways" section (GitHub issue #312, hidden entirely when the
maze has no one-way basic edge — same `hasOneWays` check `VectorByWallsSettingsPanel` uses, placed
before "Teleports" per that panel's own section order), a "Teleports" section (hidden entirely when
the maze has no teleport edge), and a warnings section (`vectorByCorridorsSectionsExpanded`, same
collapse convention as `VectorByWallsSettingsPanel`'s own sections — collapsed by default), backed by
`VectorByCorridorsSettings` (`imageExportSlice.ts`):

- **"Cells"** — corridor color, corners & ends (round/miter join, paired with a round/square cap —
  same convention as `VectorByWallsSettings.wallJoin`/`wallCap`), **Rendering mode** (a Contour/Line
  `SelectRow` with an info icon opening a `CategoryInfoModal` — GitHub issue #510, replaced the old
  `join === "round"`-gated "Round junctions" toggle; see the "Rendering mode" section below) and
  thickness (1 to `TILE_SIZE` — a
  corridor's meaningful range scales with the cell size, unlike "Vector by walls"' fixed 1-20px
  wall-thickness range). At thick junctions, the contour builder applies one shared clamp to every
  cell's port mouth, using the finite face length, keeping both sides of a shared face identical even
  when the requested thickness is wider than a hex face. Defaults: `canvas.wall.default` color, round join, thickness `TILE_SIZE / 2`
  (half the slider's own max, rather than `VectorByWallsSettings.wallThickness`'s fixed default).
  Also hosts the marker widen-patch settings (GitHub issue #313 follow-up — moved here from
  "Waypoints" since the patch also widens the corridor under teleport markers, not just
  start/finish, so it's a corridor-line concern rather than a waypoint-only one): a "Marker widen
  padding" slider (0-20px, default 4) sets `markerWidenPadding`, fed into `drawMarkerWidenPatches`'
  `padding` param and into `computeVectorByCorridorsExportMargin`'s own marker-footprint terms; a
  "Marker widen shape" select sets `markerWidenShape` (`"match_marker"` default — each patch draws
  in that marker's own shape, `"circle"`/`"square"` — every patch draws in that one fixed shape
  regardless of the marker's own, `"square"`'s corners following the Cells section's own `join`
  rather than a separate corner-style setting).
- **"Waypoints"** (GitHub issue #311) — start/finish marker appearance, `startMarker`/`finishMarker:
  MarkerSettings` fields on `VectorByCorridorsSettings`, identical shape and defaults to
  `VectorByWallsSettings`' own waypoint fields. The panel reuses `VectorByWallsSettingsPanel`'s
  `MarkerSettingsGroup` sub-component directly (extracted into its own file,
  `components/features/MarkerSettingsGroup.tsx`, alongside the shared `MARKER_SHAPE_OPTIONS` list) —
  same "Start"/"Finish" sub-group layout, same i18n message keys (`image_export.vector_by_walls.
  marker_*`, reused verbatim rather than duplicated under a `vector_by_corridors` prefix, since the
  labels are shape-agnostic). `VectorByCorridorsRenderer` draws the markers via its own
  `WaypointsRenderer` instance (own `Container`, per `maze-web/CLAUDE.md`'s feature-renderer
  ownership rule — never the walls renderer's instance), built the same way
  `VectorByWallsRenderer` builds its own (`buildMazeMarkers`, node positions from
  `resolveEffectiveEndpoints` so a post-edit start/finish move is picked up); gap color always
  mirrors `settings.color` (the corridor's own stroke color, same convention this mode's Teleports
  section uses for its own edge markers — see below), not the canvas background, since a marker sits
  directly on the corridor line here rather than an empty floor tile. Start/finish marker footprint is folded into
  `computeVectorByCorridorsExportMargin` the same way `computeVectorByWallsExportMargin` folds in
  its own waypoint margins.
- **"One-ways"** (GitHub issue #312) — a one-way basic passage's own indicator: a row of chevrons
  ("`>`" shapes with no base) drawn at the segment's midpoint, on top of the plain stroke, breaking
  the corridor line instead of a `VectorByWallsSettings.oneWayPattern`-style indicator sitting on a
  wall segment (this mode has no wall segment to draw on). Backed by `OneWaySettingsFields`
  (`storeTypes.ts`, `VectorByCorridorsSettings extends` it alongside `TeleportSettingsFields`):
  `oneWayColor` (default `canvas.stage.background` — reads as a gap cut into the corridor stroke,
  not an indicator drawn on top of it, unlike `VectorByWallsSettings.oneWayColor`'s always-own-color
  convention), `oneWayCount` (1-10, default 2), `oneWayThickness` (chevron stroke width, 1 to
  `TILE_SIZE / 4`, default half that max), `oneWayGap` (visible pixel gap between two adjacent
  chevrons' own stroked edges, 0 to `TILE_SIZE / 4`, default half that max — `0` means adjacent
  chevrons touch), `oneWayWidth` (0.01-1, fraction of the corridor's own `thickness` across the
  corridor, default 0.5), `oneWayLength` (0.1-1, a *multiplier* of the chevron's own full opening
  width `oneWayWidth * thickness` rather than an absolute pixel size — so the chevron's opening angle
  stays constant as `oneWayWidth`/`thickness` change instead of visibly flattening/sharpening on its
  own, default 0.3) and `oneWayJoin` (round/miter, independent of the Cells section's own `join`).
  Drawn via `drawOneWayChevronRow` (`pixi/renderers/wallUtils.ts`) — reuses `drawOneWayChevron` per
  chevron rather than a hand-rolled multi-chevron path, spacing adjacent chevrons by
  `chevronRowStep = length + gap + thickness` (both `VectorByCorridorsRenderer` and
  `computeVectorByCorridorsWarnings`' overflow check call this same function, so they can't drift
  apart). `VectorByCorridorsRenderer` resolves `oneWayLengthPx = oneWayLength * oneWayWidth *
  thickness` and passes it as `drawOneWayChevronRow`'s `length` argument, and `oneWayWidth * thickness
  / 2` as the chevron's own half-opening (`drawOneWayChevron`'s `width` — a half-opening, so the
  desired full opening is halved). Direction comes from `buildCorridorSegments`' own `oneWayDir`
  (`pixi/selectors/mazeSelectors.ts` — a unit vector along the segment, unset for a bidirectional
  passage, computed the same directed-set way `buildMazeWalls` computes its own `oneWayDir`); each
  segment also carries its own `fromNode`/`toNode` so downstream consumers (the overflow warning
  below) can flag the exact edge a segment was drawn for without re-deriving geometric-neighbor
  adjacency themselves. Folded into `computeVectorByCorridorsExportMargin` as
  `Math.max(corridorHalf, oneWayWidth * thickness / 2)`.
- **"Teleports"** (GitHub issue #313 follow-up) — teleports aren't tied to the corridor-vs-wall
  visual model, so `VectorByCorridorsSettings extends TeleportSettingsFields` (`storeTypes.ts`) and
  the whole set of teleport fields/rendering transfers from "Vector by walls" as-is: same
  `TeleportSettingsSection` component (`components/features/TeleportSettingsSection.tsx`, extracted
  out of `VectorByWallsSettingsPanel` so both panels render the identical fields/groups UI, only the
  underlying store setters differ — `patchVectorByCorridorsTeleportSettings` vs.
  `patchVectorByWallsTeleportSettings`, both generic `Partial<TeleportSettingsFields>` patch actions
  replacing dozens of one-field-each setters), same `TeleportRenderer` instance drawn via its own
  `Container` (per the feature-renderer ownership rule — never `VectorByWallsRenderer`'s own
  instance), same group-customization/selection/click-to-select behavior described under "Vector by
  walls"' own Teleports section above. Cross-floor teleports render identically to "Vector by walls"
  (GitHub issue #481): `VectorByCorridorsRenderer.renderAll` passes `buildTeleportEdges` the same
  optional `floorContext` (`resolveNodeLevel`, `unscopedNodeById`, `unscopedEdges`,
  `activeFloorIndex`) and badge-spread bag (`buildTeleportBadgeBlockedCells`,
  `allowOutOfField: !teleportAvoidFieldExit`, all-floor `fieldCells`) that `VectorByWallsRenderer`
  does — both assembled by the shared `buildTeleportFloorInputs` helper (`mazeSelectors/teleport.ts`),
  which every floor-aware `buildTeleportEdges` caller uses — see `Specs/floors.md`'s "Cross-floor
  teleport badges". Without `floorContext` the selector
  can't resolve a teleport's far-floor endpoint and a cross-floor teleport is dropped entirely (the
  original bug). `teleportAvoidFieldExit` is part of the `geometryCache` invalidation key in both
  renderers, so toggling it rebuilds `teleportEdges`.

  Two differences from "Vector by walls": `floorColor` passed to
  `buildTeleportLineStyle` and `buildMarkerStyle` (start/finish markers) is this mode's own
  `settings.color` (the corridor's own stroke color, not a canvas background) — a teleport point (and
  a start/finish waypoint) sits directly on the passage line here, not on an empty floor tile, so an
  outline point's fill and gap rings must occlude the line the same way an entry point's real fill
  does, and a marker's floor-colored gap ring must cut through the corridor's own color rather than
  the canvas background behind it; and every teleport marker also gets its own widen patch under the corridor
  stroke (`buildTeleportWidenMarkers`, `VectorByCorridorsRenderer.ts` — exported, unit-tested
  directly), reusing the Cells section's `markerWidenPadding`/`markerWidenShape` rather than a
  separate teleport-only setting, with each point's own shape/corner-style resolved from its
  group's `TeleportGroupOverride` when one applies (so the widen patch never mismatches what
  `TeleportRenderer` actually draws there). A cross-floor badge endpoint (a coordinate tagged
  `toFloor`/`fromFloor` on any teleport edge, keyed by coordinate exactly like
  `computeFloorBadges`) supplies its widen marker from the badge's own `teleportFloorBadge.shape`
  and `teleportFloorBadge.size` (px diameter; not `teleportMarker.shape`/`teleportMarker.size` or a group override),
  with the badge's own `teleportFloorBadge.cornerStyle`, `borderWidth` and `gapWidth` (matching `drawFloorBadge` and `TeleportRenderer`'s gap ring). The actual
  patch shape still follows `markerWidenShape` uniformly — a fixed `"circle"`/`"square"` flattens
  the badge patch too, and only `"match_marker"` copies `teleportFloorBadge.shape`. `TeleportRenderer`
  draws that endpoint as a `teleportFloorBadge.shape` floor-number badge (`drawFloorBadge`), not a
  `teleportMarker.shape` marker, and its own gap ring (`drawGroupGaps`) matches that shape too.
  `buildTeleportWidenMarkers`'s own `groups` param is
  computed once per `renderAll` and handed in, rather than the function recomputing
  `buildTeleportGroups` itself — `TeleportRenderer.render` already computes the same grouping
  internally for the same edges, so a second independent call would repeat that work for nothing.
- **"Vertical connections"** (GitHub issue #348) — abstract-marker only, no style toggle: unlike
  "Vector by walls", this mode has no `verticalStyle` (abstract/decorative) choice and no decorative
  pictogram rendering at all — `VectorByCorridorsSettings extends VerticalSettingsFields` only
  (`storeTypes.ts`), never `VerticalDecorativeFields` (that interface is "Vector by walls"-only). The
  same three independently-hidden sub-groups exist (`twoWayPassageMarker`/`oneWayPassageMarker`/
  `elevatorMarker`, shown per `hasTwoWayPassages`/`hasOneWayPassages`/`hasElevators` checked against
  the panel's own *unscoped* `rawEdges`, same pairing logic as "Vector by walls"), each always drawn
  as a plain marker shape — same arrow color/size/style/corner-style quadruple per sub-group, same
  one-way passage wall-tick indicator (GitHub issue #693), same elevator floor-number
  badges (`elevatorBadges`, GitHub issue #430). Floor-scoping mirrors "Vector by walls":
  `VectorByCorridorsRenderer.renderAll` narrows `state.nodes`/`state.edges` via
  `selectFloorScopedMaze` before building corridor/marker geometry, resolves node floors from the
  *unscoped* list via `selectNodeLevelResolver`, and detects bidirectional vertical passages via
  `selectVerticalPassagePairSet` over the unscoped edges — same as `VectorByWallsRenderer`. Markers
  are drawn by this renderer's own `VerticalConnectionRenderer` instance (own `Container`, per
  `maze-web/CLAUDE.md`'s feature-renderer ownership rule — never `VectorByWallsRenderer`'s own
  instance), built via the shared `buildVerticalConnectionMarkers` selector and styled via the shared
  `buildVerticalConnectionStyle(settings, floorColor)` builder — called here with `settings.color`
  (the corridor's own stroke color) as the occluding-color parameter and no third (decorative) argument,
  so the builder falls back to its internal `INERT_DECORATIVE_FILLER` placeholder, which is never
  actually read since `style` is always `"abstract"` for this mode. The occluding-color parameter
  reuses the convention this mode's Teleports/Waypoints sections already use in place of a separate
  `floorColor` field. Every vertical marker also gets its own widen patch under the corridor stroke
  (`buildVerticalWidenMarkers`, `vectorByCorridorsGeometry.ts`), reusing the Cells section's
  `markerWidenPadding`/`markerWidenShape` the same way `buildTeleportWidenMarkers` does. "Shared
  style" integration (GitHub issue #322, generalized by #643) is identical to "Vector by walls"':
  `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`/`elevatorBadges`' own `cornerStyle`/
  `size`/`borderWidth`/`gapWidth` links all start `enabled: false` in `DEFAULT_VECTOR_BY_CORRIDORS_LINKS`
  so the export matches the editor's fixed vertical-connection look until changed. **Deliberately no
  `vertical_on_special_split`-equivalent export warning** — `computeVectorByCorridorsWarnings` has no
  vertical-connection reading of its own, matching "Vector by corridors"' existing no-vertical-warning
  behavior (see the note under "Vector by walls"' own `vertical_on_special_split` warning above).

A one-way passage draws its chevron-row indicator (see the "One-ways" section above) on top of the
same plain stroke a bidirectional passage draws — `buildCorridorSegments`' own `oneWayDir` is what
distinguishes the two. Split points (a cell with more than one `NodeDto`) are skipped entirely —
their passages draw nothing in this mode, same "own dedicated sub-issue" convention
`VectorByWallsRenderer`'s split section followed before its own issue landed. `buildCorridorSegments`
excludes them the same way `buildMazeWalls` excludes split points from its own wall reading
(`splitPointKeys`).

### Rendering mode — Contour vs Line (GitHub issues #493 / #510)

The **Rendering mode** setting (`VectorByCorridorsSettings.renderStyle`, `"contour"` default /
`"legacy_line"`, GitHub issue #510) picks between two corridor-drawing algorithms with independent
special-shape drawing — the only code the two modes share is `setupSplitPassageDraw` (per-call
clip-scratch reset, the `drawConnectorLine` helper, and the plain-connector pass — boilerplate with
no special-shape geometry) and the geometry helpers in `vectorByCorridorsGeometry.ts` that already
predate #493 — so a bug in one mode's contour/line geometry can never leak into the other.
It replaced the old `join`-gated `roundJunctions` boolean. Both modes still honor the `join`
(round/miter) setting; each applies its own round/miter behavior. An old project file predating the
field — or carrying only the removed `roundJunctions` boolean — recovers to `"contour"`
(`optRenderStyle`, `validateImageExport.ts`).

- **Contour** (default, GitHub issue #493 rework) — more decorative: rounds every corner, junctions
  included, but has shown stability issues. Described below.
- **Line** (`"legacy_line"`) — the corridor renderer as it stood before the #493 contour rework
  (`ac2e998~1`), restored verbatim (the
  `renderStyle === "legacy_line"` branch + `drawSplitPassagesLegacy` — the
  `strokeChainedPathsWithPatchedCaps` miter path predates #493 and was never touched by the contour
  rework, so both modes share it). More
  stable, but junctions/turns have sharp corners under `join: "miter"`. Under `join: "round"` it
  draws each chained corridor path as a `butt`-capped stroke with a plain filled circle patched at
  every genuine free end (a T-junction needs no patch — coincident round caps safely overlap);
  split shapes render via `drawSplitPassagesLegacy` (through corridor as a plain straight line,
  cross corridor on top with a background-colored gap; diagonal nodes as bowed ribbons) — never a
  contour fill regardless of `join`.

#### Contour mode — one filled shape per tile (GitHub issue #493)

With a **round** join the corridor network is drawn as **one filled shape per cell**, each shape
built only from that cell's own passages, with real `line`/`arc` commands — no per-segment stroke,
no polygon boolean union (`vectorByCorridorsContour.ts`, `buildCorridorContour`).

**Ports.** The centre-to-centre segments (`buildCorridorSegments`) are grouped by cell centre; each
segment end is one *port* of that cell — the middle of the shared border (`(v0+v1)/2`, or the split
face midpoint `v1` for a split neighbour), plus the outward unit normal there. A port's drawn border
is the segment `mid ± tangent · thickness/2` — `thickness` long, centred on the border middle.
Adjacent cells produce mirror-image ports on the shared face (same midpoint, same length), so the
two filled shapes meet edge-to-edge with no seam and no overlap. Ports are ordered CCW around the
cell centre.

**Per-tile shape** (`tileContour`), by port count:

- **1 port — dead end**: a `thickness`-wide stub running from the shared border straight into the
  tile to its centre, then a 180-degree semicircular cap of radius `thickness/2`. Four anchor
  points — two on the border (shared with the neighbour tile), two where the straight walls hand off
  to the cap.
- **2 collinear ports — straight through**: a rectangle joining the two borders (four corners
  ordered by angle around their centroid to guarantee a simple quad).
- **2 ports at an angle — turn**: a pair of **concentric** circular arcs. `O` is where the two
  border *lines* meet, `R` the distance from `O` to each border midpoint; the inner (concave) elbow
  is an arc of radius `R − thickness/2`, the outer (convex) elbow a concentric arc of radius
  `R + thickness/2`. The corridor therefore keeps a **constant `thickness` width right through the
  bend, both elbows rounded** — the fix for issue #493 (the old renderer rounded only the outer
  elbow, leaving the inner corner a sharp point). For a square tile with the port at the face
  middle: `R` = half the tile step, `O` = the tile corner, inner radius `step/2 − thickness/2`.
- **3+ ports — junction**: the outline is walked CCW — each port lays its `thickness`-wide border,
  then the piece between it and the next port is one of:
  - **concave armpit** (passages on both sides, CCW turn between the two arm axes < 180°): a
    **tangent fillet**. Each arm's own side-wall is run *inward* from its inner border end; the two
    extended walls meet at `W`; the corner is rounded with an arc that touches each wall, radius
    `min(R − thickness/2, ARMPIT_FILLET_K · thickness, reach · tan(half-angle))` where `R` is the
    distance from `O` (border lines' intersection) to each border midpoint, `ARMPIT_FILLET_K` = 0.9,
    and `reach` is how far `W` sits from the nearer inner border end. Capping the radius against the
    corridor width keeps a thin corridor at a wide junction about one corridor wide instead of
    ballooning with the tessellation step; when no cap bites it is the turn-tile inner elbow
    `R − thickness/2`.
  - **convex gap** (the wide dead sector between the two outermost arms — reflex turn, e.g. a hex
    cell with passages on 3 adjacent faces): the *outer* elbow of the same turn construction — an
    arc of radius `R + thickness/2` around `O` between the two borders' outer ends, the exact arc a
    one-face-apart passage draws. By construction `R + thickness/2 ≈ |O − tile centre|`, so the arc
    passes close by the centre without reaching it; the fill still reads as one smooth junction.
    Drawing the *inner* arc here instead would invert and punch a hole in the tile.
  - **straight-through** (collinear arms): a plain line across.

  **Special case — exactly one dead sector** (e.g. a hex cell with passages on 3 *adjacent* faces):
  a corridor bends one-face-apart across the junction. Its outer edge is the dead sector's
  `R + thickness/2` arc about `O`; its inner edge must be the **concentric** `R − thickness/2` arc
  about the *same* `O`, running unbroken from one dead-sector arm to the other along the short side.
  Any arm in between cuts a shallow notch out of that single inner arc (its two side-walls each
  cross the circle once; between the crossings the arm's own `thickness`-wide border juts outward),
  and each concave corner where the inner arc meets such a side-wall is rounded with a small tangent
  fillet (radius `min(ARMPIT_FILLET_K · thickness, (R − thickness/2)/2)`). The whole junction
  contour is emitted by a dedicated traversal that bypasses the per-piece loop above — building
  those middle sections as stand-alone armpit fillets about their own local corner would leave a
  straight inner edge against the curved outer one and pinch the fill (issue #493).

  **No core disc.**

  In contour mode a 3+-port junction always gets this arc treatment (`buildCorridorContour`'s
  `roundJunctions` param is passed `true` unconditionally now — the old user-facing toggle was
  replaced by the Rendering mode switch, GitHub issue #510). To leave junctions angular, select the
  **Line** rendering mode instead.

All arc sweeps take the short way between their endpoints (`shortSweepCcw`), except the dead-end cap
which sweeps the long way (around its own centre). Angle-based throughout, so it works unchanged on
square / hex / triangle and any future tessellation — there is no radius parameter and no per-grid
constant.

**Tracing.** `traceCorridorContour` plays each tile path's `move` / `line` / `arc` onto the
`Graphics` and `closePath()`s it; the caller fills once. The tiles never overlap, so a plain fill is
seamless. `contourToPolyline` samples a path to a plain point list (arcs at ~0.2 rad) — for tests
and export-margin measurement only, never for the render. `ContourPath.hole` is always `false` in
this model (kept only so the trace/fill call site and tests need no signature change).

Segments are still chained into polylines (`chainSegmentsAtSharedVertices`, `WallRenderer.ts` —
reused as-is) but only the **miter** branch (and the whole **Line** rendering mode) uses the chains
now.

A **miter** join keeps the straight
`lineTo` polyline plus the square-cap/`computeMiterJunctionPatch` treatment below. `getRequiredExportMargin`/`getRequiredWallExportMargin`
both resolve to `computeVectorByCorridorsExportMargin` (`exportMargins.ts`) — the widest of half the
corridor stroke's own width, a start/finish marker's own footprint, the one-way chevron row's own
width, a teleport marker/connector's own footprint, and (via `this.verticalContainer`'s own measured
bounds, folded into `getRequiredExportMargin`'s pixel-accurate path the same way the markers/teleport
containers already are) a vertical connection marker's own footprint, i.e. every geometry this mode
draws past a cell's raw center point; unlike "Vector by walls" there's no separate wall-only margin to
distinguish, so both getters return the same value. Background color is not yet user-configurable
— always `canvas.stage.background` (`resolveBackgroundColor`'s `"vector_by_corridors"` case), a
follow-up sub-issue's concern.

### "Shared style" — centralized marker/corner-style settings (GitHub issue #322, generalized to a generic parameter-link engine by #643)

Both render mode settings panels have a "Shared style" section, always the first section (before
"Background"). It centralizes nine ordinary top-level settings fields (`markerShape`, `cornerStyle`, `markerSize`,
`markerFillColor`, `markerBorderColor`, `markerBorderWidth`, `gapWidth`, `markerTextSize`, `markerTextFontWeight` — part of `SharedStyleSourceFields`, `imageExportTypes.ts`, mixed
into both `VectorByWallsSettings` and `VectorByCorridorsSettings`) that would otherwise need editing
separately on every marker-like field that conceptually shares them:

| Shared value | Default | Drives |
|---|---|---|
| `markerShape` / `markerFillColor` / `markerBorderColor` (GitHub issue #701) | circle / start marker colors | `shape` / `fillColor` / `borderColor` of `startMarker`, `finishMarker`, `teleportMarker`, `teleportFloorBadge`, `elevatorBadges`, plus `verticalShape` / `verticalFillColor` (the per-kind vertical `borderColor`s directly) — **all links disabled by default**, since each marker kind has its own look; enable per field via its row's link control |
| `cornerStyle` (`CornerStyle` = `"round" \| "miter"`) | round | `startMarker`/`finishMarker.cornerStyle`, `teleportMarker.cornerStyle`, `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`/`elevatorBadges.cornerStyle` (GitHub issue #347/#430 follow-ups), and each mode's own wall/corridor join field (`wallJoin`+`oneWayJoin` for "Vector by walls", `join`+`oneWayJoin` for "Vector by corridors") |
| `markerSize` | 17 (px diameter) | `startMarker`/`finishMarker.size`, `teleportMarker.size`, `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker.size` |
| `markerBorderWidth` | 3 | `startMarker`/`finishMarker.borderWidth`, `teleportMarker.borderWidth`, `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker.borderWidth` |
| `gapWidth` | 3 | `startMarker`/`finishMarker.gapWidth`, `teleportMarker.gapWidth`, `teleportConnectorGapWidth`, `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker.gapWidth`, both modes' own `markerIndex.gap`, and "Vector by corridors"' own `splitGapWidth` |
| `markerTextSize` / `markerTextFontWeight` (GitHub issue #707) | 17 px / bold | `startMarker`/`finishMarker`, `teleportFloorBadge` and `elevatorBadges` `.textSize` / `.textFontWeight` — **all links disabled by default** (each kind keeps its own default size) |

GitHub issue #707: the section's "Text" sub-section holds the shared font weight and size. Every font-size slider (start/finish caption, elevator badge, teleport floor badge) has an "Auto-fit" icon button (`AutoFitButton`, `TextFitContext.tsx`) that sets the largest size, snapped to `TEXT_SIZE_RANGE.step`, at which every label governed by that control fits inside its plate's shape (`maxFittingFontSize`, `pixi/textFit.ts`; labels collected across all floors by `computeTextFitItemsAcrossFloors`). It writes through the field's normal setter, so it counts as a manual edit and disables the field's incoming link. Every text also has a "Margin" row (`textMargin`, 0–10 px in 0.5 steps (fractional values are used as-is), default 1; `TextStyleFields`, Shared style `markerTextMargin` linked to every `textMargin`, links disabled by default): the distance the glyph ink must keep from the plate edge, used by the overflow warnings and auto-fit only (never by rendering). The shared size has the same button, applying the smallest fit over all four controls (start, finish, elevator, teleport). Overflowing labels raise the `*_text_overflow` warnings (`export-warnings.md`).

GitHub issue #701: `markerFillColor`/`markerBorderColor` are also project colors (section "Shared style", `PC.sharedMarkerFill`/`sharedMarkerBorder`). The section is a single "Markers" sub-section rendered with the shared `MarkerAppearanceRows` (`MarkerFieldRows.tsx`) — same rows, labels and order as every marker (shape, corner style, size, fill color, border color, border width, gap width). `teleportFloorBadge` and `elevatorBadges` also get disabled links for corner style, size, border width and gap width. Edits go through `patchVectorBy{Walls,Corridors}SharedStyle` (propagate-on-change).

`twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`/`elevatorBadges` start with their
link's `enabled: false` in all groups that apply to them (see the "Vertical connections" section
above), so out of the box they keep their own default look (`DEFAULT_VERTICAL_SETTINGS`, matching
`GenerationRenderer`) rather than the shared values above — listed here as what they'd follow once
their link is re-enabled via their own reset button.

**Engine (`parameterLinks.ts`/`parameterLinksEngine.ts`, GitHub issue #643).** Behind the four rows
above is a generic parameter-link graph, not a hardcoded 4-group mechanism. `ParamLink<P>` is a
`{ id, source, target, enabled, modifiers?, colorModifiers? }` object over `P` — a per-mode path union
(`VectorByWallsParamPath`/`VectorByCorridorsParamPath`, `parameterLinksRegistry.ts`) type-checked
against that mode's own `VECTOR_BY_WALLS_PARAM_REGISTRY`/`VECTOR_BY_CORRIDORS_PARAM_REGISTRY`, which
maps every linkable path (dot-path for a one-level-nested field, e.g. `"startMarker.cornerStyle"`)
to a `ParamDescriptor` (`{ type, equals, label, group, format }`) — same-`type` (`ParamType` =
`"number" | "color" | "cornerStyle" | "markerShape" | "verticalArrowStyle" | "indexLabelStyle" |
"labelFontWeight" | "boolean"`) is the only constraint on what can link to what; `equals` is
`Object.is` in every case (a `"color"` value is just a packed 24-bit RGB number, same representation
every other color field in the app uses — see `store/colorMath.ts`). `settings.links:
ParamLink<...>[]` (persisted — see "Persistence" below) holds the live graph for that mode, seeded
from `DEFAULT_VECTOR_BY_WALLS_LINKS`/`DEFAULT_VECTOR_BY_CORRIDORS_LINKS` (`parameterLinksDefaults.ts`),
which reproduce the table above as plain equality links (each link's `enabled: false` is exactly the
old "override" state). A link's `target` has at most one incoming link (`validateLinkGraph` enforces
this, plus acyclicity and type-matching, over the `DEFAULT_*` constants as a consistency guard) — so
"is this field overridden" is just "is the link whose `target` is this field's path `enabled: false`",
never a matrix.

**Modifier chains (GitHub issue #645 numeric, #647 color).** A link can carry a transform chain
instead of pure equality — `modifiers?: ParamModifier[]` for a `"number"`-type pair
(`{ op: "add" | "sub" | "mul" | "div", value }`, applied in list order by `applyModifiers`, each step
transforming the previous step's result) or `colorModifiers?: ColorModifier[]` for a `"color"`-type
pair (`{ model: "rgb" | "hsl" | "oklch", channel, op, value }`, applied by `applyColorModifiers`).
The two chains are mutually exclusive — a link's `source`/`target` share one `ParamType`, so at most
one is ever set; `undefined`/empty on either means pure equality, same as every other `ParamType`.
`propagate`/`reconcileLinks` dispatch through one shared `applyLinkChain` helper
(`parameterLinksEngine.ts`) rather than duplicating the modifiers-vs-colorModifiers branch at each
call site. A `ColorModifier` step reads its `channel`'s current value out of the source color
(converting to `model` first), applies `op`/`value` to just that one number, then repacks the whole
triple back to a 24-bit RGB number — the other two channels of that step pass through unchanged, and
a chained step in a different model reads the previous step's *repacked* color, so steps compound
through the packed RGB value rather than against each other's intermediate triples. `ColorChannel` is
`"r" | "g" | "b" | "hsl-h" | "s" | "l" | "oklch-h" | "c" | "oklch-l"` — HSL and OKLCH each get their
own hue literal (`"hsl-h"` / `"oklch-h"`) rather than sharing a bare `"h"`, so a step's `channel`
alone (together with its own `model`) fully determines which hue space a degree value means, with no
risk of silently keeping a stale channel selection across a model switch in the editor. Every channel
clamps to its own range on write (`colorChannelRange`): `r`/`g`/`b` to 0-255, `s`/`l`/`oklch-l` to
0-100, `c` to 0+, and both hue channels wrap mod 360 instead of clamping. OKLCH is the default model
for a brand-new color-modifier step (`LinkEditor`'s `ColorModifierStepDialog`, with a hint
recommending it) since channel-wise arithmetic there is perceptually uniform, unlike RGB/HSL where
the same operation can shift perceived hue or brightness as a side effect — but RGB/HSL stay fully
available. A numeric step with `op: "div"` and `value: 0` is rejected at the editor level
(`ModifierStepDialog`/`ColorModifierStepDialog`'s own save-button `disabled`), never reaches the
engine.

Propagation (`propagate(settings, links, changedPaths)`) is a BFS over enabled edges starting from
`changedPaths`, so a future chain `A -> B -> C` (not present in the current `DEFAULT_*_LINKS`, which
are all one level deep, but supported by the engine) would carry a change at `A` through to `C`
transitively. Editing the shared value itself (`setVectorByWallsSharedMarkerSize`, etc.) calls
`propagate(settings, links, [sourcePath])`; editing a dependent field through its own per-mode
setter (e.g. `setVectorByWallsStartMarkerSize`) writes the value, disables that field's incoming link
and propagates from it, so sibling fields in the same group keep following the shared value and
anything linked *from* the edited field follows it too (GitHub issue #704). Every store setter for a
registry field goes through one helper in `parameterLinksEngine.ts` rather than hand-writing that
sequence: `writeLinkedParam(settings, path, value)` for a single field, `applyLinkedPatch(settings,
next, rootPatch, overridable)` for `patch*` actions (detaches each `overridable` path present in the
root-shaped patch), and `propagateLinkedSources(next, changed)` for source-style edits that must not
detach (the vertical "Shared style" patch). Both return `Linked<S>`, a branded settings type: the
image-export slice's `set` accepts only `Linked` values for `vectorByWallsSettings`/
`vectorByCorridorsSettings`, so a hand-rolled `{ ...settings, field: v }` write does not compile.
Fields outside the registry (`randomWallColorMode`, `oneWayPattern`, `renderStyle`,
`markerWidenShape`, `*.text`, `teleportGroupOverrides`, `splitNodeColors`) are written through
`wallsPlain`/`corridorsPlain`, whose `path` is restricted to `WALLS_PLAIN_PATHS`/
`CORRIDORS_PLAIN_PATHS` (a test asserts these never overlap the registry); link-management actions and
reset-to-defaults use the explicit `markLinked` escape hatch.

**Per-field link-status icon (`LinkStatusIcon.tsx`, GitHub issue #652).** Every linkable field row
in both panels — not just the four "Shared style" fields above — carries a `LinkStatusIcon` as its
trailing control, rendered via one of the `Linked*Row` wrappers (`LinkedSelectRow`/`LinkedSliderRow`/
`LinkedColorRow`/`LinkedToggleRow`/`LinkedTextFieldRow`, `LinkedRows.tsx`). Each wrapper takes a
`linkTarget: P | null` prop and reads `links`/`registry`/`onSetLinkEnabled`/`onAddLink` from the
nearest `LinkContextProvider` (`LinkContext.tsx`, one per panel root) instead of threading them
through every intermediate component. `linkTarget: null` marks a field that isn't in the mode's
`ParamDescriptor` registry at all (an enum with no modeled type, a toggle that actually drives a
multi-value field underneath it, etc.) — linking is impossible for it, not merely unset.

Terminology: a **driving link** is the link where this field is the *target* (it follows another
field's value); a **dependent link** is a link where this field is the *source* (another field
follows it). The icon's core is a chain glyph (`Link`/`Unlink` from lucide-react) plus up to two
small corner badges: the green **driving indicator** (top-left) when a driving link exists (active
or disabled as an override); the blue **dependents indicator** (bottom-right) when at least one
dependent link exists; and, only for an unsupported (`linkTarget: null`) field, a red **unsupported
indicator** (bottom-right `X`) over a disabled-gray chain. A field with no link of any kind (but
linkable) renders the chain alone, broken and disabled-gray, with no badge — the glyph itself says
enough. Hovering shows a tooltip (header + the field's own driving/dependent lines, each suffixed
"(disabled)" when inactive, plus a click hint); clicking opens `LinkEditor` (add/edit) or, for a
disabled driving link, re-enables it directly (`onSetLinkEnabled`, equivalent to the old
`OverrideResetButton`'s reset action) without a dialog. An unsupported field's click opens a small
info dialog instead, explaining why (a per-field `unsupportedHint` override is supported for a field
whose unsupported reason isn't the generic "type not modeled yet", e.g. the random-wall-color-mode
toggle).

Visibility is governed by one global `ImageExportState.linkIconVisibility` ("always" / "linked" /
"never", `setLinkIconVisibility`, persisted in the project file with a `"linked"` fallback for an
older/malformed file) — shared by both render modes' "Shared style" section, not per-mode, since the
icon's meaning doesn't change between them. `"linked"` hides the icon on a field with no link of
either kind (same as `"never"`'s blanket hide); an unsupported field never counts as "linked".

Every `ColorRow` / `ColorSwatch` in these panels opens the custom color picker
(`Specs/color-picker.md`, GitHub issue #499) rather than the browser-native color popup; the
`resetButton` wiring above is unchanged by that.

The section's own two buttons: **"Manage links"** (secondary-variant, the standard auxiliary-
action style, not the toggle style) opens the parameter-links dialog below;
**"Reset all settings"** restores the whole render mode's settings object (including `links`,
reseeded from `DEFAULT_VECTOR_BY_WALLS_LINKS`/`DEFAULT_VECTOR_BY_CORRIDORS_LINKS`) to its defaults
(`resetVectorByWallsSettings`/`resetVectorByCorridorsSettings`) — a full-panel reset, not scoped to
shared style alone. (The section used to also have a "Synchronize" button force-enabling every link;
removed as a leftover of the pre-#644 override model once the link-list dialog below became the
actual place to manage links — `forceVectorByWallsSharedStyle`/`forceVectorByCorridorsSharedStyle`/
`forceLinks` still exist in the store/engine but are no longer wired to any UI.)

An info button (`ⓘ`, secondary-variant, same height as "Manage links", GitHub issue #669) sits next
to "Manage links" and opens `ParamLinksInfoModal` — a plain-language, end-user-facing explainer of
the whole parameter-link system (what a link does, how to add/edit one from either entry point, how
setting a linked field's value by hand turns its own link off instead of being overwritten, what a
color modifier is — illustrated with the marker border/fill darkening example rather than any
internal type name — what the link-status chain icon's states mean, and what the "Link icons"
visibility switch above does). Deliberately free of this spec's own internal terminology (driving/
dependent link, `ParamModifier`/`ColorModifier`, override) and silent on already-expected behavior
(e.g. that links and modifiers persist with the project) — those belong to this spec, not to the
in-app explanation.

**Parameter-links dialog (`ParameterLinksDialog.tsx`, GitHub issue #644, redesigned link-centric
per follow-up feedback, then trimmed to just a filter/add toolbar plus the link list).** No
explanatory hint text above the list — the toolbar and cards are self-explanatory. The toolbar holds
a `BreadcrumbNav` filter (see below) and an `AddIconButton` (see below — the quality panel's own flat
`Plus` convention, no border, not a labeled button) that opens `LinkEditor` to add a new link. The
list itself is sorted by the dependent (target) field's own `hierarchicalLabel`, one two-line card per
link — parameters with no link are not shown at all, so the list never mirrors the full settings
panel. Line 1: the dependent field's full hierarchical name on the left; an enable/disable switch, an
edit action, and a delete action on the right (removes the link entirely — distinct from disabling it
— via `removeVectorByWallsLink`/`removeVectorByCorridorsLink`, `removeLink`). Line 2: `"Value: "` then
the target's current value, formatted the same way the settings panel itself displays it
(`registry[link.target].format(getParamValue(settings, link.target))` — e.g. a `cornerStyle`/`join`
field's raw `"round"`/`"miter"` renders as "Скругление"/"Заострение", not the enum string; plain
numbers fall back to `String(v)`; a `"color"` field (`formatColor`) renders as `#rrggbb`, immediately
followed by a small rounded swatch (`styles.valueColorSwatch`, sized to the text line's height) filled
with that same color via `colorToHex`), then "=", then the source's own hierarchical name, then
whichever chain suffix applies — `modifierSuffix` (e.g. `"× 1.5"`) for a `"number"` link's
`modifiers`, or `colorModifierSuffix` for a `"color"` link's `colorModifiers` (one
`colorModifierStepText` per step, e.g. `"− 30L (OKLCH)"` — operator symbol, then value, then the
channel letter, then the model name in parens) — reads as "this value comes from that one, via this
chain". Both hierarchical names render via `HierarchicalLabelSegments`, not the
plain `hierarchicalLabel` string helper: each "/"-separated segment (every `group` entry plus the
field's own `label`) is its own clickable span with a faint `ui.bg.panelAlt` background (a hair
lighter than the card's own `ui.bg.panel`, just enough to read as a distinct token without drawing
attention) and `className="hoverable-tint"` (brightens in place on hover, same convention as the
severity bubbles elsewhere — a plain `.hoverable` class can't layer a hover state on top of a span's
own inline `background` since the inline style always wins). Clicking a segment sets the toolbar's
breadcrumb filter path to that segment prefixed with every segment before it — clicking "Elevator" in
"Vertical connections / Elevator / Marker" filters to "Vertical connections / Elevator", not just
"Elevator" alone (an earlier segment narrows down *which* "Elevator", since the same subsection name
can recur under a different top-level group); a first-segment click has nothing before it to
prepend. A disabled
row is dimmed but stays in the list. Cards use the same bordered-panel look as the quality panel's
own rule cards (`ui.bg.panel`/`ui.border.default`/`radius.md`) so each link reads as a distinct
entity, not a bare row. Edit/delete use the shared
`EditIconButton`/`RemoveIconButton` components (see below). No summary line, no bulk sync/enable/
disable-all actions; those were cut as duplicating the (now also removed) section-level "Synchronize"
button and adding chrome around what's usually a short list.

**Breadcrumb filter (`BreadcrumbNav`, inside the same file).** Replaces an earlier free-text search
box — the filter can only ever be an actual parameter address, built one level at a time, never an
arbitrary typed word. Backed by a group tree (`buildPickerTree`) built only from paths some link's
`target` or `source` actually references, not the full registry — so a level the dropdown can offer
is always a level some visible link can match. The path renders as a chip trail inside the toolbar bar
(empty path reads as the localized "Search parameters..." placeholder, same wording the earlier free-text
box used); the bar itself has a `"hoverable-tint"` hover highlight (not plain `"hoverable"` — the bar's
own inline `background` would otherwise win over a plain class-based background swap) so it reads as
interactive even before the dropdown opens. Clicking the bar toggles a dropdown listing the current
level's children — sub-groups (with a `ChevronRight`, same as `ParamPicker`'s own group rows) and any
leaf parameters sitting at that exact level. Picking a sub-group appends its segment to the path and
leaves the dropdown open, now one level deeper; picking a leaf sets the path to that leaf's full address
and closes the dropdown — same end state as clicking a `HierarchicalLabelSegments` leaf's last segment.
Two flat icon buttons sit inside the bar itself, right after the chip trail (both
`sharedStyles.closeBtn`, vertically centered): `ArrowLeft` pops exactly one trailing segment, `X` clears
the whole path in one click — both only rendered once the path is non-empty. Backspace also pops one
segment while the bar is hovered or the dropdown is open (`hovered || open` gating a `document`-level
`keydown` listener — `open` matters on its own since picking a sub-group leaves the mouse over a dropdown
row, not the bar, so `hovered` alone would stop tracking mid-drill-down). Clicking anywhere outside the
component (a `mousedown` listener on `document`, added only while `open`) closes the dropdown without
changing the path. The link list's own filter matches a link if either its target's or its source's full
segment path (`group` + `label`) starts with the breadcrumb path — an empty path matches everything.

**Add/Edit link (`LinkEditor`, inside the same file).** The full parameter list only appears here,
not on the dialog's main screen — three side-by-side columns: two wide hierarchical, collapsible
pickers (`ParamPicker`, built by `buildPickerTree` from each path's `registry[path].group` segments,
mirroring the settings panel's own section/subsection nesting rather than a flat alphabetical list)
for **Target**/**Source**, and a narrower third column for whichever modifier chain the picked pair's
`ParamType` actually supports. Column titles and group folder rows both use the same `typography.body`
header style `SectionHeader`/`SubsectionHeader` use for the render-mode settings panel's own section
titles — no bold, no caption-level or title-level token. The left picker chooses **Target** from every
path in the registry; picking one filters the right **Source** picker down to same-`ParamType` paths
excluding that target — mirrors the engine's own `source`/`target`-must-match-type and
at-most-one-incoming-link rules. The third column shows a status hint (`modifiersHint`/
`colorModifiersHint`, e.g. "pick a dependent parameter first" / "not available for this parameter
type") until both endpoints are picked and the pair is `"number"`-type (the plain numeric chain,
`ParamModifier`/`ModifierStepDialog`) or `"color"`-type (the per-channel color chain, `ColorModifier`/
`ColorModifierStepDialog`) — never both at once, since a pair shares one `ParamType`. Each chain is a
read-only list of short step rows (`ModifierStepRow`/`ColorModifierStepRow`, edit/delete actions) plus
an add button; a step is only ever added/edited through its own small modal, never inline in the list.
Switching Target/Source to a pair whose type no longer matches the chain being built drops it. Saving
is blocked while any numeric step divides by 0 (would make the target NaN/Infinity on every
propagation), via the save button's own `disabled`. "Edit" reopens this same component pre-filled with
the link's current `source`/`target`/chain; saving (Add or Edit) always calls `onAddLink`
(`addVectorByWallsLink`/`addVectorByCorridorsLink`, engine's `addLink`), which replaces any prior link
already targeting that target and propagates the source's current value in immediately — so editing a
link's source re-syncs the target's value as part of the save.
Cycles are prevented at creation time (GitHub issue #721): the engine's `reachableFrom(links, start)` is
a DFS along all existing links (disabled ones included, since `validateLinkGraph` counts them), and
`wouldCreateCycle(links, source, target)` is true when `source` is in `reachableFrom(links, target)` or
`source === target`.
`addLink` refuses such a link (returns `settings`/`links` unchanged). `LinkEditor` keeps those Source
candidates listed but disabled (`ParamPicker`'s `disabledPaths`): dimmed, not-allowed cursor, a cycle
icon after the label, not clickable, and a tooltip on the whole row (a group row whose leaves are all
disabled, `allLeavesDisabled`, is dimmed and gets the icon too) ("Source unavailable: it would create
a cyclic dependency between links."). An already-picked source that a newly chosen Target makes cyclic
is cleared.
Because that replacement is otherwise silent, `LinkEditor` takes `existingLinks` (all current links) and,
when the chosen target already has one that differs from what is being saved (GitHub issue #720), the
first Save click opens a small confirm modal ("Replace link?" — "This parameter already depends on
"<source's hierarchical label>" followed, outside the quotes, by its modifier chain, e.g. `"Alpha" × 2`. Saving will replace that
link.", Cancel/Replace) instead of calling `onSave`; only Replace (or Enter/Space in that modal) saves.
"Differs" means a different source or a different numeric/color modifier chain (empty chain equals no
chain); re-saving an identical link (Edit with no changes) saves immediately with no prompt. The whole dialog is scoped to whichever
render mode's panel opened it (`SharedStyleSection`'s own `links`/`registry`/`settings` props, generic
over `P`) — not persisted any differently than `links` itself (see "Persistence" below).

**Inactive parameters (`store/parameterLinksActivity.ts`, GitHub issue #670).** A registry path can
be currently hidden by the settings panel itself, independent of whether it has a link at all — e.g.
every `teleportMarker.*`/`teleportFloorBadge.*` path while the maze has no teleports, or
`twoWayArrowColor` while `verticalStyle` is `"decorative"`. Each `VectorByWallsSettingsPanel`/
`VectorByCorridorsSettingsPanel` computes a `Set<P>` of currently-active paths
(`computeActivePaths`, memoized on the same maze-derived flags — `hasOneWays`/`hasTeleports`/
`hasCrossFloorTeleports`/`hasTwoWayPassages`/`hasOneWayPassages`/`hasElevators`/
`hasVerticalSection` — that already gate those sections' own rendering, plus the handful of
settings fields — `verticalStyle`, `showGrid`, `showInnerGrid`, `elevatorBadges.enabled`,
`markerIndex.enabled`, `startMarker.textEnabled`/`finishMarker.textEnabled` (every caption field of that
marker except the toggle itself) — that hide a subsection regardless of the maze) and threads it through
`LinkContext`'s `activePaths` field alongside `links`/`registry`/`onSetLinkEnabled`/`onAddLink`, so
both `LinkStatusIcon` (opened from a single field row) and `SharedStyleSection`'s own
`ParameterLinksDialog` (opened via "Manage links...") see the same activity data.
`isPathActive`/`computeActivePaths` match path names by prefix/exact string rather than against the
registry's own (localized) `group` arrays, so the logic stays locale-independent. Only fully
hidden/unmounted fields count as inactive — a merely `disabled`-but-still-rendered field (e.g.
`markerIndex.borderWidth` while `borderWidthFromMarker` is on) is not.

In the link list, any row mentioning an inactive parameter — as its target (line 1) or its source
(line 2, after "=") — gets a closed-eye badge (`EyeOff`, from `lucide-react`) right after that
path's `HierarchicalLabelSegments`, with a tooltip explaining why ("this parameter is currently
inactive..."). This is independent of `LinkEditor`'s own toggle below — a link already set up on a
now-inactive parameter always shows the badge in the list, whether or not `LinkEditor` happens to be
showing inactive paths at the time.

In `LinkEditor`'s Target/Source pickers, a "Show inactive" toggle (`ToggleRow`, label left switch
right — same convention as every other labeled toggle in the app) sits at the bottom of the dialog,
to the left of Cancel/Save, default on. Off: both pickers list only active paths, plus whichever
path is already selected as that picker's current Target/Source even if it's since gone inactive
(so editing an existing link never looks like its own endpoint vanished). On (default): every
registry path is listed, with the same `EyeOff` badge marking the inactive ones inline after each
leaf's label, and the row itself dimmed (`muted(typography.body)`) for extra visual distinction —
letting a link be deliberately set up on a parameter that's hidden right now but might become
relevant later (e.g. pre-wiring a teleport-related link before any teleport exists in the maze yet).
A group row is dimmed and gets the same badge whenever every leaf nested under it is inactive
(`allLeavesInactive`, GitHub issue #688) — before this, a section with nothing active inside it
looked identical to a fully active one in the picker tree, with no way to tell without expanding it;
the link list's own path-mention badges (previous paragraph) already covered the single-parameter
case, this extends the same signal to whole collapsed sections.

The four "Shared style" source fields (`cornerStyle`/`markerSize`/`markerBorderWidth`/`gapWidth`)
carry `group: ["Shared style"]` (the section they actually live in), not an empty `group` — so they
too show up nested under "Shared style" in the picker tree and in any `hierarchicalLabel`, instead of
floating at the dialog's top level. Their own `label`s dropped the earlier `"Shared: "`/`"Общее: "`
prefix once they got a real group segment — the section name already says that.

**Registry coverage (`parameterLinksRegistry.ts`).** Covers effectively every linkable field in both
panels, including every color field (GitHub issue #647 — fill/border/text colors on every marker,
background/grid/floor/wall colors, vertical-connection arrow colors, teleport edge/connector/floor-
badge colors, marker-index colors, and so on): plain numbers and booleans (`formatBoolean`, localized
"Вкл"/"Выкл") fall back to generic formatting; `"color"` fields render as `#rrggbb` (`formatColor`,
`colorToHex`); `cornerStyle` fields (including the three `*ArrowCornerStyle` fields, which are plain
`CornerStyle` despite their vertical-arrow-specific naming) share `formatCornerStyle`. Four small
string enums reused across multiple fields each get their own `ParamType` and format function instead
of a raw enum string: `markerShape` (`formatMarkerShape`, backed by the same 8 values
`MARKER_SHAPE_OPTIONS` uses), `verticalArrowStyle` (`formatVerticalArrowStyle`), `indexLabelStyle` and
`labelFontWeight`. The latter two need per-field label-text selection, not one shared format — the
same `arabic`/`roman`/`letters`/`regular`/`bold` values render under different wording depending on
whether the field is an elevator/teleport-floor badge (`elevator_badges_label_type_*`/
`elevator_badges_font_weight_*`, the `descriptor()` default) or a marker-index field
(`marker_index_label_style_*`/`marker_index_font_weight_*`, passed explicitly as a `format` override).
A handful of one-off enum domains (random wall color mode, one-way render pattern, corridor marker-
widen shape, teleport connector style/arrow mode, and similar single-field selects) are intentionally
not in the registry yet — each would need its own `ParamType` for exactly one field, with no shared
format to reuse, and how to denote that is still undecided.

A `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker` object's `cornerStyle`/`size`/
`borderWidth`/`gapWidth`/`shape` fields all share one `group` (ending in the panel's own "Маркер"
subsection), not a shallower one for the first four and a deeper one for `shape` — the panel renders
all five inside the same `MarkerSettingsGroup`, under one `vertical_subsection_marker` wrapper, so the
registry's `group` path mirrors that rather than splitting one object's fields across two picker-tree
depths. The decorative-mode counterparts (`decorativeStairsTwoWay`/`decorativeStairsOneWay`/
`decorativeElevator`, each a walls-only `DecorativeLineStyle`, see "Vertical connections" above) are
registered under the very same group as their abstract counterpart — `decorativeStairsTwoWay.*` under
`G.verticalTwoWayMarker()`, etc. (GitHub issue #677 follow-up correction: an earlier version of this
registry gave decorative fields their own shallower group, and before that a short-lived top-level
Abstract/Decorative split, neither of which matched the panel; the panel in fact renders exactly one
"Marker" sub-subsection per sub-group regardless of `verticalStyle` — only *which* fields appear
inside it changes with the mode toggle). Decorative-mode `label`s instead carry the "(Декоративный)"
suffix (`decorativeLabel`) described under "Vertical 'Shared style' group" above, same convention used
there for `verticalSize`/`verticalArrowSize` vs. `verticalDecorativeSize`/`verticalDecorativeArrowSize`.
These three sub-objects are registered only in `VECTOR_BY_WALLS_PARAM_REGISTRY` —
`VectorByCorridorsSettings` has no `VerticalDecorativeFields` at all (corridors mode has no
decorative/abstract `verticalStyle` toggle), so neither these three sub-objects nor
`decorativeStairsArrowSize`/`decorativeStairsOneWayArrowSize` exist for corridors.

The vertical "Shared style" group's own ten (fourteen for walls) fields (`verticalCornerStyle`/
`verticalShape`/`verticalSize`/`verticalBorderWidth`/`verticalGapWidth`/`verticalFillColor`/
`verticalArrowColor`/`verticalArrowSize`/`verticalArrowStyle`/`verticalArrowCornerStyle`, plus
walls-only `verticalDecorativeLineColor`/`verticalDecorativeLineWidth`/`verticalDecorativeSize`/
`verticalDecorativeArrowSize`, see "Vertical 'Shared style' group" above) are registered in both
`VECTOR_BY_WALLS_PARAM_REGISTRY` and `VECTOR_BY_CORRIDORS_PARAM_REGISTRY` (the walls-only quartet
omitted from the corridors one) under `G.verticalSharedStyle()` — nested one level under "Vertical
connections" alongside the three per-group sub-groups, not flattened to the section's own top level,
same as every other nested sub-group in this registry.

**`EditIconButton`/`RemoveIconButton`/`AddIconButton` (`components/EditIconButton.tsx`,
`components/RemoveIconButton.tsx`, `components/AddIconButton.tsx`).** Reusable icon-button components
extracted from the quality panel's own row/toolbar-action convention (a plain "✎" glyph for edit, a
lucide `X` for remove/delete — never a trash-can icon — and a flat, borderless lucide `Plus` for add)
so every edit/delete/add entry point across the app renders and behaves identically instead of each
row or toolbar hand-rolling its own button+glyph copy. Used by `ParameterLinksDialog`'s link rows and
its own toolbar's "+" button, `FloorsFeature`'s floor rows, and the quality panel's own
`RuleCheckRow`/`NestedStrategyPanel`/`RulesColumn`/`RuleStrategyPanel`. `RemoveIconButton` takes a
`size` (16 compact / 18 card-level) and an optional `disabled` (dims via opacity, e.g. "can't remove
the last floor"); `EditIconButton` takes an optional `fontSize` override; `AddIconButton` has no
options — always the same flat 16px `Plus`. Toolbar-style button rows with their own distinct
padding/border convention (e.g. `RulesColumn`'s 5-button uniform stage toolbar, which keeps its own
inline `Plus` button so it stays visually uniform with its ChevronUp/ChevronDown neighbors sharing
the same `stageToolbarBtn` style) are left as-is rather than forced into these generic components.

**Defaults are derived, not duplicated.** `DEFAULT_MAZE_RENDER_STYLE`
(`pixi/defaultMazeRenderStyle.ts`) is the store-independent runtime source for the live canvas and
the matching parts of `DEFAULT_VECTOR_BY_WALLS_SETTINGS`: background/grid/floor, walls, one-ways,
start/finish markers, teleports, vertical connections, and split rendering. Low-level renderers
read only their own section; `imageExportDefaults.ts` assembles those sections plus the four shared
values into a placeholder settings object and runs it through one `propagate(..., DEFAULT_*_LINKS,
["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"])` call, so every non-disabled
dependent field's default is derived from the shared value rather than duplicated by hand; a
disabled-by-default link's field (the four vertical-marker groups above) keeps whatever literal
value `DEFAULT_VERTICAL_SETTINGS`/`DEFAULT_VERTICAL_DECORATIVE_SETTINGS` supplied instead, since
`propagate` skips disabled edges. Export-only state (group customization,
`teleportAvoidFieldExit`, decorative vertical settings, enabled elevator badges, and `links` itself)
remains in the export model, not the runtime style.

**Persistence (GitHub issue #651).** `ProjectFileImageExport` carries `vectorByWallsLinks`/
`vectorByCorridorsLinks: ParamLink<P>[] | null`, alongside (not inside) the mode's own
`vectorByWallsSettings`/`vectorByCorridorsSettings` object — `serializeProject` (`serialize.ts`)
compares the live `settings.links` against that mode's `DEFAULT_*_LINKS` via `linksMatchDefaults`
(`parameterLinksEngine.ts`, an order-independent, `id`-ignoring structural comparison): an untouched
project (every link still exactly matches its default `source`/`target`/`enabled`/`modifiers`/
`colorModifiers`) serializes that field as `null`, so the file stays lean and a later change to
`DEFAULT_*_LINKS` (e.g. #649) is picked up automatically on next load rather than being frozen out by
a stale saved copy. The instant any link deviates — a user disabled/re-enabled one, edited its
`modifiers`/`colorModifiers`, or added/removed one via the parameter-links dialog (#644) — the field
holds the **entire current `links` array verbatim**, not a diff.

On load, `validateLinks` (`validateImageExport.ts`) reads that field: `null`/absent (including every
project file saved before #651) means "use the current `DEFAULT_*_LINKS` as-is". A present array is
parsed leniently per entry (a malformed link is dropped, same recovery convention as the rest of
this file) and then re-checked whole via `validateLinkGraph` (shared with the `DEFAULT_*_LINKS`
dev-time consistency guard, `parameterLinksEngine.ts`) — a result that fails validation (duplicate
target, cross-type pair, a cycle, an unknown path) falls back to the defaults entirely rather than
loading a corrupt graph. An explicit `[]` (the user removed every link) is preserved as-is, distinct
from `null` — it round-trips as "no links" rather than reverting to defaults. The four shared-style
source values themselves (`cornerStyle`/`markerSize`/`markerBorderWidth`/`gapWidth`) remain ordinary
persisted fields inside `vectorByWallsSettings`/`vectorByCorridorsSettings`, validated/defaulted like
any other settings field, unaffected by this mechanism.

### Widening a corridor under a marker (`drawMarkerWidenPatches`, `pixi/renderers/markerWidenPatches.ts`)

GitHub issue #311 — a start/finish marker sitting directly on a corridor's centerline would
otherwise get visually swallowed by (or collide with) the thin corridor stroke passing under it.
`drawMarkerWidenPatches(g, markers, lineColor, lineWidth)` draws one filled patch per marker into
the caller's own `Graphics`, in the line's own color, matching the marker's own shape (not always a
disc — `drawMarkerShape` with the marker's own `shape`/`cornerStyle`) at a radius of
`max(marker's own visible footprint, lineWidth / 2)`. A marker's visible footprint is
`radius + (borderWidth ?? 0) + (gapWidth ?? 0)` — the same formula `exportWarnings.ts`'s
`markerWorldRadius` uses for its own overlap checks — so the patch always fully covers what the
marker will draw on top of it; the `lineWidth / 2` floor means a marker smaller than the stroke
never narrows the line under it. Deliberately generic (`MarkerData[]`, not a waypoint-specific
type) and not tied to any one renderer — `VectorByCorridorsRenderer` calls it once per `renderAll`,
drawing the patches in a dedicated layer above split corridor geometry and its background-colored
gap patches, but below the waypoint/teleport/vertical marker bodies (GitHub issue #561). Keeping
the marker expansion above the split-gap layer prevents a non-zero corridor gap from leaving an
antialiased hairline of background visible along a marker edge. The `padding` is the user-facing
marker-widen expansion and is included in this layer ordering. Any future marker type sharing this
canvas (or a different renderer altogether) can call it the same way.

### Export warnings

The complete warning contract for `VectorByWallsRenderer` and `VectorByCorridorsRenderer` is
specified in [`Specs/export-warnings.md`](export-warnings.md). The sections below retain the
renderer-specific geometry notes and historical rationale for individual warnings.

#### Corridors-specific export warnings (`computeVectorByCorridorsWarnings`, `exportWarnings.ts`)

GitHub issue #311's own check, plus the three teleport checks added as a #313 follow-up bugfix:

- **`waypoint_on_split_corridor`** — a start/finish marker sits on *any* split point
  (`buildSplitPointKeys`, not just a "special shape" one). Unlike `VectorByWallsRenderer`, this mode
  draws no split-point geometry at all — `buildCorridorSegments` skips every split point
  unconditionally — so a waypoint marker there has no corridor line under it whatsoever, worth
  flagging regardless of whether the point would've been a recognized special shape under "Vector by
  walls"' own reading.
- **`teleport_marker_invisible`**, **`teleport_group_ambiguous`**, **`teleport_waypoint_overlap`** —
  identical checks to "Vector by walls"' own (see "Export warnings" below), since this mode reuses
  `TeleportRenderer` as-is and can hit the exact same caveats. Factored into a shared
  `computeTeleportWarnings` helper (`exportWarnings.ts`) taking `TeleportSettingsFields` plus a
  start/finish marker style, called by both `computeVectorByWallsWarnings` and
  `computeVectorByCorridorsWarnings`, so the two modes' warning sets can't silently drift apart on
  the fields they actually share.
- **`one_way_arrows_overflow_corridor`** (GitHub issue #312) — the "One-ways" section's own settings
  would draw a chevron row overflowing a single cell's bounds: either the row's full visible extent
  along the corridor (`(count-1) * chevronRowStep(lengthPx, gap, thickness) + lengthPx + thickness`,
  mirroring `drawOneWayChevronRow`'s own spacing exactly) exceeds `TILE_SIZE`, or `oneWayWidth`
  exceeds `1` (wider than the corridor stroke itself — reachable only via a malformed/hand-edited
  project file, since the settings panel's own slider caps at `1`). One warning total, covering every
  one-way passage at once. Flagged edges/nodes come from `buildCorridorSegments`' own `oneWayDir`
  segments (via their `fromNode`/`toNode`) — the exact set of passages this mode actually draws a
  chevron row for, not a looser re-derivation from the raw edge list that could flag an edge with no
  drawn corridor segment at all (a split-point edge, or a non-geometric-neighbor pair).

This mode has no special-split-shape rendering of its own to check against
(`waypoint_on_split`/`teleport_on_special_split` stay "Vector by walls"-only), which is why
`computeVectorByCorridorsWarnings` is still its own function rather than folded entirely into
`computeVectorByWallsWarnings`. Wired into the settings panel the same "Warnings" section convention
`VectorByWallsSettingsPanel` uses (`resolveExportWarningsSectionTitle`, `ExportWarningBubble`,
hover-highlight via `hoveredExportWarningKey`) — including its own `RegionHighlightRenderer`
instance (`VectorByCorridorsRenderer`'s own, per the feature-renderer ownership rule, mirroring
`VectorByWallsRenderer`'s own highlight overlay described below).

### Shared marker shape set (`MarkerShape`, `pixi/renderers/markerShapes.ts`)

Circle markers use the shared `circlePolygonPoints` adaptive closed polygon instead of PixiJS
`Graphics.circle()`'s centre-fan triangulation. The latter could expose a zoom-dependent radial
seam over corridor geometry (GitHub issue #561); polygon and circle markers otherwise use the same
`drawMarkerShape` API.

GitHub issue #293 follow-up unified what used to be two separate shape enums/draw functions — a 5-value `MarkerShape` for start/finish waypoints and a 9-value `TeleportShape` for teleports (including `crescent`, a moon shape that read poorly at marker scale and had a geometry defect — see below) — into one 8-value `MarkerShape`: `circle`/`triangle`/`square`/`diamond`/`pentagon`/`star`/`hexagon`/`cross`. Both `WaypointsRenderer` and `TeleportRenderer` draw through the same `drawMarkerShape(g, shape, cx, cy, r, rounded?)`, so waypoints and teleports never diverge in how a given shape looks; `markerPolygonPoints` (regular-polygon corner points, `star` alternating outer/inner radius, `cross` its own fixed 12-vertex layout) backs both the sharp path (`g.poly`) and the rounded path, via `markerShapes.ts`'s own `drawRoundedPolygon` (a general canvas-style per-corner `arcTo` rounder, not `Graphics.roundPoly` — needed since `star`/`cross` have no regular-polygon equivalent `roundPoly` could round). Each corner's radius is capped to half its shorter adjacent edge, and `star`'s reflex (inward-pointing) corners are gated out of rounding entirely (a rounded arc there reads as a spike at typical marker sizes, no radius clamp fixes it). The closed path's `moveTo` start is placed at corner 0's own tangent-out point (`cornerTangentPoint`, `radius / tan(halfAngle)` from the vertex along the edge — not a naive edge-midpoint, which only happens to be correct when both corners sharing that edge round equally) so the path's start exactly matches where the loop's final `arcTo` call closes back to — a mismatch there left a stray straight overshoot at the seam, visible on `star` specifically since its corners alternate rounded/sharp. `polygonCornerRadius`/`cornerTangentPoint` are exported pure functions, unit-tested independently of `Graphics`. `WaypointsRenderer` always draws sharp (`rounded` defaults to `false`, and nothing ever passes it `true`) — corner-style is a teleport-only setting (`teleportCornerStyle`, see above).

The rounding radius itself is `r * 0.25`, `r` being the radius `drawMarkerShape` was called with — this is exactly why every gap ring / widen patch / floor-badge ring (`drawMarkerUnderlay`, `pixi/renderers/markerShapes.ts`) always draws its base path at the marker's own plain fill radius (`baseRadius`, never a pre-widened `baseRadius + borderWidth`), and grows outward from there in one single `stroke()` call rather than redrawing the shape bigger first: recomputing the polygon at a bigger radius rescales this same `r * 0.25` rounding radius right along with it, which draws each rounded corner as an arc of a *different, bigger circumradius* centered on the enlarged polygon's own vertices — correct along straight edges, but at each corner the arc bulges out further than a true outward offset would (GitHub issue #552 second follow-up; the sixth follow-up hit the identical bug again in `markerWidenPatches.ts` before that file was fixed to offset from `marker.radius` too, and the ninth follow-up did the same for every gap ring, which used to offset from a pre-widened `radius + borderWidth`). The fix draws the underlay as a true outward offset of the *marker's own path*: `drawMarkerUnderlay(g, shape, cx, cy, baseRadius, rounded, outset, color)` fills the marker's own polygon at `baseRadius`, then (when `outset > 0`) strokes that same path with `width: outset`, `alignment: 0` (pixi's own scale: `1` = inner, `0.5` = centered, `0` = outer — same convention every other border/gap stroke in this codebase uses) and `join: "round"` — pixi's own round join is the offset operation, growing every edge and corner alike by exactly `outset`, arcs included, instead of a second hand-rolled rounded-polygon draw at a bigger size. `width` at `alignment: 0` is the stroke's *full* visible growth, not a diameter split across both sides of the path (confirmed empirically: a radius-10 circle stroked with `{width: 4, alignment: 0}` bounds out to radius 14, not 12) — an earlier version passed `width: outset * 2` here, doubling every gap ring's/widen patch's visible thickness relative to the marker's own border stroke (GitHub issue #552 eighth follow-up). (A still earlier version passed `alignment: 1` by mistake — pixi's *inner* alignment, which strokes entirely back onto the already-filled disc and draws no visible ring at any `outset` — GitHub issue #552 third follow-up.)

Every underlay call site (`WaypointsRenderer`'s gap ring, `TeleportRenderer`'s gap ring/floor-badge ring, `VerticalConnectionRenderer`'s marker gap/elevator-badge gap, `markerWidenPatches.ts`'s `drawMarkerWidenPatches`, `toolGlyphs.ts`/`teleportPreviewGlyph.ts`'s own gap rings) calls `drawMarkerUnderlay` with the marker's own *fill* radius (never fill + border) as `baseRadius`, and a single `outset` covering the *whole* offset distance in one stroke: a gap ring's `outset` is `borderWidth + gapWidth` (so the marker's own border, drawn afterward on top from that same `baseRadius`, exactly covers the ring's inner `borderWidth`-wide band, leaving only the outer `gapWidth`-wide band visible — the ring is never given its own separate `gapWidth`-only stroke on top of an already-widened base shape), and a widen patch's `outset` is `borderWidth + extra` (`extra` being whatever's left of the footprint beyond the marker's own true outer edge). Each of `borderWidth`/`gapWidth`/`padding` is its own independent on/off switch for the underlay it drives — `0` skips that draw entirely (no zero-width stroke, no zero-outset call): a gap ring only draws when `gapWidth > 0` (regardless of `borderWidth`), and `drawMarkerWidenPatches` returns immediately when `padding <= 0` regardless of `borderWidth`/`gapWidth` (GitHub issue #552 seventh follow-up). `markerWidenPatches.ts` additionally floors `extra` at `0` since its own `patchRadius` is floored at `lineWidth / 2`, which can leave `patchRadius` below the marker's own outer radius for a marker smaller than the stroke.

Border-aware size compensation (GitHub issue #683): `drawMarkerShape`'s area-matching only equalizes the *fill* contour, but a border offset adds more area/reach on sharp-cornered shapes than on a circle. `borderCompensatedRadius(shape, r, borderWidth, rounded)` (`markerShapes.ts`) therefore returns a shrunken fill radius for which the shape's *outer* contour (fill offset by `borderWidth`, same join as `drawOffsetMarkerShape`) has the same area as a circle of radius `r + borderWidth`; it is `r` for `circle` and for `borderWidth <= 0`. Solved by bisection on the real offset-path area at a fixed reference radius and cached as a fraction of `r` keyed by `borderWidth / r`. `drawMarkerWithBorder` applies it itself; `drawMarkerUnderlay` takes a trailing `borderWidth` argument (default `0`) and applies it to `baseRadius` so a gap ring / widen patch offsets from the exact same fill contour the marker draws — every underlay call site that also draws a border passes the marker's `borderWidth`. `TeleportRenderer`'s mixed-cell half-fill and `toolGlyphs.ts`'s tool glyph use the helper directly. So the "marker's own fill radius" above means the border-compensated fill radius whenever `borderWidth > 0`.

### One-way indicator default changed everywhere, not just "Vector by walls"

`WallRenderer.drawOneWayIndicator` (`pixi/renderers/WallRenderer.ts`) draws a bordered, larger triangle by default now — `drawOneWayTriangle(g, cx, cy, dx, dy, { borderColor: canvas.floor.default, borderWidth: 3, size: TILE_SIZE * 0.3 })` — whenever no `OneWayStyleOverride` is passed at all. This is a deliberate shared visual change (GitHub issue #292 follow-up) affecting every caller of `WallRenderer`, not just `VectorByWallsRenderer`: `GenerationRenderer`, `PostEditRenderer`, `PresetConnectionsRenderer` and `MazeOverlayRenderer` all pick up the bordered triangle look automatically, unlike the wall-stroke override above (which is opt-in per caller). `drawOneWayTriangle` itself (`pixi/renderers/wallUtils.ts`) draws via `Graphics.roundPoly` rather than a hand-built `poly` path — `join`/`stroke` alone can't round a filled shape's own corners, only `roundPoly`'s per-corner `corner` radius can — and positions the triangle asymmetrically along its pointing direction: the tip sits 65% of the triangle's length ahead of the wall segment's midpoint, the base 35% behind it (not centered), so the arrowhead reads as protruding from the wall rather than floating over its center. A one-way indicator is always drawn on top of its wall segment (`WallRenderer.render` strokes all wall segments first, then draws every one-way indicator in a second pass) — in every caller, not just `VectorByWallsRenderer`.

`drawOneWayChevron`/`drawOneWayArrow` (also in `wallUtils.ts`) are the two alternative patterns exposed only through `VectorByWallsSettingsPanel`'s "One-ways" section (no other caller ever passes an override, so they never see anything but the default triangle). Both share an `OneWayDrawStyle`'s `thickness` knob for their own line width, independent of `size` (the indicator's geometric scale) — chevron draws two strokes meeting at the tip in a shallow `>` shape (its own `join`/`cap` apply at the vertex and open ends), arrow draws a shaft (ending at the arrowhead's own base, not the tip, so a `square` cap never protrudes past the narrower arrowhead) plus a line-only two-stroke arrowhead. Both support the same outward-only border as the triangle, implemented as a second, wider stroke pass underneath the main one (rather than `alignment: 0`, which only applies to a closed/filled shape's own stroke).

## Export warnings (GitHub issue #298)

A maze can be perfectly valid QC-wise (`Specs/quality_control.md`) but a specific render mode still can't depict some case correctly — e.g. a teleport whose exit marker draws with zero visual footprint under the current style settings. These are export-method-specific presentation caveats, distinct from `IssueDto` (generic maze validity): computed by `computeVectorByWallsWarnings`/`computeVectorByCorridorsWarnings` (`maze-web/src/pixi/selectors/exportWarnings.ts`), pure, renderer-agnostic functions (no Pixi/store dependency) returning `ExportWarning[]` — `{ id: ExportWarningId, key: string, nodes: number[], edges: [number, number][] }`. The three teleport-only checks are shared between both modes via `computeTeleportWarnings` (see "Vector by corridors"' own warnings section above for what stays mode-specific). Kept renderer-agnostic so a future consumer (e.g. a feature-card status summary showing per-render-mode warning counts) can call the same functions without depending on either settings panel or renderer.

**One warning entry per `ExportWarningId`, always** — every occurrence of the same kind of caveat collapses into a single entry (e.g. every colliding teleport group, every overlapping waypoint) rather than one entry per affected entity, so the panel shows one bubble per warning *type*. `nodes`/`edges` still span every entity the warning covers, so hovering the one bubble highlights all of them at once.

Checks, all computed unconditionally on every call (cheap relative to a maze regenerate):

- **`teleport_marker_invisible`** — a one-way teleport's exit-only endpoint draws with a floor-colored fill instead of `edgeColor` (`"outline"` fill state, see `TeleportRenderer.ts`'s `resolvePointFillState`), so with `teleportMarker.borderWidth === 0` it has nothing to draw at all. `buildPointFillStates` resolves every teleport point's fill state in one pass over `teleportEdges` (not one `resolvePointFillState` call per endpoint, which would be quadratic).
- **`teleport_group_ambiguous`** — two or more teleport connection groups (`buildTeleportGroups`) resolve to the same color+shape while `teleportConnectorStyle === "none"` — with no connector line, nothing else tells them apart visually.
- **`teleport_waypoint_overlap`** — a teleport endpoint marker's visual footprint (`size * TILE_SIZE + borderWidth`) overlaps a start/finish marker's own footprint at that point.
- **`waypoint_on_split`** — start/finish sits on a split point recognized as a dedicated "special shape" (bridge/diagonal, `SplitSpecialShapeKind` — see "Splits" section above), and only when `splitSpecialShapes` is actually on (off, every split point draws the plain per-node reading, which a waypoint marker handles fine). A plain (non-special) split point never triggers this.
- **`teleport_on_special_split`** — same rationale as `waypoint_on_split`, checked separately for teleport endpoints (a teleport marker's geometry differs from a waypoint marker's).

Both split-point checks share one `specialSplitPointKeys` set (built once via `buildSplitPassages(...).specialShapes`, keyed by `pointKey`) and a common `filterNodesOnSpecialSplit` helper.

- **`elevator_indistinguishable`** (GitHub issue #471) — fires only when marker indices are not shown for elevators (`!(markerIndex.enabled && markerIndex.coverage.elevator)`) **and** elevator floor badges are off (`elevatorBadges.enabled === false`) **and** two or more distinct `elevator` nodes occupy the same cell on the drawn (already floor-scoped) floor. By the one-node-per-shaft-per-floor invariant, two distinct elevator nodes in one cell are always different shafts, so no component analysis is needed — the check groups `elevator`-edge-incident node ids by `${x},${y}` and flags any cell with ≥2. Emitted by both `computeVectorByWallsWarnings` and `computeVectorByCorridorsWarnings`; `nodes` is the sorted union of the flagged node ids, `edges` empty.

**Panel UI** (`VectorByWallsSettingsPanel.tsx`): a collapsible "Warnings" section at the bottom of the panel (title shows the count, e.g. "Warnings (2)"), hidden entirely when there are no warnings. Each warning renders as an `ExportWarningBubble` — same look/interaction as `IssuesBlock`'s `IssueBubble` (Analytics feature): an info icon opens a `Modal` with the warning's description (`resolveExportWarningDescription`, `exportWarningsI18n.ts` — descriptions state the problem only, no fix suggestions), hovering the bubble sets `hoveredExportWarningKey` in the store.

**Highlight overlay**: `VectorByWallsRenderer` and `VectorByCorridorsRenderer` each own their own `RegionHighlightRenderer` instance (per `maze-web/CLAUDE.md`'s feature-renderer ownership rule — never shared between the two mode renderers or with `AnalyticsRenderer`'s issue-highlight overlay), rendering a yellow cell-fill highlight (`WARNING_HIGHLIGHT_COLOR`, `0xffaa44`, exported from `VectorByWallsRenderer.ts` for reuse — no perimeter, `skipPerimeter: true`) for the hovered warning's `nodes`, each as its own singleton region group so unrelated cells never get a perimeter drawn between them. Each renderer memoizes its own `compute*Warnings` result by reference-equality of its inputs (`nodes`/`edges`/`cfg`/its own mode settings/`start`/`finish`), so hovering a warning (which changes only `hoveredExportWarningKey`) doesn't recompute the whole warning list.

## PNG export

`EXPORT_FORMATS` (`exportFormatRegistry.ts`) is the export-format counterpart of `RENDER_MODES` — one `ExportFormatDescriptor` (`id`, `label`, `SettingsPanel`) per format, `resolveExportFormat(id)` returning `null` (not throwing) for an unknown id, same degrade-gracefully convention as `resolveRenderMode`. `png` is the only registered format. Clicking a format's own export button (`ImageExportFeature.tsx`) calls `onExportPng(pngExportSettings)` (prop-drilled from `App.tsx` → `MazeScene.exportPng` → `PngExporter.export`) and, if it resolves to a non-null `Blob`, triggers a browser download via `downloadPngExport` (`pngExport.ts` — `Blob`→`ObjectURL`→temporary `<a download>`→click→revoke, mirroring `serialize.ts`'s `downloadProjectFile`). The gear icon next to the export button opens PNG's own `SettingsPanel` (`PngExportSettingsPanel.tsx`) in the same `SidePanel` slot a render mode's settings use. Opening it doesn't clear `openRenderModeSettings` (GitHub issue #629) — both panels may stay mounted at once, `SidePanel`'s mount-order stack decides which is shown (see "Switcher: one active mode, no default" above).

PNG export has two **output modes** (`PngExportSettings.outputMode`, `storeTypes.ts`), switched by two toggle buttons at the top of the panel — **digital** (an arbitrary canvas sized to fit the maze) and **print** (a fixed physical sheet size, the maze placed on it). Both modes' settings (`DigitalExportSettings`/`PrintExportSettings`) are independently persisted so switching modes never loses the other's configuration; `digital.scale`/`print.scale` are deliberately separate fields (both a multiplier of `TILE_SIZE`) rather than shared, so switching modes doesn't silently carry one over into the other.

### Content bounds — one source of truth

`contentWorldBounds(cfg, nodes, margin)` (`contentBounds.ts`) is the single function answering "how big is the maze, actually" for every PNG canvas-fit computation: the exact per-tessellation-vertex bounding box (`exactCellBounds`, not a uniform per-center pad) inset by a caller-supplied `ExportMargin` (`{ left, right, top, bottom }`, world-space). Two different margins are in play, both resolved from store state without needing a live Pixi renderer instance (`exportMargins.ts`):
- `resolveExportMargin(mode, state)` — the mode's full required margin (markers, one-way indicators, teleport connectors — anything that can visually extend past a cell's raw boundary). For "Vector by walls": `computeVectorByWallsExportMargin`, the `Math.max` of every world-space half-extent the mode can draw (wall half-thickness, one-way indicator extent, start/finish marker extent, teleport line/connector extent).
- `resolveWallExportMargin(mode, state)` — a narrower "just the wall stroke" margin (`computeVectorByWallsWallMargin`: `wallThickness / 2` alone), used wherever a canvas should hug the walls tightly instead of reserving room for markers/indicators a given maze may not even have (digital's `edge_to_edge`/`margin_px`/`margin_cells`, and *all* of print mode's placement math — see below).

Both are exposed as pure functions (not only reachable through a live `ModeRenderer` instance) specifically so `PngExportSettingsPanel`'s live preview (`useMemo`, re-evaluated on every settings change) never has to construct a Pixi renderer just to read a margin number. `ModeRenderer.getRequiredExportMargin()`/`getRequiredWallExportMargin()` are thin delegating wrappers over the same functions, used by `PngExporter`'s actual export pass — both call paths reach the same values by construction, never duplicating the margin formula.

### Digital mode (`computeDigitalExportFit`, `exportFit.ts`)

Pure function: `(cfg, nodes, margin, settings: DigitalExportSettings, wallMargin?) => ExportFit & { contentWidth, contentHeight, overflow }`. Four `canvasMode` branches:

| Mode | Canvas size | Margin used |
|------|-------------|-------------|
| `edge_to_edge` | bbox + `wallMargin` | `wallMargin` alone (hugs walls tightly) |
| `margin_px` | bbox + `wallMargin` + `marginValue` px on every side | `wallMargin` + user's own pixel margin (world-space `marginValue / scale`, so the *output* pixel margin is exactly `marginValue` regardless of scale) — `marginValue = 0` reproduces `edge_to_edge` exactly |
| `margin_cells` | bbox + `wallMargin` + `marginValue * TILE_SIZE` on every side | same idea, in cell units — scales with `scale` (unlike `margin_px`, which stays a fixed output pixel amount) |
| `fixed_size` | exactly `fixedWidth × fixedHeight` px | full `margin` (marker-inclusive — content is centered via `placeInBox`, and a marker must never get clipped by a coincidentally tight fixed canvas even if the maze happens to have no visible wall stroke there) |

`contentWidth`/`contentHeight` (the maze's own rendered size after scaling) are always returned alongside `width`/`height` (the canvas/file's own pixel size — only differs from content size in `fixed_size`) so the panel can compute a fill percentage. `overflow` is `true` only for `fixed_size`, when content doesn't fit the fixed canvas — export still proceeds; content outside `PngExporter`'s `RenderTexture` bounds is simply not drawn (hardware clip), not an error.

`worldX`/`worldY` (the canvas's own world-space top-left corner, distinct from `x`/`y` which are screen/canvas-pixel-space) exist solely for `ExportFrameOverlay`'s digital-mode frame — it lives in a viewport-synced container and needs the canvas rect in the same coordinate space the maze itself is drawn in.

`placeInBox(contentW, contentH, boxW, boxH, offsetX, offsetY, anchor: PrintAnchor)` (`exportFit.ts`) is the shared 9-anchor placement helper — used by digital's `fixed_size` (always `"center"`) and by print's page-margin placement (below, any of the 9 fixed anchors).

### Print mode (`computePrintExportFit`, `printFit.ts`)

A physical sheet (`PrintExportSettings.paperSize` — A0-A5, Letter/Legal/Tabloid, or `custom` with `customWidthMm`/`customHeightMm`, `PAPER_SIZES_MM` in `paperSizes.ts` — swapped for `orientation: "landscape"`) rasterized at one of four DPIs (`PrintDensity` → `DPI_BY_DENSITY`: screen 96, draft 150, print 300, high 600). The maze content (bbox inset by the **wall-only** margin — `resolveWallExportMargin`, never the marker-inclusive one; using the wider margin here would leave unwanted extra space around content that doesn't actually have those markers) is placed inside the sheet's margin-inset area (`marginHMm`/`marginVMm`, default 5mm each) per `settings.anchor` — one of 9 fixed positions via `placeInBox`, or `"custom"` (bypasses `placeInBox`; `offsetXMm`/`offsetYMm` are used directly, already margin-relative).

Unlike digital mode, the canvas is **always** the full sheet size — content is placed within it, never the other way around, and can end up not filling the sheet, or extending past its edges. Two informational (non-blocking) flags on `PrintFit`, both edge-rect checks against the placed content's actual rect (not just a size comparison, since an off-center anchor including `"custom"` can poke past one edge while still being small enough to "fit"):
- `clipsSheetBounds` — content's placed rect extends past the sheet's own edges (actually clipped/lost on export — outside `RenderTexture`'s bounds).
- `entersMarginZone` — content extends past the margin-inset rect (still fully on the sheet, but sitting in the reserved margin zone).

Both comparisons use a `0.01px` epsilon tolerance — floating-point placement math (`placeInBox`'s division, the auto-fit scale's own division) can land content a fraction of a pixel past an edge it's meant to touch exactly, which without the tolerance reads as a false-positive warning the instant a fit is exact rather than only once content actually overflows.

**Auto-fit scale** (`PrintExportSettings.scaleAutoFit` toggle, next to the scale field — the scale input is disabled while it's on): `computeAutoFitPrintScale(cfg, nodes, wallMargin, settings)` computes the scale that makes content (at `scale=1`) exactly fill the available (margin-inset) area on the limiting axis — a pure, one-shot calculation. `PngExportSettingsPanel`'s own `useEffect` re-runs it (floored to 2 decimals, `floor2` — always rounds *down*, since an up-rounded scale can push content a fraction of a percent past the available area, flagging a spurious `entersMarginZone` even though the true unrounded fit was exact) on every change that could affect the fit (sheet size/orientation/DPI, margins, or the maze itself), keeping `print.scale` continuously in lockstep while the toggle is on. When auto-fit is off, changing `density` rescales the stored `print.scale` by `newDpi / oldDpi`, so the displayed cell size in millimeters remains unchanged while only the raster resolution changes (GitHub issue #620).

### `ExportFrameOverlay` — on-canvas print frame, bidirectional pan/zoom sync

Print mode draws its sheet boundary directly on the editor canvas (`ExportFrameOverlay`, `imageExportFrameContainer` — deliberately **not** in `MazeScene.syncedLayers`, since the frame is fixed in screen space while the maze content underneath keeps panning/zooming with the normal viewport). A dimmed overlay covers everything outside the frame in both modes; the frame itself draws as a solid rect, in a color auto-picked by `contrastGray(backgroundColor)` (`colorTokens.ts`, luminance-based dark/light gray) against the active mode's own background (`resolveBackgroundColor`, `exportMargins.ts`) so it stays visible regardless of the mode's configured background color. Print mode additionally draws dashed lines marking the margin offsets inside the frame.

Digital mode's frame is stateless — recomputed every call from `computeDigitalExportFit`'s world-space rect through the live viewport transform, nothing to keep in sync. Print mode's frame is a **fixed screen rect** (`computeSheetScreenLayout` — fits the sheet's own aspect ratio into the current screen size with `VIEWPORT_FIT_PADDING` padding (90%, shared with every other "fit to screen" computation — `pixi/constants.ts`, GitHub issue #373 follow-up), centered), and syncs bidirectionally with the maze's pan/zoom:

- **Canvas → settings** (`onViewportChanged` → `syncPlacementToViewport`): panning/zooming the maze under the frame recomputes `print.scale`/`offsetXMm`/`offsetYMm` (`computePrintPlacementFromViewport`) and sets `anchor: "custom"` (`setPrintCustomPlacement`) — a real pan/zoom is the user manually positioning content, which also turns `scaleAutoFit` off first (otherwise the panel's own auto-fit `useEffect` would immediately overwrite the scale this sync just set). Guarded by `actuallyMoved` (the reported `x`/`y`/`scale` must genuinely differ from the last known viewport) so a resize-triggered echo — see below — never gets mistaken for real user pan/zoom and stomps a fixed anchor back to `"custom"`.
- **Settings → canvas** (`redraw()` → `syncViewportToPlacement`): typing a new scale, picking a fixed anchor, changing the sheet size, or switching into print mode moves the editor viewport (`computeViewportFromPrintPlacement`) so the canvas shows exactly that placement under the still-fixed frame.

Both directions are guarded by a re-entrant-safe `syncingDepth` counter (not a boolean — `syncViewportToPlacement`'s `setViewportTransform` call synchronously triggers `onViewportChanged` → `syncPlacementToViewport` before either returns, so a plain boolean's inner `finally` would clear the guard early and mutually recurse the two sync directions into a stack overflow). `redraw()` re-syncs the canvas placement (`becameActive` — print mode just became visible; `sheetSizeChanged` — the frame's own screen rect, `x`/`y`/`w`/`h`, changed, whether from a paper-size/orientation/DPI change *or* the available screen area changing e.g. a side panel opening; `placementChanged` — scale/offset/anchor changed) but skips it entirely while `syncing`.

`MazeScene.notifyScreenResized()` (triggered by an `App.tsx` `ResizeObserver` on the canvas DOM element — side panel opening/closing, card switching, DevTools toggling) forces `app.resize()` (Pixi's own `resizeTo` `ResizeObserver` on the same element races independently against the caller's, so `app.screen` can read one tick stale without this) then calls `ExportFrameOverlay.notifyExternalResize()`, which re-runs `redraw()` explicitly — a pure screen resize doesn't itself flow through the store subscription `redraw()` normally relies on, so without this the frame's `sheetSizeChanged` check would never re-fire and the canvas would stay fit against the *previous* (pre-resize) screen size.

### Physical-size (1:1) preview

The print settings panel's bottom section (below the fit warnings) offers a **"Physical size (1:1)"**
button that zooms the editor so one on-screen millimetre equals one printed millimetre — a way to
judge the real printed size of cells/labels/markers without a test print (GitHub issue #476).

**Calibration.** The browser exposes no real physical pixel density, and a CSS pixel is not a
device pixel (OS display scaling, browser zoom). So the user calibrates, and the app stores, the
*effective CSS pixels-per-inch* (`calibratedCssPpi`) under their current browser/OS configuration.
`ScreenDpiCalibrationModal` shows an on-screen bar `CALIBRATION_CARD_WIDTH_MM` (85.6 mm, ISO/IEC
7810 ID-1 — a single worldwide bank/ID-card standard) wide at the draft PPI; the user holds a card
against it and drags a slider (range `MIN_CSS_PPI`..`MAX_CSS_PPI` = 60..200, realistic once OS
scaling is folded in, slider reads out in CSS PPI) until the on-screen bar matches the card. This
is a property of the device/configuration, **not the project** — persisted to `localStorage` by
`screenCalibration.ts` (same imperative-store + `useSyncExternalStore` shape as
`i18n/localeStore.ts`, hook `useCalibratedCssPpi`), never written to a project file or the store.
The stored value is clamped to `[MIN_CSS_PPI, MAX_CSS_PPI]` on **both** write and read (a value
persisted by a different build, or hand-edited, can't reach the formula out of range). Before calibration `calibratedCssPpi` is `null` and the button opens
the calibration modal instead of zooming. Calibration is environment-dependent (monitor, screen
resolution, system/browser scaling) — the modal says so.

**Formula.** `computePhysicalOneToOneViewportScale(printScale, density, calibratedCssPpi)`
(`printFit.ts`) = `printScale * calibratedCssPpi / DPI_BY_DENSITY[density]`. Independent of
`TILE_SIZE` (both the on-paper and on-screen cell size are `TILE_SIZE * scale`, so it cancels).
`printScale` is the current `print.scale` (kept in lockstep with `computeAutoFitPrintScale` by the
panel's own effect while `scaleAutoFit` is on).

**It is a pure viewport command** — it does **not** touch `print.scale`/`anchor`/`offset` (the user
changed how they view the sheet, not the maze's placement on it). Wired through the second slot of
`viewportScaleBridge.ts` (`setPhysicalZoomApplier`/`applyPhysicalZoom` — the panel is reached
propless via `exportFormatRegistry`, same reason the "match current zoom" getter exists) →
`MazeScene.applyPrintPhysicalZoom` → `ExportFrameOverlay.applyViewportScaleAroundFrameCentre`, which
scales the viewport about the print frame's screen centre (standard zoom-around-point) and is
`syncingDepth`-guarded exactly like `syncViewportToPlacement` so `onViewportChanged` doesn't mistake
it for a real pan/zoom. It is a no-op when the print frame is not active (export panel closed) or
the target scale is non-positive. A genuine pan/zoom afterwards still flows through `syncPlacementToViewport`
and switches `anchor` to `"custom"` as usual. The 1:1 view holds until a real pan/zoom or any
`print`-setting/panel-size change (the latter re-fires `redraw()`'s `sheetSizeChanged`/
`placementChanged` re-sync back to the `print`-derived placement) — acceptable, since a DPI/paper/
margin change needs a fresh 1:1 recompute anyway.

### Result info & warning bubbles

Both output modes show a result-info block (image size in px for digital, sheet size in px + cell size in mm for print) below a divider, then any applicable warning bubbles below that. Digital's own overflow warning (`PngOverflowWarningBubble`, `png_content_overflows_canvas`) carries a fill-percentage parameter; print's two warnings (`PngFitWarningBubble`, `png_content_clips_sheet`/`png_content_in_margin_zone`) are plain yes/no facts with no parameter — both bubble components share one `WarningBubble` body (click opens a `Modal` with the resolved description, `exportWarningsI18n.ts`'s `resolvePng*WarningMessage`/`resolvePng*WarningDescription`), same look/interaction as the "Vector by walls" section's `ExportWarningBubble` but built inline in `PngExportSettingsPanel.tsx` from the fit result rather than through `computeVectorByWallsWarnings` — these are canvas-fit facts, not maze-geometry facts, so they don't carry `nodes`/`edges` to highlight.

### `PngExporter` — the actual render pass

`PngExporter.export(settings)` (`PngExporter.ts`) is not reentrant — a private `exportInProgress` flag makes a second concurrent call return `null` immediately (the UI also disables the export button while a call is in flight, but this flag is the source of truth) — `renderer.render`/`extract.canvas` are stateful GPU operations on the shared `Application.renderer`. Never touches the live on-screen scene: builds its own temporary `Container` and its own temporary mode-renderer instance (`createModeRenderer`, the same factory `ImageExportRenderer` uses), computes the fit (`computeDigitalExportFit` or `computePrintExportFit` depending on `outputMode` — print's result is reshaped into the same `{width, height, x, y, scale}` shape via `toDigitalShapedFit`, sheet size standing in for canvas size), positions the temporary container directly (`position.set`/`scale.set` — `onViewportChanged` alone only updates the mode-renderer's internal world-rect math for background/grid, it doesn't move anything), renders into an offscreen `RenderTexture` sized to the fit, extracts a canvas, converts to a `Blob` (`canvasToBlob` — `convertToBlob` where available, `toBlob` fallback), then tears the texture/renderer/container down in a `finally` regardless of outcome.

## Scene integration

`MazeScene` wires `ImageExportRenderer` the same way as every other feature-renderer: its own synced layer container, its own entry in `viewportListeners`, `image_export` added to `TESSELLATION_CONFIG_BY_CARD` (resolves to `activeTessellationConfig`, same as generation/post-edit/analytics) and to `refit()`'s `showsMaze` gate. `ExportFrameOverlay` is wired as the **last** `viewportListeners` entry (after `imageExportRenderer`) so the frame's own canvas-position sync always sees every other listener's up-to-date state first.
