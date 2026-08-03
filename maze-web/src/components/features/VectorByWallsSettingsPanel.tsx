import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { inset, spacing, ui } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import * as m from "~/paraglide/messages";

/** "Background" and "Floor" sections of the "Vector by walls" render mode's settings panel
 * (GitHub issue #289 for background, #290 for floor, both part of #288's epic). Background covers
 * background color, grid visibility, grid color. Floor covers the floor's fill color. Defaults are
 * set in `imageExportSlice.ts` to match the editor's normal grid/floor appearance exactly. Section
 * layout (row gap, divider between sections) mirrors `AnalyticsFeature`'s collapsible sections. */
export function VectorByWallsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const setBackground = useMazeStore((s) => s.setVectorByWallsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByWallsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByWallsGridColor);
  const setFloorColor = useMazeStore((s) => s.setVectorByWallsFloorColor);

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
        label={m["image_export.vector_by_walls.section_floor"]()}
        expanded={isExpanded("floor")}
        onToggle={() => toggleSection("floor")}
      />
      {isExpanded("floor") && (
        <div style={styles.block}>
          <ColorRow label={m["image_export.vector_by_walls.floor_color"]()} color={settings.floorColor} onChange={setFloorColor} />
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
