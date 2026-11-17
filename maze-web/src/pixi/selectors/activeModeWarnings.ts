import type { FieldConfig } from "../../fieldConfig";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { MazeState, VectorByCorridorsSettings, VectorByWallsSettings } from "../../store/storeTypes";
import type { RenderModeId } from "../../store/imageExportTypes";
import { hasAnyGlue } from "./colorFieldRegistry";
import {
  computeTextOverflowWarningsAcrossFloors, computeVectorByCorridorsWarningsAcrossFloors, computeVectorByWallsWarningsAcrossFloors,
  type ExportWarning, type WarningFloor,
} from "./exportWarnings";

/** The project inputs the export warnings read, as the store holds them. */
export interface ActiveModeWarningProject {
  nodes: NodeDto[];
  edges: EdgeDto[];
  floors: WarningFloor[];
  floorTopology: MazeState["floorTopology"];
  cfg: FieldConfig;
  start: number | null;
  finish: number | null;
}

/** Warnings of the render mode whose settings panel is open (every floor), for `settings`. A picker
 *  passes its own working copy of the settings, so the warnings follow an edit before it is committed.
 *  Anything but "Vector by walls" is computed by the corridors rules, like the picker panels do. */
export function computeActiveModeWarnings(mode: RenderModeId, settings: VectorByWallsSettings | VectorByCorridorsSettings, project: ActiveModeWarningProject): ExportWarning[] {
  const { nodes, edges, floors, floorTopology, cfg, start, finish } = project;
  const hasGlues = hasAnyGlue(floorTopology);
  return mode === "vector_by_walls"
    ? computeVectorByWallsWarningsAcrossFloors(nodes, edges, floors, cfg, settings as VectorByWallsSettings, start, finish, undefined, hasGlues)
    : computeVectorByCorridorsWarningsAcrossFloors(nodes, edges, floors, cfg, settings as VectorByCorridorsSettings, start, finish, undefined, hasGlues);
}

/** The text overflow warnings alone of the open render mode (GitHub issue #971), for a picker that
 *  only cares whether a label fits its plate. Same inputs and mode rule as {@link computeActiveModeWarnings}. */
export function computeActiveModeTextOverflowWarnings(mode: RenderModeId, settings: VectorByWallsSettings | VectorByCorridorsSettings, project: ActiveModeWarningProject): ExportWarning[] {
  const { nodes, edges, floors, floorTopology, cfg, start, finish } = project;
  return computeTextOverflowWarningsAcrossFloors(mode === "vector_by_walls" ? "walls" : "corridors", nodes, edges, floors, cfg, settings, start, finish, hasAnyGlue(floorTopology));
}
