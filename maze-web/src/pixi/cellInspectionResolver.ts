import { useMazeStore } from "../store/mazeStore";
import { selectDebugMazeView } from "../store/debugSelectors";
import { buildCellInspection, postEditEdgesToDto } from "./selectors/mazeSelectors";
import { buildPresetCellInspection } from "./selectors/presetCellInspection";
import { presetConnectionsOnLevel } from "./fieldEditUtils";
import { buildActiveCells } from "./selectors/fieldSelectors";
import { buildCellSet } from "./selectors/sharedSelectors";
import { pruneRemovedSplitNodes, postEditVerticalToDto } from "./postEditUtils";
import { postEditTeleportsToDto } from "./postEditTeleportUtils";
import { buildSplitNodeResolver, resolveEndpoint } from "./postEditEndpoint";
import { buildMultiFloorPointNodeMap } from "../store/slices/postEditSliceHelpers";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FeatureId } from "../store/tessellationTypes";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** Which node/edge set represents "the current maze" for cell-inspection purposes, per open card
 *  (GitHub issue #353) — mirrors `TESSELLATION_CONFIG_BY_CARD`'s per-card table in `MazeScene.ts`.
 *  Generation reads `_generatedNodes`/`_generatedEdges` (its own frozen snapshot, unaffected by
 *  post-edit — see `GenerationRenderer`'s identical doc comment on why), or the live debug-replay
 *  view while a debug session is stepping through it, so the inspector always matches what's drawn
 *  on screen. Post-edit reads its live *draft* state (`buildPostEditMazeSource`) so the readout
 *  tracks what the post-edit canvas draws, including edits not yet confirmed (GitHub issue #488) —
 *  `state.nodes`/`state.edges` alone is the last *confirmed* graph, and `state.start`/`state.finish`
 *  is never updated by post-edit at all (start/finish moves live in `postEditDraftMeta`). Analytics
 *  and image export read the confirmed `state.nodes`/`state.edges` — those cards show the confirmed
 *  graph, not the draft — with start/finish resolved through `postEditMeta` (`resolveConfirmedEndpoints`),
 *  the same confirmed-endpoint fallback their renderers use (GitHub issue #303). Cards with no maze
 *  of their own (tessellation/field setup/quality/basic
 *  config) return `null` — the inspector then only ever prints bare coordinates, never a marker
 *  line. Preset Connections has its own pre-generation data model and is handled separately by
 *  `resolveCellInspection`, not through this function. */
type MazeGraph = { nodeById: Map<number, NodeDto>; edges: EdgeDto[]; start: number | null; finish: number | null };
type MazeSource = MazeGraph | null;

/** The currently effective confirmed start/finish node ids — `postEditMeta`'s endpoints once
 *  post-edit has confirmed at least once, else the as-generated `state.start`/`state.finish`.
 *  `confirmPostEdit` never writes `state.start`/`state.finish` back, so reading those directly
 *  reports a moved start/finish marker on its pre-move cell (GitHub issue #303 fixed this for the
 *  image-export renderer, issue #488 for the post-edit inspector — Analytics/image-export inspectors
 *  need the same fallback since their renderers already draw start/finish this way). Mirrors
 *  `resolveEffectiveEndpoints` in `imageExport/exportStyleBuilders.ts` (kept as its own copy here
 *  rather than importing across the pixi-core → export-feature boundary). */
function resolveConfirmedEndpoints(st: MazeState): { start: number | null; finish: number | null } {
  const pointNodeMap = buildMultiFloorPointNodeMap(st.nodes);
  const resolveSplit = buildSplitNodeResolver(pointNodeMap, st.postEditDraftSplitPoints);
  const startEp = st.postEditMeta != null ? st.postEditMeta.start : (st.start !== null ? { kind: "node" as const, id: st.start } : null);
  const finishEp = st.postEditMeta != null ? st.postEditMeta.finish : (st.finish !== null ? { kind: "node" as const, id: st.finish } : null);
  return {
    start: startEp !== null ? resolveEndpoint(startEp, resolveSplit) ?? null : null,
    finish: finishEp !== null ? resolveEndpoint(finishEp, resolveSplit) ?? null : null,
  };
}

/** Rebuilds the post-edit maze graph from its live draft state — the same unscoped derivation
 *  `PostEditRenderer.redrawAll` uses to draw the canvas, so the cell inspector matches it exactly
 *  (GitHub issue #488). `state.nodes`/`state.edges` is only the last *confirmed* snapshot (frozen
 *  between confirms when auto-confirm is off), and `state.start`/`state.finish` is never written
 *  back by post-edit at all — so reading those directly made the status bar report generation-time
 *  markers for a cell the user had since edited.
 *
 *  Draft basic/wall edges are folded in for completeness but don't affect the inspector's output
 *  (it only reads nodes + start/finish + teleport/vertical/elevator markers). Draft split slots
 *  added but never confirmed aren't in `state.nodes` yet and so don't resolve — same limitation the
 *  renderer has. Generation-time vertical passages / elevators are full baseline draft entries
 *  (GitHub issue #564) — `postEditDraftVerticalPassages`/`postEditDraftElevators` already cover
 *  them, no separate `_generatedEdges` resend needed. */
export function buildPostEditMazeSource(st: MazeState): MazeGraph {
  const prunedNodes = pruneRemovedSplitNodes(st.nodes, st.postEditDraftSplitPoints, (n) => {
    const level = n.level ?? 0;
    return level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
  });
  const resolveSplit = buildSplitNodeResolver(buildMultiFloorPointNodeMap(prunedNodes), st.postEditDraftSplitPoints);

  const draftVerticalEdges = postEditVerticalToDto(st.postEditDraftVerticalPassages, st.postEditDraftElevators, resolveSplit);

  const edges: EdgeDto[] = [
    ...postEditEdgesToDto(st.postEditDraftEdges, resolveSplit),
    ...postEditTeleportsToDto(st.postEditDraftTeleports, resolveSplit),
    ...draftVerticalEdges,
  ];

  // Draft start/finish overrides (`postEditDraftMeta`); when no draft meta exists yet, fall back
  // to the confirmed `state.start`/`state.finish` the same way `PostEditRenderer`'s own draft-meta
  // default does.
  const meta = st.postEditDraftMeta;
  const start = meta != null
    ? (meta.start != null ? resolveEndpoint(meta.start, resolveSplit) ?? null : null)
    : st.start;
  const finish = meta != null
    ? (meta.finish != null ? resolveEndpoint(meta.finish, resolveSplit) ?? null : null)
    : st.finish;

  return { nodeById: new Map(prunedNodes.map((n) => [n.id, n])), edges, start, finish };
}

function resolveMazeSource(st: MazeState): MazeSource {
  if (st.openCard === "generation") {
    const debugView = st.debugMode ? selectDebugMazeView(st.debugArena, st.debugStep) : null;
    const nodes = debugView ? debugView.nodes : st._generatedNodes;
    const edges = debugView ? debugView.edges : st._generatedEdges;
    const start = debugView ? debugView.start : st.start;
    const finish = debugView ? debugView.finish : st.finish;
    return { nodeById: new Map(nodes.map((n) => [n.id, n])), edges, start, finish };
  }
  if (st.openCard === "post_edit") {
    return buildPostEditMazeSource(st);
  }
  if (st.openCard === "analytics" || st.openCard === "image_export") {
    const { start, finish } = resolveConfirmedEndpoints(st);
    return { nodeById: new Map(st.nodes.map((n) => [n.id, n])), edges: st.edges, start, finish };
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
    const field = st.floorFields[st.activeFloorId];
    const cfg = field.tessellationConfig;
    const level = activeFloorIndex === 0 ? undefined : activeFloorIndex;
    const inFieldCells = buildCellSet(buildActiveCells(field.fieldPoints, field.fieldEditMode, cfg));
    const presetConnections = presetConnectionsOnLevel(st.presetConnections, level);
    return buildPresetCellInspection(
      x, y, activeFloorIndex,
      st.presetSplitPoints, st.presetStart, st.presetFinish, st.presetGenSource,
      st.presetTeleports, st.presetVerticalPassages, st.presetElevators,
      st.lockedNodes, st.autoLockedNodes,
      cfg, inFieldCells, presetConnections,
    );
  }

  if (!CARDS_WITH_MAZE.has(st.openCard)) return `x:${x}, y:${y}`;
  const source = resolveMazeSource(st);
  if (!source) return `x:${x}, y:${y}`;
  return buildCellInspection(source.nodeById, source.edges, x, y, activeFloorIndex, source.start, source.finish, st.activeTessellationConfig);
}
