import type React from "react";
import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { inset, spacing, ui } from "../../styles/theme";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { SectionHeader } from "../SectionHeader";
import { MarkerSettingsGroup } from "./MarkerSettingsGroup";
import { computeVectorByCorridorsWarnings } from "../../pixi/selectors/exportWarnings";
import { resolveEffectiveEndpoints } from "../../pixi/imageExport/VectorByWallsRenderer";
import { resolveExportWarningsSectionTitle } from "./exportWarningsI18n";
import { ExportWarningBubble } from "./ExportWarningBubble";
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

  const sectionsExpanded = useMazeStore((s) => s.vectorByCorridorsSectionsExpanded);
  const setSectionExpanded = useMazeStore((s) => s.setVectorByCorridorsSectionExpanded);
  const isExpanded = (id: string) => sectionsExpanded[id] ?? false;
  const toggleSection = (id: string) => setSectionExpanded(id, !isExpanded(id));

  const nodes = useMazeStore((s) => s.nodes);
  const rawStart = useMazeStore((s) => s.start);
  const rawFinish = useMazeStore((s) => s.finish);
  const postEditMeta = useMazeStore((s) => s.postEditMeta);
  const postEditDraftSplitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);

  const { start, finish } = useMemo(
    () => resolveEffectiveEndpoints({ nodes, start: rawStart, finish: rawFinish, postEditMeta, postEditDraftSplitPoints }),
    [nodes, rawStart, rawFinish, postEditMeta, postEditDraftSplitPoints],
  );

  const exportWarnings = useMemo(
    () => computeVectorByCorridorsWarnings(nodes, start, finish),
    [nodes, start, finish],
  );

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

      <div style={styles.divider} />

      <SectionHeader
        label={m["image_export.vector_by_walls.section_markers"]()}
        expanded={isExpanded("waypoints")}
        onToggle={() => toggleSection("waypoints")}
      />
      {isExpanded("waypoints") && (
        <div style={styles.block}>
          <SliderRow
            label={m["image_export.vector_by_corridors.marker_widen_padding"]()}
            value={settings.markerWidenPadding}
            onChange={setMarkerWidenPadding}
            min={0}
            max={20}
            step={1}
            format={(v) => String(v)}
          />
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

      {exportWarnings.length > 0 && (
        <>
          <div style={styles.divider} />

          <SectionHeader
            label={resolveExportWarningsSectionTitle(exportWarnings.length)}
            expanded={isExpanded("warnings")}
            onToggle={() => toggleSection("warnings")}
          />
          {isExpanded("warnings") && (
            <div style={styles.warningsBlock}>
              {exportWarnings.map((w) => (
                <ExportWarningBubble key={w.key} warning={w} />
              ))}
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
  warningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
};
