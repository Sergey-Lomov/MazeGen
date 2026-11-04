import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { CreaseExportStyle, CutLineStyleFields, EdgeMarkerOverride, EdgeMarkerStyle, GlueTabStyle } from "../../store/imageExportTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { PC } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, ui } from "../../styles/theme";
import { SectionHeader } from "../SectionHeader";
import { LinkedColorRow, LinkedToggleRow } from "./LinkedRows";
import { CreaseSettingsSubsection } from "./CreaseSettingsSubsection";
import { GlueTabSettingsSubsection } from "./GlueTabSettingsSubsection";
import { EdgeMarkerSettingsSubsection } from "./EdgeMarkerSettingsSubsection";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { bringSidePanelToFront } from "../SidePanel";
import * as m from "~/paraglide/messages";

/** The "Topology" section of a render mode's settings (GitHub issues #859, #924): cut lines, glue tabs,
 * creases and alignment marks. Cut lines remain available without glues, while glue-dependent controls stay hidden. */
export function TopologySettingsSection({ expanded, onToggle, style, defaultColor, priorityColors, onShow, onGlueColor, onColor, onTrimWallsAtFaceBoundaries, cutLinesExpanded, onToggleCutLines, creasesExpanded, onToggleCreases, creaseStyle, creaseDefaultColor, creasePriorityColors, onCreasesChange, glueTabsExpanded, onToggleGlueTabs, glueTabStyle, glueTabDefaults, glueTabPriorityColors, onGlueTabsChange, edgeMarkersExpanded, onToggleEdgeMarkers, edgeMarkerStyle, edgeMarkerDefaultColor, edgeMarkerPriorityColors, onEdgeMarkersChange, onEdgeMarkerOverride, onEdgeMarkerOverrides }: {
  expanded: boolean;
  onToggle: () => void;
  style: CutLineStyleFields;
  defaultColor: number;
  /** Sibling colours pinned at the top of the colour picker: background, corridor/floor, walls, outer grid. */
  priorityColors: ProjectColorEntry[];
  onShow: (show: boolean) => void;
  onGlueColor: (glueColor: boolean) => void;
  onColor: (color: number) => void;
  onTrimWallsAtFaceBoundaries?: (trim: boolean) => void;
  /** The "Cut lines" subsection (GitHub issue #924). */
  cutLinesExpanded: boolean;
  onToggleCutLines: () => void;
  /** The "Creases" subsection (GitHub issue #900). */
  creasesExpanded: boolean;
  onToggleCreases: () => void;
  creaseStyle: CreaseExportStyle;
  creaseDefaultColor: number;
  creasePriorityColors: ProjectColorEntry[];
  onCreasesChange: (patch: Partial<CreaseExportStyle>) => void;
  /** The "Glue tabs" subsection (GitHub issue #901). */
  glueTabsExpanded: boolean;
  onToggleGlueTabs: () => void;
  glueTabStyle: GlueTabStyle;
  glueTabDefaults: GlueTabStyle;
  glueTabPriorityColors: ProjectColorEntry[];
  onGlueTabsChange: (patch: Partial<GlueTabStyle>) => void;
  edgeMarkersExpanded: boolean;
  onToggleEdgeMarkers: () => void;
  edgeMarkerStyle: EdgeMarkerStyle;
  edgeMarkerDefaultColor: number;
  edgeMarkerPriorityColors: ProjectColorEntry[];
  onEdgeMarkersChange: (patch: Partial<Omit<EdgeMarkerStyle, "overrides">>) => void;
  onEdgeMarkerOverride: (floorId: string, key: string, patch: EdgeMarkerOverride | null) => void;
  onEdgeMarkerOverrides: (floorId: string, patches: Record<string, EdgeMarkerOverride | null>) => void;
}) {
  const [trimWallsInfoOpen, setTrimWallsInfoOpen] = useState(false);
  const [cutLinesInfoOpen, setCutLinesInfoOpen] = useState(false);
  const hasGlues = useMazeStore((s) => (s.floorTopology[s.activeFloorId]?.groups.length ?? 0) > 0);
  const hasCreases = useMazeStore((s) => (s.floorCreases[s.activeFloorId]?.length ?? 0) > 0);
  const setExportTopologyOpen = useMazeStore((s) => s.setExportTopologyOpen);
  return (
    <>
      <div style={styles.divider} />
      <SectionHeader label={m["topology.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          {hasGlues && onTrimWallsAtFaceBoundaries && (
            <LinkedToggleRow
              label={m["image_export.topology.trim_walls_at_face_boundaries"]()}
              checked={style.trimWallsAtFaceBoundaries ?? true}
              onChange={onTrimWallsAtFaceBoundaries}
              info={() => setTrimWallsInfoOpen(true)}
              linkTarget="trimWallsAtFaceBoundaries"
            />
          )}
          <div style={styles.subsection}>
            <SectionHeader label={m["image_export.topology.cut_lines"]()} expanded={cutLinesExpanded} onToggle={onToggleCutLines} onOpenInfo={() => setCutLinesInfoOpen(true)} />
            {cutLinesExpanded && <div style={styles.subsectionFields}>
              {hasGlues && <>
                  <LinkedToggleRow label={m["image_export.topology.show_cut_lines"]()} checked={style.showCutLines} onChange={onShow} linkTarget="showCutLines" />
                  {style.showCutLines && (
                    <LinkedToggleRow label={m["image_export.topology.cut_lines_glue_color"]()} checked={style.cutLinesGlueColor} onChange={onGlueColor} linkTarget="cutLinesGlueColor" />
                  )}
                  {style.showCutLines && !style.cutLinesGlueColor && (
                    <LinkedColorRow
                      label={m["image_export.topology.cut_lines_color"]()}
                      color={style.cutLinesColor}
                      onChange={onColor}
                      defaultColor={defaultColor}
                      field={PC.cutLines}
                      priorityColors={priorityColors}
                      linkTarget="cutLinesColor"
                    />
                  )}
              </>}
              <Button
                variant="secondary"
                onClick={() => {
                  bringSidePanelToFront("image-export-topology");
                  setExportTopologyOpen(true);
                }}
              >
                {m["image_export.cuts.edit"]()}
              </Button>
            </div>}
          </div>
          {hasGlues && (
            <GlueTabSettingsSubsection expanded={glueTabsExpanded} onToggle={onToggleGlueTabs} style={glueTabStyle} defaults={glueTabDefaults} priorityColors={glueTabPriorityColors} onChange={onGlueTabsChange} />
          )}
          {hasCreases && (
            <CreaseSettingsSubsection expanded={creasesExpanded} onToggle={onToggleCreases} style={creaseStyle} defaultColor={creaseDefaultColor} priorityColors={creasePriorityColors} onChange={onCreasesChange} />
          )}
          <EdgeMarkerSettingsSubsection expanded={edgeMarkersExpanded} onToggle={onToggleEdgeMarkers} style={edgeMarkerStyle} defaultColor={edgeMarkerDefaultColor} priorityColors={edgeMarkerPriorityColors} onChange={onEdgeMarkersChange} onOverride={onEdgeMarkerOverride} onOverrides={onEdgeMarkerOverrides} />
        </div>
      )}
      {trimWallsInfoOpen && (
        <Modal title={m["image_export.topology.trim_walls_at_face_boundaries_info_title"]()} onClose={() => setTrimWallsInfoOpen(false)}>
          <div>{m["image_export.topology.trim_walls_at_face_boundaries_info"]()}</div>
        </Modal>
      )}
      {cutLinesInfoOpen && (
        <Modal title={m["image_export.topology.cut_lines_info_title"]()} onClose={() => setCutLinesInfoOpen(false)}>
          <div>{m["image_export.topology.cut_lines_info"]()}</div>
        </Modal>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  subsection: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subsectionFields: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
