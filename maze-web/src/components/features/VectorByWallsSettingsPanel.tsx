import React, { useEffect, useMemo, useRef } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { MarkerSettings } from "../../store/storeTypes";
import type { MarkerShape, OneWayPattern, TeleportGroupOverride, TeleportConnectorStyle, TeleportArrowMode } from "../../pixi/renderers/types";
import { inset, spacing, ui, typography } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import { ColorSwatch } from "../ColorSwatch";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { buildTeleportEdges, maxSplitNodeCount } from "../../pixi/selectors/mazeSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { buildTeleportGroups, type TeleportGroup } from "../../pixi/selectors/teleportGroups";
import * as m from "~/paraglide/messages";

/** Shared shape option list (GitHub issue #293 follow-up unified `MarkerShape` for both start/
 *  finish waypoints and both teleport patterns) — used by `MarkerSettingsGroup` (waypoints) and
 *  both Teleports-section shape pickers. */
const MARKER_SHAPE_OPTIONS: { value: MarkerShape; label: () => string }[] = [
  { value: "circle", label: m["image_export.vector_by_walls.marker_shape_circle"] },
  { value: "triangle", label: m["image_export.vector_by_walls.marker_shape_triangle"] },
  { value: "square", label: m["image_export.vector_by_walls.marker_shape_square"] },
  { value: "diamond", label: m["image_export.vector_by_walls.marker_shape_diamond"] },
  { value: "pentagon", label: m["image_export.vector_by_walls.marker_shape_pentagon"] },
  { value: "star", label: m["image_export.vector_by_walls.marker_shape_star"] },
  { value: "hexagon", label: m["image_export.vector_by_walls.marker_shape_hexagon"] },
  { value: "cross", label: m["image_export.vector_by_walls.marker_shape_cross"] },
];

/** One row of the group customization list — clicking it selects the matching group (highlighting
 *  it, hiding every other group) on the canvas and vice versa (GitHub issue #293 follow-up:
 *  click-to-select, not hover — hover-driven selection flickered whenever the pointer crossed a gap
 *  between two groups' canvas hit areas). Clicking an already-selected row (or its matching canvas
 *  marker again, or `Escape`) clears the selection. Compact, unlabeled single-line layout (per the
 *  issue's own spec: index + warning slot on the left, shape dropdown + fill-color swatch +
 *  border-color swatch + reset icon flush right) — every control's meaning is a `title` tooltip
 *  instead of a visible label, since the row has no room for both. */
function TeleportGroupRow({
  group,
  index,
  override,
  defaultFillColor,
  defaultBorderColor,
  hasCollision,
  onChange,
}: {
  group: TeleportGroup;
  index: number;
  override: TeleportGroupOverride | undefined;
  defaultFillColor: number;
  defaultBorderColor: number;
  hasCollision: boolean;
  onChange: (patch: TeleportGroupOverride | null) => void;
}) {
  const selectedKey = useMazeStore((s) => s.selectedTeleportGroupKey);
  const setSelected = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const isSelected = selectedKey === group.key;
  const hasOverride = override !== undefined && Object.keys(override).length > 0;
  const rowRef = useRef<HTMLDivElement>(null);

  // Canvas -> row selection sync (selecting the group's marker on the canvas scrolls to and
  // highlights its row): a `data-selected` attribute + CSS selector, mirroring the hover-era
  // decoupling of the row's own visual state from the interaction that triggered it — keeps this
  // component correct regardless of which side (row click or canvas click) drove the change.
  const wasSelected = useRef(false);
  useEffect(() => {
    if (isSelected && !wasSelected.current) {
      rowRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
    wasSelected.current = isSelected;
  }, [isSelected]);

  return (
    <div
      ref={rowRef}
      className="teleport-group-row"
      data-selected={isSelected ? "true" : undefined}
      style={styles.groupRow}
      onClick={() => setSelected(isSelected ? null : group.key)}
    >
      <span style={typography.body}>{index + 1}</span>
      <span style={styles.warningIcon} title={hasCollision ? m["image_export.vector_by_walls.teleport_group_collision"]() : undefined}>
        {hasCollision && <AlertTriangle size={13} color={ui.text.warning} />}
      </span>
      <span style={styles.groupRowSpacer} />
      <select
        title={m["image_export.vector_by_walls.teleport_group_override_shape"]()}
        style={sharedStyles.selectSm}
        value={override?.shape ?? "__default__"}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange({ ...override, shape: e.target.value === "__default__" ? undefined : (e.target.value as MarkerShape) })}
      >
        <option value="__default__">{m["image_export.vector_by_walls.teleport_group_override_shape_default"]()}</option>
        {MARKER_SHAPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label()}</option>
        ))}
      </select>
      <span title={m["image_export.vector_by_walls.teleport_group_override_color"]()} onClick={(e) => e.stopPropagation()}>
        <ColorSwatch color={override?.fillColor ?? defaultFillColor} onChange={(fillColor) => onChange({ ...override, fillColor })} />
      </span>
      <span title={m["image_export.vector_by_walls.teleport_group_override_border_color"]()} onClick={(e) => e.stopPropagation()}>
        <ColorSwatch color={override?.borderColor ?? defaultBorderColor} onChange={(borderColor) => onChange({ ...override, borderColor })} />
      </span>
      <button
        type="button"
        className="hoverable"
        title={m["image_export.vector_by_walls.teleport_group_reset"]()}
        style={styles.resetButton}
        disabled={!hasOverride}
        onClick={(e) => { e.stopPropagation(); onChange(null); e.currentTarget.blur(); }}
      >
        <RotateCcw size={14} color={ui.text.tertiary} opacity={hasOverride ? 1 : 0.4} />
      </button>
    </div>
  );
}

/** One "Start"/"Finish" sub-group of the markers section — plain-weight label (not a
 *  `SectionHeader`, always visible, no collapse) indented under the section header, per GitHub
 *  issue #296. Shape, corner style, size, fill color, border color, border width and gap width
 *  (GitHub issue #302 follow-up added corner style/size/gap width, in that row order); `borderWidth:
 *  0` draws no border and `gapWidth: 0` draws no gap, so there is no separate show-border/show-gap
 *  toggle for either. */
function MarkerSettingsGroup({ title, settings, onChange }: {
  title: string;
  settings: MarkerSettings;
  onChange: (patch: Partial<MarkerSettings>) => void;
}) {
  return (
    <div style={styles.markerGroupWrap}>
      <div style={typography.body}>{title}</div>
      <div style={styles.markerGroup}>
        <SelectRow
          label={m["image_export.vector_by_walls.marker_shape"]()}
          value={settings.shape}
          options={MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
          onChange={(shape) => onChange({ shape })}
        />
        <SelectRow
          label={m["image_export.vector_by_walls.marker_corner_style"]()}
          value={settings.cornerStyle}
          options={[
            { value: "sharp", label: m["image_export.vector_by_walls.teleport_corner_style_sharp"]() },
            { value: "round", label: m["image_export.vector_by_walls.teleport_corner_style_round"]() },
          ]}
          onChange={(cornerStyle) => onChange({ cornerStyle })}
        />
        <SliderRow
          label={m["image_export.vector_by_walls.marker_size"]()}
          value={settings.size}
          onChange={(size) => onChange({ size })}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
        />
        <ColorRow label={m["image_export.vector_by_walls.marker_fill_color"]()} color={settings.fillColor} onChange={(fillColor) => onChange({ fillColor })} />
        <ColorRow label={m["image_export.vector_by_walls.marker_border_color"]()} color={settings.borderColor} onChange={(borderColor) => onChange({ borderColor })} />
        <SliderRow
          label={m["image_export.vector_by_walls.marker_border_width"]()}
          value={settings.borderWidth}
          onChange={(borderWidth) => onChange({ borderWidth })}
          min={0}
          max={10}
          step={1}
          format={(v) => String(v)}
        />
        <SliderRow
          label={m["image_export.vector_by_walls.marker_gap_width"]()}
          value={settings.gapWidth}
          onChange={(gapWidth) => onChange({ gapWidth })}
          min={0}
          max={10}
          step={1}
          format={(v) => String(v)}
        />
      </div>
    </div>
  );
}

/** "Background", "Tiles", "Markers" and "One-ways" sections of the "Vector by walls" render mode's
 * settings panel (GitHub issue #289 for background, #290/#291 for floor/wall settings — folded
 * into one "Tiles" section since both draw on the maze's cells/tiles, unlike background/grid which
 * draw on the viewport — #296 for start/finish markers — #292 for one-ways — all part of #288's
 * epic). Background covers background color, grid visibility, grid color. Tiles covers the floor's
 * fill color, wall color, corners & ends (round/miter join, paired with a round/square cap) and
 * wall thickness — wall settings applied via `WallStyleOverride` to solid walls, split-junction
 * wall faces and closed-cells fill only (see `renderers/types.ts`), never the faint/background wall
 * styles or split-passage node-identity colors. Markers covers the start/finish marker's shape,
 * fill color, border color and border width, as two plain-label sub-groups ("Start"/"Finish")
 * within the one collapsible section — not two separate `SectionHeader`s, since they're too small
 * to warrant independent collapse. One-ways (placed after Markers, not before, matching the issue's
 * own section order) covers the one-way indicator's pattern (triangle/chevron/arrow —
 * `OneWayStyleOverride`, applied to `WallRenderer`'s plain wall one-ways only, never a split
 * passage's own connector arrow), its own color (always set, no fallback toggle), a border whose
 * color always mirrors the Tiles section's floor color (only its width is settable — `0` draws no
 * border), corners & ends (round/miter join, independent of the Tiles section's own wall join),
 * indicator size (as a fraction of the tile size, geometric scale) and thickness (chevron/arrow's
 * own line width in pixels, independent of size — no effect on the triangle pattern, a filled
 * shape with no line stroke of its own). Defaults are set in `imageExportSlice.ts` to
 * match the editor's normal grid/floor/wall/marker appearance exactly (except the one-way color,
 * which uses a brighter standalone default — GitHub issue #292). Section layout (row gap, divider
 * between sections) mirrors `AnalyticsFeature`'s collapsible sections. */
export function VectorByWallsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const setBackground = useMazeStore((s) => s.setVectorByWallsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByWallsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByWallsGridColor);
  const setFloorColor = useMazeStore((s) => s.setVectorByWallsFloorColor);
  const setWallColor = useMazeStore((s) => s.setVectorByWallsWallColor);
  const setWallJoin = useMazeStore((s) => s.setVectorByWallsWallJoin);
  const setWallThickness = useMazeStore((s) => s.setVectorByWallsWallThickness);
  const setOneWayPattern = useMazeStore((s) => s.setVectorByWallsOneWayPattern);
  const setOneWayColor = useMazeStore((s) => s.setVectorByWallsOneWayColor);
  const setOneWayGapWidth = useMazeStore((s) => s.setVectorByWallsOneWayGapWidth);
  const setOneWaySize = useMazeStore((s) => s.setVectorByWallsOneWaySize);
  const setOneWayThickness = useMazeStore((s) => s.setVectorByWallsOneWayThickness);
  const setOneWayJoin = useMazeStore((s) => s.setVectorByWallsOneWayJoin);
  const setStartMarkerShape = useMazeStore((s) => s.setVectorByWallsStartMarkerShape);
  const setStartMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsStartMarkerCornerStyle);
  const setStartMarkerFillColor = useMazeStore((s) => s.setVectorByWallsStartMarkerFillColor);
  const setStartMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderColor);
  const setStartMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderWidth);
  const setStartMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerGapWidth);
  const setStartMarkerSize = useMazeStore((s) => s.setVectorByWallsStartMarkerSize);
  const setFinishMarkerShape = useMazeStore((s) => s.setVectorByWallsFinishMarkerShape);
  const setFinishMarkerCornerStyle = useMazeStore((s) => s.setVectorByWallsFinishMarkerCornerStyle);
  const setFinishMarkerFillColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerFillColor);
  const setFinishMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderColor);
  const setFinishMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderWidth);
  const setFinishMarkerGapWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerGapWidth);
  const setFinishMarkerSize = useMazeStore((s) => s.setVectorByWallsFinishMarkerSize);
  const setTeleportLineCornerStyle = useMazeStore((s) => s.setVectorByWallsTeleportLineCornerStyle);
  const setTeleportLineShape = useMazeStore((s) => s.setVectorByWallsTeleportLineShape);
  const setTeleportLineSize = useMazeStore((s) => s.setVectorByWallsTeleportLineSize);
  const setTeleportEdgeColor = useMazeStore((s) => s.setVectorByWallsTeleportEdgeColor);
  const setTeleportEdgeBorderColor = useMazeStore((s) => s.setVectorByWallsTeleportEdgeBorderColor);
  const setTeleportEdgeBorderWidth = useMazeStore((s) => s.setVectorByWallsTeleportEdgeBorderWidth);
  const setTeleportEdgeGapWidth = useMazeStore((s) => s.setVectorByWallsTeleportEdgeGapWidth);
  const setTeleportConnectorColor = useMazeStore((s) => s.setVectorByWallsTeleportConnectorColor);
  const setTeleportConnectorWidth = useMazeStore((s) => s.setVectorByWallsTeleportConnectorWidth);
  const setTeleportConnectorStyle = useMazeStore((s) => s.setVectorByWallsTeleportConnectorStyle);
  const setTeleportAvoidFieldExit = useMazeStore((s) => s.setVectorByWallsTeleportAvoidFieldExit);
  const setTeleportArrowMode = useMazeStore((s) => s.setVectorByWallsTeleportArrowMode);
  const setTeleportArrowPeriod = useMazeStore((s) => s.setVectorByWallsTeleportArrowPeriod);
  const setTeleportArrowSize = useMazeStore((s) => s.setVectorByWallsTeleportArrowSize);
  const setTeleportConnectorGapWidth = useMazeStore((s) => s.setVectorByWallsTeleportConnectorGapWidth);
  const setTeleportGroupCustomization = useMazeStore((s) => s.setVectorByWallsTeleportGroupCustomization);
  const setTeleportGroupOverride = useMazeStore((s) => s.setVectorByWallsTeleportGroupOverride);
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const setSplitNodeColor = useMazeStore((s) => s.setVectorByWallsSplitNodeColor);
  const setSplitSpecialShapes = useMazeStore((s) => s.setVectorByWallsSplitSpecialShapes);

  // `Escape` clears a click-selected teleport group (GitHub issue #293 follow-up) — global, not
  // scoped to a focused row, so it works regardless of what has focus (including the canvas itself,
  // which has no keyboard listener of its own for this).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedTeleportGroupKey(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSelectedTeleportGroupKey]);

  const nodes = useMazeStore((s) => s.nodes);
  const edges = useMazeStore((s) => s.edges);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const teleportGroups = useMemo(() => {
    if (!settings.teleportGroupCustomization) return [];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, edges, cfg);
    return buildTeleportGroups(teleportEdges);
  }, [settings.teleportGroupCustomization, nodes, edges, cfg]);

  // Collision warnings only matter when there's no connector line to visually tell groups apart —
  // with a connector drawn, two groups sharing a color/shape are still distinguishable by which
  // links connect to what, so flagging them would just be noise.
  const teleportCollisionKeys = useMemo(() => {
    if (settings.teleportConnectorStyle !== "none") return new Set<string>();
    const resolved = teleportGroups.map((g) => {
      const o = settings.teleportGroupOverrides[g.key];
      return `${o?.fillColor ?? settings.teleportEdgeColor}:${o?.borderColor ?? settings.teleportEdgeBorderColor}:${o?.shape ?? settings.teleportLineShape}`;
    });
    const counts = new Map<string, number>();
    for (const r of resolved) counts.set(r, (counts.get(r) ?? 0) + 1);
    const collisions = new Set<string>();
    teleportGroups.forEach((g, i) => {
      if ((counts.get(resolved[i]) ?? 0) > 1) collisions.add(g.key);
    });
    return collisions;
  }, [teleportGroups, settings.teleportConnectorStyle, settings.teleportGroupOverrides, settings.teleportEdgeColor, settings.teleportEdgeBorderColor, settings.teleportLineShape]);

  // Splits section (GitHub issue #294) — the panel only ever shows as many color slots as the
  // current maze actually needs (0 hides the section entirely, see below).
  const maxSplit = useMemo(() => maxSplitNodeCount(nodes), [nodes]);

  const sectionsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  // Collapsing the Teleports section stops rendering the group list (and switches the canvas back
  // to non-interactive), so a selection made while it was open would otherwise dangle: nothing on
  // screen shows it's still set, but it'd still hide every other group on the canvas and pop back
  // into view already-selected the next time the section reopens. Cleared synchronously in the
  // toggle handler itself, not via a `useEffect` watching the expanded flag — an effect fires after
  // the closed render has already committed, one frame late; a plain click here fires before any of
  // that, same as toggling group customization off below.
  const toggleSection = (id: string) => {
    if (id === "teleports" && isExpanded(id)) setSelectedTeleportGroupKey(null);
    setSectionExpanded(id, !isExpanded(id));
  };

  return (
    <div style={styles.root}>
      <SectionHeader
        label={m["image_export.vector_by_walls.section_background"]()}
        expanded={isExpanded("background")}
        onToggle={() => toggleSection("background")}
      />
      {isExpanded("background") && (
        <div style={styles.block}>
          <ColorRow label={m["image_export.vector_by_walls.background_color"]()} color={settings.background} onChange={setBackground} />
          <ToggleRow label={m["image_export.vector_by_walls.show_grid"]()} checked={settings.showGrid} onChange={setShowGrid} />
          <ColorRow
            label={m["image_export.vector_by_walls.grid_color"]()}
            color={settings.gridColor}
            onChange={setGridColor}
            disabled={!settings.showGrid}
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_tiles"]()}
        expanded={isExpanded("tiles")}
        onToggle={() => toggleSection("tiles")}
      />
      {isExpanded("tiles") && (
        <div style={styles.block}>
          <ColorRow label={m["image_export.vector_by_walls.floor_color"]()} color={settings.floorColor} onChange={setFloorColor} />
          <ColorRow label={m["image_export.vector_by_walls.wall_color"]()} color={settings.wallColor} onChange={setWallColor} />
          <SelectRow
            label={m["image_export.vector_by_walls.wall_join"]()}
            value={settings.wallJoin}
            options={[
              { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
              { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
            ]}
            onChange={setWallJoin}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.wall_thickness"]()}
            value={settings.wallThickness}
            onChange={setWallThickness}
            min={1}
            max={20}
            step={1}
            format={(v) => String(v)}
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_markers"]()}
        expanded={isExpanded("markers")}
        onToggle={() => toggleSection("markers")}
      />
      {isExpanded("markers") && (
        <div style={styles.block}>
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_start"]()}
            settings={settings.startMarker}
            onChange={(patch) => {
              if (patch.shape !== undefined) setStartMarkerShape(patch.shape);
              if (patch.cornerStyle !== undefined) setStartMarkerCornerStyle(patch.cornerStyle);
              if (patch.fillColor !== undefined) setStartMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setStartMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setStartMarkerBorderWidth(patch.borderWidth);
              if (patch.gapWidth !== undefined) setStartMarkerGapWidth(patch.gapWidth);
              if (patch.size !== undefined) setStartMarkerSize(patch.size);
            }}
          />
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_finish"]()}
            settings={settings.finishMarker}
            onChange={(patch) => {
              if (patch.shape !== undefined) setFinishMarkerShape(patch.shape);
              if (patch.cornerStyle !== undefined) setFinishMarkerCornerStyle(patch.cornerStyle);
              if (patch.fillColor !== undefined) setFinishMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setFinishMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setFinishMarkerBorderWidth(patch.borderWidth);
              if (patch.gapWidth !== undefined) setFinishMarkerGapWidth(patch.gapWidth);
              if (patch.size !== undefined) setFinishMarkerSize(patch.size);
            }}
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_one_ways"]()}
        expanded={isExpanded("one_ways")}
        onToggle={() => toggleSection("one_ways")}
      />
      {isExpanded("one_ways") && (
        <div style={styles.block}>
          <SelectRow
            label={m["image_export.vector_by_walls.one_way_pattern"]()}
            value={settings.oneWayPattern}
            options={[
              { value: "triangle" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_triangle"]() },
              { value: "chevron" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_chevron"]() },
              { value: "arrow" as OneWayPattern, label: m["image_export.vector_by_walls.one_way_pattern_arrow"]() },
            ]}
            onChange={setOneWayPattern}
          />
          <ColorRow label={m["image_export.vector_by_walls.one_way_color"]()} color={settings.oneWayColor} onChange={setOneWayColor} />
          <SliderRow
            label={m["image_export.vector_by_walls.one_way_gap_width"]()}
            value={settings.oneWayGapWidth}
            onChange={setOneWayGapWidth}
            min={0}
            max={10}
            step={1}
            format={(v) => String(v)}
          />
          <SelectRow
            label={m["image_export.vector_by_walls.one_way_join"]()}
            value={settings.oneWayJoin}
            options={[
              { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
              { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
            ]}
            onChange={setOneWayJoin}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.one_way_size"]()}
            value={settings.oneWaySize}
            onChange={setOneWaySize}
            min={0.05}
            max={0.5}
            step={0.01}
            format={(v) => v.toFixed(2)}
          />
          <SliderRow
            label={m["image_export.vector_by_walls.one_way_thickness"]()}
            value={settings.oneWayThickness}
            onChange={setOneWayThickness}
            min={1}
            max={10}
            step={1}
            format={(v) => String(v)}
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_teleports"]()}
        expanded={isExpanded("teleports")}
        onToggle={() => toggleSection("teleports")}
      />
      {isExpanded("teleports") && (
        <div style={styles.block}>
          <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_edges"]()}</div>
          <div style={styles.subsection}>
            <SelectRow
              label={m["image_export.vector_by_walls.teleport_corner_style"]()}
              value={settings.teleportLineCornerStyle}
              options={[
                { value: "sharp", label: m["image_export.vector_by_walls.teleport_corner_style_sharp"]() },
                { value: "round", label: m["image_export.vector_by_walls.teleport_corner_style_round"]() },
              ]}
              onChange={setTeleportLineCornerStyle}
            />
            <SelectRow
              label={m["image_export.vector_by_walls.teleport_shape"]()}
              value={settings.teleportLineShape}
              options={MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
              onChange={setTeleportLineShape}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.teleport_size"]()}
              value={settings.teleportLineSize}
              onChange={setTeleportLineSize}
              min={0}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
            />
            <ColorRow label={m["image_export.vector_by_walls.teleport_edge_color"]()} color={settings.teleportEdgeColor} onChange={setTeleportEdgeColor} />
            <ColorRow label={m["image_export.vector_by_walls.teleport_edge_border_color"]()} color={settings.teleportEdgeBorderColor} onChange={setTeleportEdgeBorderColor} />
            <SliderRow
              label={m["image_export.vector_by_walls.teleport_border_width"]()}
              value={settings.teleportEdgeBorderWidth}
              onChange={setTeleportEdgeBorderWidth}
              min={0}
              max={10}
              step={1}
              format={(v) => String(v)}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.teleport_edge_gap_width"]()}
              value={settings.teleportEdgeGapWidth}
              onChange={setTeleportEdgeGapWidth}
              min={0}
              max={10}
              step={1}
              format={(v) => String(v)}
            />
          </div>

          <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector"]()}</div>
          <div style={styles.subsection}>
            <SelectRow
              label={m["image_export.vector_by_walls.teleport_connector_style"]()}
              value={settings.teleportConnectorStyle}
              options={[
                { value: "none" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_none"]() },
                { value: "straight" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_straight"]() },
                { value: "orthogonal" as TeleportConnectorStyle, label: m["image_export.vector_by_walls.teleport_connector_style_orthogonal"]() },
              ]}
              onChange={setTeleportConnectorStyle}
            />
            {settings.teleportConnectorStyle === "orthogonal" && (
              <ToggleRow
                label={m["image_export.vector_by_walls.teleport_avoid_field_exit"]()}
                checked={settings.teleportAvoidFieldExit}
                onChange={setTeleportAvoidFieldExit}
              />
            )}

            <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_body"]()}</div>
            <div style={styles.subsectionNested}>
              <ColorRow label={m["image_export.vector_by_walls.teleport_connector_color"]()} color={settings.teleportConnectorColor} onChange={setTeleportConnectorColor} />
              <SliderRow
                label={m["image_export.vector_by_walls.teleport_connector_width"]()}
                value={settings.teleportConnectorWidth}
                onChange={setTeleportConnectorWidth}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.teleport_connector_gap_width"]()}
                value={settings.teleportConnectorGapWidth}
                onChange={setTeleportConnectorGapWidth}
                min={0}
                max={10}
                step={1}
                format={(v) => String(v)}
              />
            </div>

            <div style={styles.subsectionLabel}>{m["image_export.vector_by_walls.teleport_subsection_connector_arrow"]()}</div>
            <div style={styles.subsectionNested}>
              <SelectRow
                label={m["image_export.vector_by_walls.teleport_arrow_mode"]()}
                value={settings.teleportArrowMode}
                options={[
                  { value: "none" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_none"]() },
                  { value: "center" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_center"]() },
                  { value: "double" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_double"]() },
                  { value: "periodic" as TeleportArrowMode, label: m["image_export.vector_by_walls.teleport_arrow_mode_periodic"]() },
                ]}
                onChange={setTeleportArrowMode}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.teleport_arrow_period"]()}
                value={settings.teleportArrowPeriod}
                onChange={setTeleportArrowPeriod}
                min={1}
                max={20}
                step={1}
                format={(v) => String(v)}
                disabled={settings.teleportArrowMode !== "periodic"}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.teleport_arrow_size"]()}
                value={settings.teleportArrowSize}
                onChange={setTeleportArrowSize}
                min={1}
                max={20}
                step={1}
                format={(v) => String(v)}
                disabled={settings.teleportArrowMode === "none"}
              />
            </div>
          </div>

          <ToggleRow
            label={m["image_export.vector_by_walls.teleport_group_customization"]()}
            checked={settings.teleportGroupCustomization}
            onChange={(checked) => {
              setSelectedTeleportGroupKey(null);
              setTeleportGroupCustomization(checked);
            }}
          />
          {settings.teleportGroupCustomization && teleportGroups.length > 0 && (
            <div style={styles.groupList}>
              {teleportGroups.map((group, i) => (
                <TeleportGroupRow
                  key={group.key}
                  group={group}
                  index={i}
                  override={settings.teleportGroupOverrides[group.key]}
                  defaultFillColor={settings.teleportEdgeColor}
                  defaultBorderColor={settings.teleportEdgeBorderColor}
                  hasCollision={teleportCollisionKeys.has(group.key)}
                  onChange={(patch) => setTeleportGroupOverride(group.key, patch)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {maxSplit > 0 && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_splits"]()}
            expanded={isExpanded("splits")}
            onToggle={() => toggleSection("splits")}
          />
          {isExpanded("splits") && (
            <div style={styles.block}>
              {Array.from({ length: maxSplit }, (_, i) => (
                <ColorRow
                  key={i}
                  label={m["image_export.vector_by_walls.split_node_color"]({ index: String(i + 1) })}
                  color={settings.splitNodeColors[i] ?? splitSlotColor(i, canvas.node.splitSlots)}
                  onChange={(color) => setSplitNodeColor(i, color)}
                />
              ))}
              <ToggleRow
                label={m["image_export.vector_by_walls.split_special_shapes"]()}
                checked={settings.splitSpecialShapes}
                onChange={setSplitSpecialShapes}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  markerGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  markerGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
  subsectionLabel: { ...typography.body },
  subsection: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
  subsectionNested: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
  groupList: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: spacing.sectionGap },
  groupRow: {
    display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.itemGap, outline: "none",
    padding: spacing.itemGap, borderRadius: 3, border: `1px solid ${ui.border.default}`,
  },
  groupRowSpacer: { flex: 1 },
  warningIcon: { display: "inline-flex", alignItems: "center", cursor: "default", width: 13 },
  resetButton: {
    ...typography.caption, color: ui.text.tertiary, display: "inline-flex", alignItems: "center",
    background: "none", border: "none", outline: "none", cursor: "default", padding: 0,
  },
};
