import { useMazeStore } from "../store/mazeStore";
import { selectDebugMazeView } from "../store/debugSelectors";
import { buildCellInspection } from "./selectors/mazeSelectors";
import { buildPresetCellInspection } from "./selectors/presetCellInspection";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FeatureId } from "../store/tessellationTypes";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** Which node/edge set represents "the current maze" for cell-inspection purposes, per open card
 *  (GitHub issue #353) — mirrors `TESSELLATION_CONFIG_BY_CARD`'s per-card table in `MazeScene.ts`.
 *  Generation reads `_generatedNodes`/`_generatedEdges` (its own frozen snapshot, unaffected by
 *  post-edit — see `GenerationRenderer`'s identical doc comment on why), or the live debug-replay
 *  view while a debug session is stepping through it, so the inspector always matches what's drawn
 *  on screen. Every other maze-bearing card (post-edit, analytics, image export) reads
 *  `state.nodes`/`state.edges` — the confirmed post-edit graph. Cards with no maze of their own
 *  (tessellation/field setup/quality/basic config) return `null` — the inspector then only ever
 *  prints bare coordinates, never a marker line. Preset Connections has its own pre-generation
 *  data model and is handled separately by `resolveCellInspection`, not through this function. */
type MazeSource = { nodeById: Map<number, NodeDto>; edges: EdgeDto[]; start: number | null; finish: number | null } | null;

function resolveMazeSource(st: MazeState): MazeSource {
  if (st.openCard === "generation") {
    const debugView = st.debugMode ? selectDebugMazeView(st.debugArena, st.debugStep) : null;
    const nodes = debugView ? debugView.nodes : st._generatedNodes;
    const edges = debugView ? debugView.edges : st._generatedEdges;
    const start = debugView ? debugView.start : st.start;
    const finish = debugView ? debugView.finish : st.finish;
    return { nodeById: new Map(nodes.map((n) => [n.id, n])), edges, start, finish };
  }
  if (st.openCard === "post_edit" || st.openCard === "analytics" || st.openCard === "image_export") {
    return { nodeById: new Map(st.nodes.map((n) => [n.id, n])), edges: st.edges, start: st.start, finish: st.finish };
  }
  return null;
}

const CARDS_WITH_MAZE: ReadonlySet<FeatureId> = new Set(["generation", "post_edit", "analytics", "image_export"]);

/** Builds the cell-inspector status-bar text for grid cell `(x, y)` under the current hover,
 *  reading whichever node/edge set `resolveMazeSource` says represents the open card's own maze.
 *  Returns bare `"x:N, y:N"` for a card with no maze in scope, mirroring `buildCellInspection`'s
 *  own empty-cell fallback so `HoverInfoPanel` never needs a separate no-maze branch.
 *
 *  Preset Connections is handled separately (`buildPresetCellInspection`) since that stage has no
 *  `NodeDto`/`EdgeDto` graph yet — a distinct pre-generation state shape, not a `MazeSource`. */
export function resolveCellInspection(st: MazeState, x: number, y: number): string {
  const activeFloorIndex = Math.max(st.floors.findIndex((f) => f.id === st.activeFloorId), 0);

  if (st.openCard === "preset_connections") {
    return buildPresetCellInspection(
      x, y, activeFloorIndex,
      st.presetSplitPoints, st.presetStart, st.presetFinish, st.presetGenSource,
      st.presetTeleports, st.presetVerticalPassages, st.presetElevators,
      st.lockedNodes, st.autoLockedNodes,
    );
  }

  if (!CARDS_WITH_MAZE.has(st.openCard)) return `x:${x}, y:${y}`;
  const source = resolveMazeSource(st);
  if (!source) return `x:${x}, y:${y}`;
  return buildCellInspection(source.nodeById, source.edges, x, y, activeFloorIndex, source.start, source.finish);
}
