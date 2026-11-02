import type React from "react";
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
import * as m from "~/paraglide/messages";

/** The "Topology" section of a render mode's settings (GitHub issue #859): how the cut lines are drawn on the image.
 * Shown for a floor that has glues or creases (its glue rows only with glues). Both render modes use it as is, each with its own store actions. */
export function TopologySettingsSection({ expanded, onToggle, style, defaultColor, priorityColors, onShow, onGlueColor, onColor, creasesExpanded, onToggleCreases, creaseStyle, creaseDefaultColor, creasePriorityColors, onCreasesChange, glueTabsExpanded, onToggleGlueTabs, glueTabStyle, glueTabDefaults, glueTabPriorityColors, onGlueTabsChange, edgeMarkersExpanded, onToggleEdgeMarkers, edgeMarkerStyle, edgeMarkerDefaultColor, edgeMarkerPriorityColors, onEdgeMarkersChange, onEdgeMarkerOverride, onEdgeMarkerOverrides }: {
  expanded: boolean;
  onToggle: () => void;
  style: CutLineStyleFields;
  defaultColor: number;
  /** Sibling colours pinned at the top of the colour picker: background, corridor/floor, walls, outer grid. */
  priorityColors: ProjectColorEntry[];
  onShow: (show: boolean) => void;
  onGlueColor: (glueColor: boolean) => void;
  onColor: (color: number) => void;
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
  const hasGlues = useMazeStore((s) => (s.floorTopology[s.activeFloorId]?.groups.length ?? 0) > 0);
  const hasCreases = useMazeStore((s) => (s.floorCreases[s.activeFloorId]?.length ?? 0) > 0);
  if (!hasGlues && !hasCreases) return null;
  return (
    <>
      <div style={styles.divider} />
      <SectionHeader label={m["topology.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          {hasGlues && <LinkedToggleRow label={m["image_export.topology.show_cut_lines"]()} checked={style.showCutLines} onChange={onShow} linkTarget="showCutLines" />}
          {hasGlues && style.showCutLines && (
            <LinkedToggleRow label={m["image_export.topology.cut_lines_glue_color"]()} checked={style.cutLinesGlueColor} onChange={onGlueColor} linkTarget="cutLinesGlueColor" />
          )}
          {hasGlues && style.showCutLines && !style.cutLinesGlueColor && (
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
          {hasGlues && (
            <GlueTabSettingsSubsection expanded={glueTabsExpanded} onToggle={onToggleGlueTabs} style={glueTabStyle} defaults={glueTabDefaults} priorityColors={glueTabPriorityColors} onChange={onGlueTabsChange} />
          )}
          {hasCreases && (
            <CreaseSettingsSubsection expanded={creasesExpanded} onToggle={onToggleCreases} style={creaseStyle} defaultColor={creaseDefaultColor} priorityColors={creasePriorityColors} onChange={onCreasesChange} />
          )}
          <EdgeMarkerSettingsSubsection expanded={edgeMarkersExpanded} onToggle={onToggleEdgeMarkers} style={edgeMarkerStyle} defaultColor={edgeMarkerDefaultColor} priorityColors={edgeMarkerPriorityColors} onChange={onEdgeMarkersChange} onOverride={onEdgeMarkerOverride} onOverrides={onEdgeMarkerOverrides} />
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
