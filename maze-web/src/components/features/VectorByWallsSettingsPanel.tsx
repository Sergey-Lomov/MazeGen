import React, { useEffect, useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { OneWayPattern } from "../../pixi/renderers/types";
import { inset, spacing, ui } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { maxSplitNodeCount } from "../../pixi/selectors/mazeSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { computeVectorByWallsWarnings } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { ExportWarningsSection } from "./ExportWarningsSection";
import { MarkerSettingsGroup } from "./MarkerSettingsGroup";
import { TeleportSettingsSection, useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";
import { SharedStyleSection, sharedStyleFieldReset } from "./SharedStyleSection";
import * as m from "~/paraglide/messages";

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
  const patchTeleportSettings = useMazeStore((s) => s.patchVectorByWallsTeleportSettings);
  const setTeleportGroupOverride = useMazeStore((s) => s.setVectorByWallsTeleportGroupOverride);
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const setSplitNodeColor = useMazeStore((s) => s.setVectorByWallsSplitNodeColor);
  const setSplitSpecialShapes = useMazeStore((s) => s.setVectorByWallsSplitSpecialShapes);
  const setSharedCornerStyle = useMazeStore((s) => s.setVectorByWallsSharedCornerStyle);
  const setSharedMarkerSize = useMazeStore((s) => s.setVectorByWallsSharedMarkerSize);
  const setSharedMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsSharedMarkerBorderWidth);
  const setSharedGapWidth = useMazeStore((s) => s.setVectorByWallsSharedGapWidth);
  const resetSharedStyleField = useMazeStore((s) => s.resetVectorByWallsSharedStyleField);
  const forceSharedStyle = useMazeStore((s) => s.forceVectorByWallsSharedStyle);
  const resetAllSettings = useMazeStore((s) => s.resetVectorByWallsSettings);

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
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);

  // Effective start/finish — `postEditMeta`'s confirmed endpoints once post-edit has confirmed,
  // else the as-generated `start`/`finish` (GitHub issue #303 — `confirmPostEdit` never updates
  // `state.start`/`state.finish`, only `postEditMeta` reflects a post-edit marker move).
  const { start, finish } = useMemo(
    () => resolveEffectiveEndpoints({ nodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [nodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  // Export-specific rendering caveats (GitHub issue #298) — maze-valid but this render mode can't
  // depict the case correctly (e.g. an invisible teleport marker). Distinct from the QC issue list
  // (Analytics feature) — see `exportWarnings.ts`'s doc comment.
  const exportWarnings = useMemo(
    () => computeVectorByWallsWarnings(nodes, edges, cfg, settings, start, finish),
    [nodes, edges, cfg, settings, start, finish],
  );

  const { teleportGroups, teleportCollisionKeys } = useTeleportGroupsAndCollisions(nodes, edges, cfg, settings);

  // Splits section (GitHub issue #294) — the panel only ever shows as many color slots as the
  // current maze actually needs (0 hides the section entirely, see below).
  const maxSplit = useMemo(() => maxSplitNodeCount(nodes), [nodes]);

  // One-ways/Teleports sections only make sense when the maze actually has that kind of edge —
  // mirrors the Splits section's own "hide when there's nothing to configure" rule.
  const hasOneWays = useMemo(() => {
    const basicEdges = edges.filter((e) => e.kind === "basic");
    const forward = new Set(basicEdges.map((e) => `${e.from}->${e.to}`));
    return basicEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  }, [edges]);
  const hasTeleports = useMemo(() => edges.some((e) => e.kind === "teleport"), [edges]);

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
        label={m["image_export.vector_by_walls.section_shared_style"]()}
        expanded={isExpanded("shared_style")}
        onToggle={() => toggleSection("shared_style")}
      />
      {isExpanded("shared_style") && (
        <SharedStyleSection
          cornerStyle={settings.sharedStyle.cornerStyle}
          markerSize={settings.sharedStyle.markerSize}
          markerBorderWidth={settings.sharedStyle.markerBorderWidth}
          gapWidth={settings.sharedStyle.gapWidth}
          onCornerStyleChange={setSharedCornerStyle}
          onMarkerSizeChange={setSharedMarkerSize}
          onMarkerBorderWidthChange={setSharedMarkerBorderWidth}
          onGapWidthChange={setSharedGapWidth}
          onForce={forceSharedStyle}
          onResetAll={resetAllSettings}
        />
      )}

      <div style={styles.divider} />

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
            resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "wallJoin", () => resetSharedStyleField("cornerStyle", "wallJoin"))}
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
            resetButtons={{
              cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "startMarker", () => resetSharedStyleField("cornerStyle", "startMarker")),
              size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "startMarker", () => resetSharedStyleField("markerSize", "startMarker")),
              borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "startMarker", () => resetSharedStyleField("markerBorderWidth", "startMarker")),
              gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "startMarker", () => resetSharedStyleField("gapWidth", "startMarker")),
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
            resetButtons={{
              cornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "finishMarker", () => resetSharedStyleField("cornerStyle", "finishMarker")),
              size: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "finishMarker", () => resetSharedStyleField("markerSize", "finishMarker")),
              borderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "finishMarker", () => resetSharedStyleField("markerBorderWidth", "finishMarker")),
              gapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "finishMarker", () => resetSharedStyleField("gapWidth", "finishMarker")),
            }}
          />
        </div>
      )}

      {hasOneWays && (
        <>
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
                resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "oneWayJoin", () => resetSharedStyleField("cornerStyle", "oneWayJoin"))}
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
        </>
      )}

      {hasTeleports && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={m["image_export.vector_by_walls.section_teleports"]()}
            expanded={isExpanded("teleports")}
            onToggle={() => toggleSection("teleports")}
          />
          {isExpanded("teleports") && (
            <TeleportSettingsSection
              settings={settings}
              onChange={patchTeleportSettings}
              groupOverrides={settings.teleportGroupOverrides}
              onGroupOverrideChange={setTeleportGroupOverride}
              teleportGroups={teleportGroups}
              teleportCollisionKeys={teleportCollisionKeys}
              resetButtons={{
                lineCornerStyle: sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "teleportLine", () => resetSharedStyleField("cornerStyle", "teleportLine")),
                lineSize: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerSize", "teleportLine", () => resetSharedStyleField("markerSize", "teleportLine")),
                edgeBorderWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "markerBorderWidth", "teleportEdge", () => resetSharedStyleField("markerBorderWidth", "teleportEdge")),
                edgeGapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "teleportEdge", () => resetSharedStyleField("gapWidth", "teleportEdge")),
                connectorGapWidth: sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "teleportConnector", () => resetSharedStyleField("gapWidth", "teleportConnector")),
              }}
            />
          )}
        </>
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

      <ExportWarningsSection
        warnings={exportWarnings}
        expanded={isExpanded("warnings")}
        onToggle={() => toggleSection("warnings")}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
