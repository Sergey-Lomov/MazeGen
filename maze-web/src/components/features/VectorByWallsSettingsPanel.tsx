import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { inset, spacing, ui } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import * as m from "~/paraglide/messages";

/** "Background" and "Tiles" sections of the "Vector by walls" render mode's settings panel
 * (GitHub issue #289 for background, #290/#291 for floor/wall settings — folded into one "Tiles"
 * section since both draw on the maze's cells/tiles, unlike background/grid which draw on the
 * viewport — all part of #288's epic). Background covers background color, grid visibility, grid
 * color. Tiles covers the floor's fill color, wall color, corners & ends (round/miter join,
 * paired with a round/square cap) and wall thickness — wall settings applied via
 * `WallStyleOverride` to solid walls, split-junction wall faces and closed-cells fill only (see
 * `renderers/types.ts`), never the faint/background wall styles or split-passage node-identity
 * colors. Defaults are set in `imageExportSlice.ts` to match the editor's normal
 * grid/floor/wall appearance exactly. Section layout (row gap, divider between sections) mirrors
 * `AnalyticsFeature`'s collapsible sections. */
export function VectorByWallsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const setBackground = useMazeStore((s) => s.setVectorByWallsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByWallsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByWallsGridColor);
  const setFloorColor = useMazeStore((s) => s.setVectorByWallsFloorColor);
  const setWallColor = useMazeStore((s) => s.setVectorByWallsWallColor);
  const setWallJoin = useMazeStore((s) => s.setVectorByWallsWallJoin);
  const setWallThickness = useMazeStore((s) => s.setVectorByWallsWallThickness);

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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
