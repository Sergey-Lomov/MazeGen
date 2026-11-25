# Coordinate warnings

A coordinate warning is any warning that points at concrete cells. It declares only:

- `targets: PresetEndpoint[]` — cell `point`, optional split `slotId`, optional floor `level` (undefined = floor 0). A target may lie outside the field.
- `groups?: { targets; outset }[]` — how the warning draws its targets, chosen by each warning: targets in a group merge into one contour per group (`outset` draws it around the cells, the split style); targets in no group are single cells.
- `severity: NotificationSeverity` (`info` | `warning` | `critical`) — the existing notification severity, not a new type; its definition lives in `domain/notificationSeverity.ts` (`components/EmbeddedNotification.tsx` re-exports it) so `domain/` does not import UI code.
- `floorTargets?: PresetEndpoint[]` — cells that only add their floors to the floor badges, without being highlighted (the ends of connections the warning frames by other means).

Everything else is derived by the shared code (`domain/coordinateWarning.ts`, `components/CoordinateWarningBubble.tsx`, `components/useCoordinateWarningHover.ts`, `pixi/CoordinateWarningHighlight.ts`, `store/slices/coordinateWarningSlice.ts`):

- **Floor badges**: one `L{n}` per distinct floor of the targets (`coordinateWarningLevels`), colored by severity.
- **Bubble colors**: coordinate bubbles use the variant of the severity (`coordinateBubbleVariant`: info → neutral, warning → warning, critical → danger).
- **Hover**: hovering the warning sets `hoveredCoordinateWarning` to all its targets; hovering one coordinate bubble narrows it to that target; leaving (or unmounting while hovered) clears it.
- **Canvas highlight**: `CoordinateWarningHighlight` is the shared drawing code; it is not a scene layer. Each feature-renderer owns an instance of its own in its own layers and passes `isActive` (its card is open): `PresetConnectionsRenderer` (`preset_connections`), `AnalyticsRenderer` (`analytics`), `PostEditRenderer` (`post_edit`, which lists the same issues) and both export mode renderers (`image_export`, inside their warning highlight container, so the highlight follows the renderer's visibility). A warning is highlighted only in the panel that shows it. It fills every target on the active floor with `canvas.coordinateWarning[severity]`, by `groups` as merged inset or outset contours, and every other target as a single cell. A hovered single coordinate bubble always draws one cell. Targets of other floors are not drawn; their floor badge is the pointer.

## Migrated warnings

- Preset Connections: isolated nodes, orphan split nodes, invalid presets (severity `warning`; targets are the points outside the field (split points as one outset contour); connections not touching a split point that lead out of the field are not cell targets: hovering the warning (or "Clear invalid") also sets `presetHoveredLink` (with `more`, in the warning color, active floor only) so each is framed like any hovered connection, the one-way frame for one-ways and the boundary frame otherwise, and their floors are listed through `floorTargets` (badges only)); the preset list's invalid coordinate bubbles.
- Analytics `IssueBubble`: every issue whose highlight resolves to cells (regions, split tiles, teleport/vertical/elevator endpoints, dead ends, shape violators, ...), with the severity of the issue. Each region group is one merged contour; split tiles (`isSplit`) are drawn outward; an endpoint cell or dead end is a one-cell group.
- Zones card (#1034): one warning listing the manual zones with cells outside the field (severity `warning`; targets are those cells, which may lie outside the field, drawn merged into one contour group; hovering a zone chip lights only that zone's cells), the "Remove cells outside the field" button highlights all of them; `ZonesRenderer` owns the highlight.
- Export warnings: the `nodes` and `cells` of an `ExportWarning` (severity `warning`); split warnings (id contains `split`) merge their tiles into one outward contour, others draw single cells.

## Not coordinate warnings

Warnings without cell targets do not use the shared layer, but share its color: edge/loop issues (`hoveredIssueLoopEdges`, drawn by `IssueHighlightOverlay` in `canvas.coordinateWarning[severity]`, severity carried by `IssueHighlightEdge`), export warnings' `edges` (one-way boundary), `floorPolygons`, `polygons` and `bands` (`canvas.coordinateWarning.warning`), which the export renderers and `TopologyWarningHighlight` still draw (`hoveredExportWarningKey`, see `Specs/export-warnings.md`). An export warning hover sets both `hoveredExportWarningKey` and `hoveredCoordinateWarning`.
