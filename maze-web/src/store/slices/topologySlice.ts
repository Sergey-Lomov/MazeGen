import type { StateCreator } from "zustand";
import { editTopology, TopologyError } from "../../wasm/mazeService";
import type { MazeStore } from "../storeTypes";
import { buildResetDownstreamState, debugStaleOf, withActiveFloorField } from "../storeHelpers";
import { floorTopologyInfo, floorTopologyRequest, selectionRun } from "../topologyInfo";
import type { WireFoldEnd } from "../../wasm/types";
import type { TopologyActions, TopologyState } from "../topologyTypes";

const CLEARED_EDITOR = {
  topologyRunA: null,
  topologyRunB: null,
  topologyPick: null,
  topologyHover: null,
  topologyFaceHover: null,
  topologyFlagged: [],
  topologySideHover: null,
  seamHover: null,
} as const;

export const initialTopologyState: TopologyState = {
  ...CLEARED_EDITOR,
  topologyTwist: false,
  topologyGlueError: null,
  topologyPanelError: null,
  topologyPanelOpen: false,
  topologyGlueEditor: null,
};

export const createTopologySlice: StateCreator<MazeStore, [], [], TopologyState & TopologyActions> = (set, get) => ({
  ...initialTopologyState,

  setTopologyHover: (hover) => set({ topologyHover: hover }),

  setSeamHover: (hover) => set({ seamHover: hover }),

  setTopologySideHover: (hover) => set({ topologySideHover: hover }),

  setTopologyFlagged: (sides) => {
    if (sides.length === 0 && get().topologyFlagged.length === 0) return;
    set({ topologyFlagged: sides });
  },

  setTopologyFaceHover: (hover) => {
    const current = get().topologyFaceHover;
    if (current?.contour === hover?.contour && current?.face === hover?.face) return;
    set({ topologyFaceHover: hover });
  },

  openTopologyGlueEditor: (glueId) => {
    const state = get();
    const topology = state.floorTopology[state.activeFloorId];
    const glue = glueId === undefined ? undefined : topology?.groups.find((group) => group.id === glueId);
    if (glueId === undefined || !topology || !glue) {
      set({ ...CLEARED_EDITOR, topologyGlueEditor: { mode: "add" }, topologyTwist: false, topologyGlueError: null });
      return;
    }
    // An untwisted glue meets a[i] with b[n-1-i] (see core glue_folds), so run B in run order is
    // the folds B sides reversed; a twisted one keeps their order.
    const folds = glue.folds.map((index) => topology.folds[index]);
    const twist = folds[0]?.twist === true;
    // The run order below holds for one twist per glue; a mixed glue (only a hand-made file has
    // one) cannot be shown as two runs.
    if (folds.some((fold) => fold.twist !== twist)) {
      set({ topologyPanelError: { code: "inconsistent", message: `glue ${glueId + 1} mixes twisted and untwisted pairs` } });
      return;
    }
    const sidesB = folds.map((fold) => fold.b);
    set({
      ...CLEARED_EDITOR,
      topologyGlueEditor: { mode: "edit", glueId },
      topologyRunA: { faces: folds.map((fold) => fold.a) },
      topologyRunB: { faces: twist ? sidesB : [...sidesB].reverse() },
      topologyTwist: twist,
      topologyGlueError: null,
    });
  },

  closeTopologyGlueEditor: () => set({ topologyGlueEditor: null, topologyTwist: false, ...CLEARED_EDITOR }),

  setTopologyPanelOpen: (open) => set(open ? { topologyPanelOpen: true } : { topologyPanelOpen: false, topologyPanelError: null, topologyGlueEditor: null, ...CLEARED_EDITOR }),

  startTopologyPick: (target) => set(target === null
    ? { topologyPick: null, topologyFaceHover: null }
    // Editing a run starts it afresh: the sides it already holds are dropped.
    : { topologyPick: target, [target === "a" ? "topologyRunA" : "topologyRunB"]: null, topologyGlueError: null }),

  setTopologyRun: (target, selection) => set({ [target === "a" ? "topologyRunA" : "topologyRunB"]: selection, topologyGlueError: null }),

  clearTopologyRuns: () => set({ ...CLEARED_EDITOR }),

  setTopologyTwist: (twist) => set({ topologyTwist: twist }),

  applyTopologyOp: (op) => {
    const state = get();
    if (state.backgroundAutoFillPreview !== null) return;
    if (state.mazeDirty || state.postEditDirty) {
      set({ fieldEditConfirmation: { kind: "applyTopologyOp", op } });
      return;
    }
    const floorId = state.activeFloorId;
    let topology;
    try {
      topology = editTopology(floorTopologyRequest(state, floorId), op).topology;
    } catch (error) {
      const problem = error instanceof TopologyError ? error.problem : { code: "internal" as const, message: error instanceof Error ? error.message : String(error) };
      set(op.kind === "glue" ? { topologyGlueError: problem } : { topologyPanelError: problem });
      return;
    }
    // Changing the set of active folds discards the maze and analytics, like a tessellation kind
    // change does (Specs/topology.md, "Web authoring").
    const { [floorId]: _previous, ...others } = state.floorTopology;
    set({
      floorTopology: topology.folds.length === 0 ? others : { ...others, [floorId]: topology },
      ...withActiveFloorField(state, { fieldDirty: true }),
      topologyGlueError: null,
      topologyPanelError: null,
      topologyGlueEditor: null,
      ...CLEARED_EDITOR,
      ...buildResetDownstreamState(),
      debugStale: debugStaleOf(state),
    });
  },

  confirmTopologyGlue: () => {
    const state = get();
    const run = pickedRuns(state);
    if (!run) return;
    const editor = state.topologyGlueEditor;
    // The glue being edited was removed meanwhile (e.g. by a confirmed field edit): nothing to replace.
    if (editor?.mode === "edit" && !state.floorTopology[state.activeFloorId]?.groups.some((group) => group.id === editor.glueId)) {
      state.closeTopologyGlueEditor();
      return;
    }
    state.applyTopologyOp({ kind: "glue", a: run.a, b: run.b, twist: state.topologyTwist, ...(editor?.mode === "edit" ? { replace: editor.glueId } : {}) });
  },

  removeTopologyGroup: (id) => get().applyTopologyOp({ kind: "remove_group", id }),
});

/** The two picked runs as boundary faces, or `null` while either is incomplete. */
function pickedRuns(state: MazeStore): { a: WireFoldEnd[]; b: WireFoldEnd[] } | null {
  const result = floorTopologyInfo(state, state.activeFloorId);
  if (!result.ok) return null;
  const a = selectionRun(state.topologyRunA, result.info.contours);
  const b = selectionRun(state.topologyRunB, result.info.contours);
  return a && b ? { a, b } : null;
}
