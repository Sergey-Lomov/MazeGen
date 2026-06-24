import type { StateCreator } from "zustand";
import { computeAnalytics } from "../../wasm/mazeService";
import type { PostEditEdgeWasmDto } from "../../wasm/types";
import { applyPostEditEdgeTool, buildPostEditDraftEdgesFromGenerated } from "../../pixi/postEditUtils";
import type { MazeStore, PostEditState, PostEditActions, PostEditTool } from "../storeTypes";
import { fieldConfigToWasm, activeChecksOf } from "./generationSlice";

export const createPostEditSlice: StateCreator<MazeStore, [], [], PostEditState & PostEditActions> = (set, get) => ({
  postEditAutoConfirm: true,
  postEditTool: "wall" as PostEditTool,
  postEditDraftEdges: null,
  postEditDraftMeta: null,
  postEditEdges: null,
  postEditMeta: null,
  postEditAnalytics: null,
  _postEditRequestId: 0,
  _generatedStart: null,
  _generatedFinish: null,
  postEditDirty: false,

  setPostEditAutoConfirm: (v) => set({ postEditAutoConfirm: v }),
  setPostEditTool: (tool) => set({ postEditTool: tool }),

  applyPostEditTool: (edgeKey, from_, to_) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      return {
        postEditDraftEdges: applyPostEditEdgeTool(
          state.postEditDraftEdges,
          state.postEditTool,
          edgeKey,
          from_,
          to_,
          state.edges,
        ),
        postEditDirty: true,
      };
    });
  },

  confirmPostEdit: async () => {
    const requestId = get()._postEditRequestId + 1;
    set({ _postEditRequestId: requestId });

    const state = get();
    const { postEditDraftEdges, postEditDraftMeta, activeTessellationConfig, nodes, start, finish, selectedChecks, checkParams } = state;
    if (postEditDraftEdges === null) return;
    const edgesSnapshot = postEditDraftEdges;
    const metaSnapshot = postEditDraftMeta;

    const effectiveStart = postEditDraftMeta != null ? postEditDraftMeta.start : start;
    const effectiveFinish = postEditDraftMeta != null ? postEditDraftMeta.finish : finish;

    const wasmEdges: PostEditEdgeWasmDto[] = Object.values(postEditDraftEdges)
      .filter(e => e.kind !== "wall")
      .map(e => ({
        from: e.from,
        to: e.to,
        kind: e.kind === "basic" ? "basic" as const : "one_way" as const,
      }));

    const config = {
      tessellation: fieldConfigToWasm(activeTessellationConfig),
      nodes: nodes.map(n => [n.x, n.y] as [number, number]),
      edges: wasmEdges,
      start: effectiveStart ?? null,
      finish: effectiveFinish ?? null,
      checks: activeChecksOf({ selectedChecks, rules: state.rules }),
      check_params: checkParams,
    };

    try {
      const snapshot = computeAnalytics(config);
      if (get()._postEditRequestId !== requestId) return;
      set((state) => ({
        postEditAnalytics: {
          nodeStats: snapshot.node_stats,
          edgeStats: snapshot.edge_stats,
          routeInfo: snapshot.route_info,
          navNodes: snapshot.nav_nodes,
          navEdges: snapshot.nav_edges,
          graphAnalytics: snapshot.graph_analytics,
          issues: snapshot.issues,
        },
        postEditEdges: edgesSnapshot,
        postEditMeta: metaSnapshot,
        showRouteOverlay: snapshot.route_info != null ? state.showRouteOverlay : false,
      }));
    } catch (err) {
      if (get()._postEditRequestId !== requestId) return;
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  resetPostEdit: () => {
    set((state) => ({
      postEditDraftEdges: buildPostEditDraftEdgesFromGenerated(state.edges),
      postEditEdges: null,
      postEditMeta: null,
      postEditAnalytics: null,
      postEditDraftMeta: { start: state._generatedStart, finish: state._generatedFinish },
      postEditTool: "wall" as PostEditTool,
      postEditDirty: false,
    }));
    void get().confirmPostEdit();
  },

  setPostEditEndpoint: (kind, nodeId) => {
    set((state) => ({
      postEditDraftMeta: { ...(state.postEditDraftMeta ?? { start: state.start, finish: state.finish }), [kind]: nodeId },
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
  clearPostEditEndpoint: (kind) => {
    set((state) => ({
      postEditDraftMeta: { ...(state.postEditDraftMeta ?? { start: state.start, finish: state.finish }), [kind]: null },
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
});
