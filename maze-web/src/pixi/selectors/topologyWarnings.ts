import type { EdgeMarkerStyle, GlueTabStyle } from "../../store/imageExportTypes";
import type { ParamLink } from "../../store/parameterLinks";
import type { MazeState } from "../../store/storeTypes";
import { computeEdgeMarkerWarningsOf } from "./edgeMarkerWarnings";
import type { ExportWarning } from "./exportWarnings";
import { computeGlueTabWarnings } from "./glueTabWarnings";

/// The warnings about the topology's own elements in the export: glue tabs (GitHub issue #913) and edge alignment marks
/// (GitHub issue #902). They need the tabs and marks themselves rather than the maze, so they are computed apart from a
/// mode's list, the same way for both render modes; the panel appends them to the mode's list and `TopologyWarningHighlight`
/// draws the hovered one.

export type TopologyWarningState = Pick<MazeState, "activeFloorId" | "activeFieldConfig" | "floorTopology" | "floorCreases" | "pngExportSettings" | "nodes" | "floors">;

/** The part of a render mode's settings the topology warnings read. */
export interface TopologyWarningSettings<P extends string> {
  glueTabs: GlueTabStyle;
  edgeMarkers: EdgeMarkerStyle;
  links: ParamLink<P>[];
  background: number;
}

export function computeTopologyWarnings<P extends string>(state: TopologyWarningState, settings: TopologyWarningSettings<P>): ExportWarning[] {
  return [...computeGlueTabWarnings(state, settings.glueTabs), ...computeEdgeMarkerWarningsOf(state, settings)];
}
