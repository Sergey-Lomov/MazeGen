import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { inset } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { SectionHeader } from "../SectionHeader";
import { ColorRow } from "../ColorRow";
import { Stack } from "../Layout";
import * as m from "~/paraglide/messages";

/** "General settings" section of the "Vector by walls" render mode's settings panel (GitHub
 * issue #289, part of #288's epic) — background appearance only: background color, grid
 * visibility, grid color. Defaults are set in `imageExportSlice.ts` to match the editor's normal
 * grid appearance exactly. */
export function VectorByWallsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByWallsSettings);
  const setBackground = useMazeStore((s) => s.setVectorByWallsBackground);
  const setShowGrid = useMazeStore((s) => s.setVectorByWallsShowGrid);
  const setGridColor = useMazeStore((s) => s.setVectorByWallsGridColor);

  const sectionsExpanded = useMazeStore((s) => s.vectorByWallsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByWallsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? true;
  const toggleSection = (id: string) => setSectionExpanded(id, !isExpanded(id));

  return (
    <Stack gap="itemGap" style={styles.root}>
      <SectionHeader
        label={m["image_export.vector_by_walls.section_background"]()}
        expanded={isExpanded("background")}
        onToggle={() => toggleSection("background")}
      />
      {isExpanded("background") && (
        <Stack gap="itemGap">
          <ColorRow label={m["image_export.vector_by_walls.background_color"]()} color={settings.background} onChange={setBackground} />
          <ToggleRow label={m["image_export.vector_by_walls.show_grid"]()} checked={settings.showGrid} onChange={setShowGrid} />
          <ColorRow
            label={m["image_export.vector_by_walls.grid_color"]()}
            color={settings.gridColor}
            onChange={setGridColor}
            disabled={!settings.showGrid}
          />
        </Stack>
      )}
    </Stack>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
};
