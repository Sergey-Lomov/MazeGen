import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { MarkerSettings } from "../../store/storeTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import { inset, spacing, ui, typography } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import * as m from "~/paraglide/messages";

const MARKER_SHAPE_OPTIONS: { value: MarkerShape; label: () => string }[] = [
  { value: "circle", label: m["image_export.vector_by_walls.marker_shape_circle"] },
  { value: "square", label: m["image_export.vector_by_walls.marker_shape_square"] },
  { value: "diamond", label: m["image_export.vector_by_walls.marker_shape_diamond"] },
  { value: "triangle", label: m["image_export.vector_by_walls.marker_shape_triangle"] },
  { value: "star5", label: m["image_export.vector_by_walls.marker_shape_star5"] },
];

/** One "Start"/"Finish" sub-group of the markers section — plain-weight label (not a
 *  `SectionHeader`, always visible, no collapse) indented under the section header, per GitHub
 *  issue #296. Shape, fill color, border color and border width; `borderWidth: 0` draws no
 *  border, so there is no separate show-border toggle. */
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
      </div>
    </div>
  );
}

/** "Background", "Tiles" and "Markers" sections of the "Vector by walls" render mode's settings
 * panel (GitHub issue #289 for background, #290/#291 for floor/wall settings — folded into one
 * "Tiles" section since both draw on the maze's cells/tiles, unlike background/grid which draw on
 * the viewport — #296 for start/finish markers — all part of #288's epic). Background covers
 * background color, grid visibility, grid color. Tiles covers the floor's fill color, wall color,
 * corners & ends (round/miter join, paired with a round/square cap) and wall thickness — wall
 * settings applied via `WallStyleOverride` to solid walls, split-junction wall faces and
 * closed-cells fill only (see `renderers/types.ts`), never the faint/background wall styles or
 * split-passage node-identity colors. Markers covers the start/finish marker's shape, fill color,
 * border color and border width, as two plain-label sub-groups ("Start"/"Finish") within the one
 * collapsible section — not two separate `SectionHeader`s, since they're too small to warrant
 * independent collapse. Defaults are set in `imageExportSlice.ts` to match the editor's normal
 * grid/floor/wall/marker appearance exactly. Section layout (row gap, divider between sections)
 * mirrors `AnalyticsFeature`'s collapsible sections. */
export function VectorByWallsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const setBackground = useMazeStore((s) => s.setVectorByWallsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByWallsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByWallsGridColor);
  const setFloorColor = useMazeStore((s) => s.setVectorByWallsFloorColor);
  const setWallColor = useMazeStore((s) => s.setVectorByWallsWallColor);
  const setWallJoin = useMazeStore((s) => s.setVectorByWallsWallJoin);
  const setWallThickness = useMazeStore((s) => s.setVectorByWallsWallThickness);
  const setStartMarkerShape = useMazeStore((s) => s.setVectorByWallsStartMarkerShape);
  const setStartMarkerFillColor = useMazeStore((s) => s.setVectorByWallsStartMarkerFillColor);
  const setStartMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderColor);
  const setStartMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsStartMarkerBorderWidth);
  const setFinishMarkerShape = useMazeStore((s) => s.setVectorByWallsFinishMarkerShape);
  const setFinishMarkerFillColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerFillColor);
  const setFinishMarkerBorderColor = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderColor);
  const setFinishMarkerBorderWidth = useMazeStore((s) => s.setVectorByWallsFinishMarkerBorderWidth);

  const sectionsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? true;
  const toggleSection = (id: string) => setSectionExpanded(id, !isExpanded(id));

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
              if (patch.fillColor !== undefined) setStartMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setStartMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setStartMarkerBorderWidth(patch.borderWidth);
            }}
          />
          <MarkerSettingsGroup
            title={m["image_export.vector_by_walls.markers_finish"]()}
            settings={settings.finishMarker}
            onChange={(patch) => {
              if (patch.shape !== undefined) setFinishMarkerShape(patch.shape);
              if (patch.fillColor !== undefined) setFinishMarkerFillColor(patch.fillColor);
              if (patch.borderColor !== undefined) setFinishMarkerBorderColor(patch.borderColor);
              if (patch.borderWidth !== undefined) setFinishMarkerBorderWidth(patch.borderWidth);
            }}
          />
        </div>
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
};
