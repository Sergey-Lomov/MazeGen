import type { EdgeMarkerStyle, GlueTabStyle } from "../../store/imageExportTypes";
import type { ParamLink } from "../../store/parameterLinks";
import type { MazeState } from "../../store/storeTypes";
import { computeEdgeMarkerWarningsOf, computeSeamSectionAmbiguityWarning } from "./edgeMarkerWarnings";
import type { ExportWarning, ExportWarningId } from "./exportWarnings";
import { computeGlueTabWarnings } from "./glueTabWarnings";
import { inputMemo, trackedMemo } from "./trackedMemo";

/// The warnings about the topology's own elements in the export: glue tabs (GitHub issue #913) and edge alignment marks
/// (GitHub issue #902). They need the tabs and marks themselves rather than the maze, so they are computed apart from a
/// mode's list, the same way for both render modes; the panel appends them to the mode's list and `TopologyWarningHighlight`
/// draws the hovered one.

export type TopologyWarningState = Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "floorCreases" | "pngExportSettings" | "nodes" | "edges" | "floors">;

/** The part of a render mode's settings the topology warnings read. */
export interface TopologyWarningSettings<P extends string> {
  glueTabs: GlueTabStyle;
  edgeMarkers: EdgeMarkerStyle;
  links: ParamLink<P>[];
  background: number;
}

/** A topology warning group (GitHub issue #928): like a mode's `WarningGroup`, it reads the settings only through its argument and
 *  declares its ids, and a warning id belongs to one group; but it concerns the active floor's net, so its input is the store state. */
interface TopologyWarningGroup {
  readonly name: string;
  readonly ids: readonly ExportWarningId[];
  readonly run: <P extends string>(state: TopologyWarningState, settings: TopologyWarningSettings<P>) => ExportWarning[];
}

export const TOPOLOGY_WARNING_GROUPS: readonly TopologyWarningGroup[] = [
  { name: "glueTabs", ids: ["glue_tabs_overlap", "glue_tab_too_thin", "glue_tab_missing"], run: (state, settings) => computeGlueTabWarnings(state, settings.glueTabs) },
  { name: "edgeMarkers", ids: ["edge_marker_colors_similar", "edge_marker_low_contrast_background"], run: computeEdgeMarkerWarningsOf },
  { name: "seamAmbiguity", ids: ["seam_matching_ambiguous_without_markers"], run: (state, settings) => computeSeamSectionAmbiguityWarning(state, settings.edgeMarkers) },
];

/** The topology warnings of the active floor, each group cached on the state it reads (every field of `TopologyWarningState`) plus the
 *  settings fields it reads — the panel and the hover highlight share the cache. */
export function computeTopologyWarnings<P extends string>(state: TopologyWarningState, settings: TopologyWarningSettings<P>): ExportWarning[] {
  const inputs = [
    state.activeFloorId, state.activeFieldConfig, state.floorTopology, state.floorCreases, state.pngExportSettings, state.nodes, state.edges, state.floors,
  ];
  const lists = TOPOLOGY_WARNING_GROUPS.map((group) => trackedMemo(`topology:${group.name}`, inputs, settings, (tracked) => group.run(state, tracked)));
  // The same list object while every group hits, so the panel does not see a new list on each unrelated settings edit.
  return inputMemo("topology:merged", lists, () => lists.flat());
}
