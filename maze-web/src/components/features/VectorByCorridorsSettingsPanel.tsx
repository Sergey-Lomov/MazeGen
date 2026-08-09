import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { inset, spacing, ui } from "../../styles/theme";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { SectionHeader } from "../SectionHeader";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { TILE_SIZE } from "../../pixi/constants";
import * as m from "~/paraglide/messages";

/** "Vector by corridors" mode's own settings panel (GitHub issue #310) — a collapsible "Cells"
 * section (mirrors `VectorByWallsSettingsPanel`'s own "Tiles" section naming/collapse convention,
 * `vectorByCorridorsSectionsExpanded` keyed the same way) covering the corridor stroke's color,
 * corners & ends (round/miter join, paired with a round/square cap, same convention as
 * `VectorByWallsSettingsPanel`'s wall join setting) and thickness (1 to `TILE_SIZE` — a corridor
 * wider than a whole cell has no meaningful upper bound of its own, so the cap tracks the cell size
 * rather than a fixed pixel constant, unlike `VectorByWallsSettings.wallThickness`'s fixed 1-20
 * range). Bottom warnings section mirrors `VectorByWallsSettingsPanel`'s own layout so both panels
 * stay visually consistent; wired to an empty list here since this mode has no export-warning
 * checks yet — stays hidden until a follow-up sub-issue adds a real `compute*Warnings` function for
 * this mode. */
export function VectorByCorridorsSettingsPanel() {
  const settings = useMazeStore((s) => s.vectorByCorridorsSettings);
  const setColor = useMazeStore((s) => s.setVectorByCorridorsColor);
  const setJoin = useMazeStore((s) => s.setVectorByCorridorsJoin);
  const setThickness = useMazeStore((s) => s.setVectorByCorridorsThickness);

  const sectionsExpanded = useMazeStore((s) => s.vectorByCorridorsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByCorridorsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  const toggleSection = (id: string) => setSectionExpanded(id, !isExpanded(id));

  const exportWarnings: ExportWarning[] = [];

  return (
    <div style={styles.root}>
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
        </div>
      )}

      {exportWarnings.length > 0 && (
        <>
          <div style={styles.divider} />
          <div style={styles.warningsBlock} />
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
  warningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
};
