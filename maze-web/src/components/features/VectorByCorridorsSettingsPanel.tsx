import type React from "react";
import { useEffect, useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { inset, spacing, ui } from "../../styles/theme";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { MarkerSettingsGroup } from "./MarkerSettingsGroup";
import { TeleportSettingsSection, useTeleportGroupsAndCollisions } from "./TeleportSettingsSection";
import { SharedStyleSection, sharedStyleFieldReset } from "./SharedStyleSection";
import { computeVectorByCorridorsWarnings } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { ExportWarningsSection } from "./ExportWarningsSection";
import { maxSplitNodeCount } from "../../pixi/selectors/mazeSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { TILE_SIZE } from "../../pixi/constants";
import * as m from "~/paraglide/messages";

/** "Vector by corridors" mode's own settings panel (GitHub issue #310) — a collapsible "Background"
 * section (GitHub issue #309) reusing `VectorByWallsSettingsPanel`'s own section, same field set
 * (background color, grid visibility, grid color) and same `i18n` message keys (no corridors-specific
 * wording needed, mirrors the "Waypoints" section's own key-reuse convention below), placed first —
 * same position as in `VectorByWallsSettingsPanel`. A collapsible "Cells"
 * section (mirrors `VectorByWallsSettingsPanel`'s own "Tiles" section naming/collapse convention,
 * `vectorByCorridorsSectionsExpanded` keyed the same way) covering the corridor stroke's color,
 * corners & ends (round/miter join, paired with a round/square cap, same convention as
 * `VectorByWallsSettingsPanel`'s wall join setting), thickness (1 to `TILE_SIZE` — a corridor
 * wider than a whole cell has no meaningful upper bound of its own, so the cap tracks the cell size
 * rather than a fixed pixel constant, unlike `VectorByWallsSettings.wallThickness`'s fixed 1-20
 * range) and the widen-patch padding/shape (`markerWidenPadding`/`markerWidenShape`, GitHub issue
 * #313 follow-up moved these here from the Waypoints section — they widen the corridor under every
 * marker kind on this canvas, waypoint and teleport alike, so they're a corridor-line concern, not
 * a waypoint-only one; one shared pair of settings, not a separate one per marker kind). One-ways
 * section (GitHub issue #312) reuses `VectorByWallsSettingsPanel`'s own section title/placement
 * (before Teleports, hidden unless `hasOneWays`), but its own field set — the corridor reading has
 * no wall segment to draw an indicator on, so it's a chevron row breaking the corridor line
 * (`drawOneWayChevronRow`) rather than `VectorByWallsSettings.oneWayPattern`'s single indicator.
 * Teleports section (GitHub issue #313) mirrors `VectorByWallsSettingsPanel`'s own section — same
 * `TeleportSettingsSection`, only the underlying store setters differ (`patch*`), same reuse
 * convention as the Waypoints section's `MarkerSettingsGroup`. Bottom warnings section mirrors
 * `VectorByWallsSettingsPanel`'s own layout so both panels stay visually consistent. */
export function VectorByCorridorsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByCorridorsSettings);
  const setBackground = useMazeStore((s) => s.setVectorByCorridorsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByCorridorsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByCorridorsGridColor);
  const setColor = useMazeStore((s) => s.setVectorByCorridorsColor);
  const setJoin = useMazeStore((s) => s.setVectorByCorridorsJoin);
  const setThickness = useMazeStore((s) => s.setVectorByCorridorsThickness);

  const setStartMarkerShape = useMazeStore((s) => s.setVectorByCorridorsStartMarkerShape);
  const setStartMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsStartMarkerCornerStyle);
  const setStartMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsStartMarkerFillColor);
  const setStartMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsStartMarkerBorderColor);
  const setStartMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsStartMarkerBorderWidth);
  const setStartMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsStartMarkerGapWidth);
  const setStartMarkerSize = useMazeStore((s) => s.setVectorByCorridorsStartMarkerSize);
  const setFinishMarkerShape = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerShape);
  const setFinishMarkerCornerStyle = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerCornerStyle);
  const setFinishMarkerFillColor = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerFillColor);
  const setFinishMarkerBorderColor = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerBorderColor);
  const setFinishMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerBorderWidth);
  const setFinishMarkerGapWidth = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerGapWidth);
  const setFinishMarkerSize = useMazeStore((s) => s.setVectorByCorridorsFinishMarkerSize);
  const setMarkerWidenPadding = useMazeStore((s) => s.setVectorByCorridorsMarkerWidenPadding);
  const setMarkerWidenShape = useMazeStore((s) => s.setVectorByCorridorsMarkerWidenShape);
  const patchOneWaySettings = useMazeStore((s) => s.patchVectorByCorridorsOneWaySettings);
  const patchTeleportSettings = useMazeStore((s) => s.patchVectorByCorridorsTeleportSettings);
  const setTeleportGroupOverride = useMazeStore((s) => s.setVectorByCorridorsTeleportGroupOverride);
  const setSelectedTeleportGroupKey = useMazeStore((s) => s.setSelectedTeleportGroupKey);
  const setSplitNodeColor = useMazeStore((s) => s.setVectorByCorridorsSplitNodeColor);
  const setSplitSpecialShapes = useMazeStore((s) => s.setVectorByCorridorsSplitSpecialShapes);
  const setSplitGapWidth = useMazeStore((s) => s.setVectorByCorridorsSplitGapWidth);
  const setSplitDiagonalBowAmount = useMazeStore((s) => s.setVectorByCorridorsSplitDiagonalBowAmount);
  const setSharedCornerStyle = useMazeStore((s) => s.setVectorByCorridorsSharedCornerStyle);
  const setSharedMarkerSize = useMazeStore((s) => s.setVectorByCorridorsSharedMarkerSize);
  const setSharedMarkerBorderWidth = useMazeStore((s) => s.setVectorByCorridorsSharedMarkerBorderWidth);
  const setSharedGapWidth = useMazeStore((s) => s.setVectorByCorridorsSharedGapWidth);
  const resetSharedStyleField = useMazeStore((s) => s.resetVectorByCorridorsSharedStyleField);
  const forceSharedStyle = useMazeStore((s) => s.forceVectorByCorridorsSharedStyle);
  const resetAllSettings = useMazeStore((s) => s.resetVectorByCorridorsSettings);

  const sectionsExpanded = useMazeStore((s) => s.vectorByCorridorsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByCorridorsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  // Collapsing the Teleports section dangles a click-selection the same way
  // `VectorByWallsSettingsPanel` guards against — see that component's own doc comment on this.
  const toggleSection = (id: string) => {
    if (id === "teleports" && isExpanded(id)) setSelectedTeleportGroupKey(null);
    setSectionExpanded(id, !isExpanded(id));
  };

  // `Escape` clears a click-selected teleport group — same global convention
  // `VectorByWallsSettingsPanel` uses (see its own doc comment on this).
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

  const { start, finish } = useMemo(
    () => resolveEffectiveEndpoints({ nodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [nodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  const exportWarnings = useMemo(
    () => computeVectorByCorridorsWarnings(nodes, edges, cfg, settings, start, finish),
    [nodes, edges, cfg, settings, start, finish],
  );

  // One-ways/Teleports sections only make sense when the maze actually has that kind of edge —
  // mirrors `VectorByWallsSettingsPanel`'s own `hasOneWays`/`hasTeleports` "hide when there's
  // nothing to configure" rule (GitHub issue #312).
  const hasOneWays = useMemo(() => {
    const basicEdges = edges.filter((e) => e.kind === "basic");
    const forward = new Set(basicEdges.map((e) => `${e.from}->${e.to}`));
    return basicEdges.some((e) => !forward.has(`${e.to}->${e.from}`));
  }, [edges]);
  const hasTeleports = useMemo(() => edges.some((e) => e.kind === "teleport"), [edges]);

  const { teleportGroups, teleportCollisionKeys } = useTeleportGroupsAndCollisions(nodes, edges, cfg, settings);

  // Splits section (GitHub issue #314) — same "hide when there's nothing to configure" rule as
  // `VectorByWallsSettingsPanel`'s own Splits section.
  const maxSplit = useMemo(() => maxSplitNodeCount(nodes), [nodes]);

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
        label={m["image_export.vector_by_corridors.section_cells"]()}
        expanded={isExpanded("cells")}
        onToggle={() => toggleSection("cells")}
      />
      {isExpanded("cells") && (
        <div style={styles.block}>
          <ColorRow label={m["image_export.vector_by_corridors.color"]()} color={settings.color} onChange={setColor} />
          <SelectRow
            label={m["image_export.vector_by_corridors.join"]()}
            value={settings.join}
            options={[
              { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
              { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
            ]}
            onChange={setJoin}
            resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "join", () => resetSharedStyleField("cornerStyle", "join"))}
          />
          <SliderRow
            label={m["image_export.vector_by_corridors.thickness"]()}
            value={settings.thickness}
            onChange={setThickness}
            min={1}
            max={TILE_SIZE}
            step={1}
            format={(v) => String(v)}
          />
          <SliderRow
            label={m["image_export.vector_by_corridors.marker_widen_padding"]()}
            value={settings.markerWidenPadding}
            onChange={setMarkerWidenPadding}
            min={0}
            max={20}
            step={1}
            format={(v) => String(v)}
          />
          <SelectRow
            label={m["image_export.vector_by_corridors.marker_widen_shape"]()}
            value={settings.markerWidenShape}
            options={[
              { value: "match_marker", label: m["image_export.vector_by_corridors.marker_widen_shape_match_marker"]() },
              { value: "circle", label: m["image_export.vector_by_corridors.marker_widen_shape_circle"]() },
              { value: "square", label: m["image_export.vector_by_corridors.marker_widen_shape_square"]() },
            ]}
            onChange={setMarkerWidenShape}
          />
        </div>
      )}

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_markers"]()}
        expanded={isExpanded("waypoints")}
        onToggle={() => toggleSection("waypoints")}
      />
      {isExpanded("waypoints") && (
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
              <ColorRow
                label={m["image_export.vector_by_corridors.one_way_color"]()}
                color={settings.oneWayColor}
                onChange={(color) => patchOneWaySettings({ oneWayColor: color })}
              />
              <SliderRow
                label={m["image_export.vector_by_corridors.one_way_count"]()}
                value={settings.oneWayCount}
                onChange={(v) => patchOneWaySettings({ oneWayCount: v })}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["image_export.vector_by_corridors.one_way_thickness"]()}
                value={settings.oneWayThickness}
                onChange={(v) => patchOneWaySettings({ oneWayThickness: v })}
                min={1}
                max={TILE_SIZE / 4}
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["image_export.vector_by_corridors.one_way_gap"]()}
                value={settings.oneWayGap}
                onChange={(v) => patchOneWaySettings({ oneWayGap: v })}
                min={0}
                max={TILE_SIZE / 4}
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["image_export.vector_by_corridors.one_way_width"]()}
                value={settings.oneWayWidth}
                onChange={(v) => patchOneWaySettings({ oneWayWidth: v })}
                min={0.01}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label={m["image_export.vector_by_corridors.one_way_length"]()}
                value={settings.oneWayLength}
                onChange={(v) => patchOneWaySettings({ oneWayLength: v })}
                min={0.1}
                max={1}
                step={0.1}
                format={(v) => v.toFixed(1)}
              />
              <SelectRow
                label={m["image_export.vector_by_corridors.one_way_join"]()}
                value={settings.oneWayJoin}
                options={[
                  { value: "round", label: m["image_export.vector_by_walls.wall_join_round"]() },
                  { value: "miter", label: m["image_export.vector_by_walls.wall_join_miter"]() },
                ]}
                onChange={(join) => patchOneWaySettings({ oneWayJoin: join })}
                resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "cornerStyle", "oneWayJoin", () => resetSharedStyleField("cornerStyle", "oneWayJoin"))}
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
              <SliderRow
                label={m["image_export.vector_by_corridors.split_gap_width"]()}
                value={settings.splitGapWidth}
                onChange={setSplitGapWidth}
                min={0}
                max={TILE_SIZE / 2}
                step={1}
                format={(v) => String(v)}
                disabled={!settings.splitSpecialShapes}
                resetButton={sharedStyleFieldReset(settings.sharedStyle.overrides, "gapWidth", "split", () => resetSharedStyleField("gapWidth", "split"))}
              />
              <SliderRow
                label={m["image_export.vector_by_corridors.split_diagonal_bow_amount"]()}
                value={settings.splitDiagonalBowAmount}
                onChange={setSplitDiagonalBowAmount}
                min={0}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                disabled={!settings.splitSpecialShapes}
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
