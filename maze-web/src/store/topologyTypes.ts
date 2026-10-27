import type { WireFoldEnd } from "../wasm/types";
import type { TopologyOp } from "../wasm/mazeService";
import type { TopologyRunSelection } from "./topologyInfo";
import type { TopologyProblem } from "./topologyProblem";

/** Which of the two runs of a new glue the next canvas drag draws (GitHub issue #839). */
export type TopologyPickTarget = "a" | "b";

/** What the glue editor panel works on: a new glue, or an existing one (`glueId` is its fold group id). */
export type TopologyGlueEditor = { mode: "add" } | { mode: "edit"; glueId: number };

/** A hovered glue, or one pair of it when `fold` is set. */
export interface TopologyHover {
  glue: number;
  fold: number | null;
}

export interface TopologyState {
  /** The two boundary runs being glued; `null` until picked. Ephemeral editor state. */
  topologyRunA: TopologyRunSelection | null;
  topologyRunB: TopologyRunSelection | null;
  /** The run the next canvas drag draws; `null` when the canvas is not picking. */
  topologyPick: TopologyPickTarget | null;
  /** Whether the glue is twisted (start meets start) rather than the ordinary reversed match. */
  topologyTwist: boolean;
  /** Why the last glue of the glue editor panel was refused; `null` after a successful edit. */
  topologyGlueError: TopologyProblem | null;
  /** Why the last remove of the topology panel was refused. */
  topologyPanelError: TopologyProblem | null;
  /** Whether the topology side panel is open (the field setup card only holds its button). */
  topologyPanelOpen: boolean;
  /** The open glue editor panel (picking the two runs of a new or an existing glue); `null` when closed. */
  topologyGlueEditor: TopologyGlueEditor | null;
  /** What the panel list hovers: a whole glue (fold group id) or one of its pairs (index into
   * `WireTopology.folds`). Its faces are highlighted on the canvas. */
  topologyHover: TopologyHover | null;
  /** The boundary face under the pointer while a run is being edited; highlighted as an edge. */
  topologyFaceHover: { contour: number; face: number } | null;
  /** Sides of the glue editor panel under the pointer (the hovered one and its would-be partner),
   * drawn in the colours of run A and run B. */
  topologySideHover: { a: readonly WireFoldEnd[]; b: readonly WireFoldEnd[] } | null;
  /** Sides a hovered problem bubble points at; drawn red over the run highlight. */
  topologyFlagged: readonly WireFoldEnd[];
}

export interface TopologyActions {
  setTopologyHover: (hover: TopologyHover | null) => void;
  setTopologySideHover: (hover: { a: readonly WireFoldEnd[]; b: readonly WireFoldEnd[] } | null) => void;
  setTopologyFlagged: (sides: readonly WireFoldEnd[]) => void;
  setTopologyFaceHover: (hover: { contour: number; face: number } | null) => void;
  /** Opens the glue editor on a new glue, or on the glue `glueId` with its runs and twist loaded. */
  openTopologyGlueEditor: (glueId?: number) => void;
  closeTopologyGlueEditor: () => void;
  setTopologyPanelOpen: (open: boolean) => void;
  startTopologyPick: (target: TopologyPickTarget | null) => void;
  /** Sets (or with `null` clears) the dragged run `target`. */
  setTopologyRun: (target: TopologyPickTarget, selection: TopologyRunSelection | null) => void;
  clearTopologyRuns: () => void;
  setTopologyTwist: (twist: boolean) => void;
  /** Applies one transactional edit to the active floor. Refused edits leave the topology
   * untouched and set `topologyGlueError` (a glue) or `topologyPanelError` (anything else). */
  applyTopologyOp: (op: TopologyOp) => void;
  /** Glues the picked runs: as a new group, or in place of the edited glue. */
  confirmTopologyGlue: () => void;
  removeTopologyGroup: (id: number) => void;
}
