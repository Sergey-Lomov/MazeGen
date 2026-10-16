import { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, endpointKey, edgeKey,
  resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint, resolveEndpointToHoverPoint,
  buildLogicalCandidates, resolvePartnerForPlacement,
} from "../../pixi/postEditEndpoint";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { splitNodeSemanticNames } from "../../pixi/splitNodeNames";
import { cairoCanonicalFaceOrder } from "../../pixi/cairoGeometry";
import { postEditTargetLabel, type SplitLabelContext } from "../../pixi/postEditSplitLabels";
import { formatTargetLabel } from "../../pixi/targetLabel";
import { activeFloorLevel } from "../../store/storeHelpers";
import { recordOnLevel } from "../../pixi/fieldEditUtils";
import { rotateSplitPointBreaksNeighborShape } from "../../pixi/postEditUtils";
import { SplitNodesDialogView, createRequiredLinksTracker, splitNodeLabel, type LinkInfo, type SplitEdgeKind, type ElementInfo } from "./SplitNodesDialogView";
import { buildPostEditPointEntities } from "../../pixi/postEditPointEntities";
import type { TileFace, TileFaceKind } from "./TileFaceEditor";
import { resolveActiveSplitEndpoint, splitPointKey, useSplitDialogFieldCells, useSplitNodesDialogOrchestration } from "./splitNodesOrchestration";
import * as m from "~/paraglide/messages";

interface Props {
  point: [number, number];
  onClose: () => void;
}

const AVAILABLE_KINDS: SplitEdgeKind[] = ["passage", "one_way", "wall"];

/** Post-edit adapter for `SplitNodesDialogView` (GitHub issue #221, tile+table layout added for
 * #234) — manages a split point's extra nodes and picks which one edge-tool clicks on the point's
 * faces currently target. Builds rows/labels/links from `nodes`/`postEditDraftEdges`/
 * `postEditDraftTeleports` (resolved `NodeId`s, since post-edit runs after generation) and
 * delegates layout/remove-confirmation to the shared view. */
export function ManageSplitNodesDialog({ point, onClose }: Props) {
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.postEditActiveSplitNode);
  const addSplitNode = useMazeStore((s) => s.addSplitNode);
  const removeSplitNode = useMazeStore((s) => s.removeSplitNode);
  const setActiveSplitNode = useMazeStore((s) => s.setActiveSplitNode);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const draftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const draftVerticalPassages = useMazeStore((s) => s.postEditDraftVerticalPassages);
  const draftElevators = useMazeStore((s) => s.postEditDraftElevators);
  const draftMeta = useMazeStore((s) => s.postEditDraftMeta);
  const allNodes = useMazeStore((s) => s.nodes);
  const level = useMazeStore(activeFloorLevel);
  // Post-edit is floor-aware (GitHub issue #358) — `s.nodes` can span every floor, so this
  // dialog's own point-keyed lookups (`pointNodeMap`, `originalNodeId`, `resolveActiveAt`) are
  // scoped to the active floor's own nodes first, same as `PostEditController`'s `getFloorNodes`.
  const nodes = useMemo(() => allNodes.filter((n) => (n.level ?? 0) === (level ?? 0)), [allNodes, level]);
  const cfg = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldConfig);
  const fieldPoints = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.floorFields[s.activeFloorId].fieldEditMode);
  const floorFields = useMazeStore((s) => s.floorFields);
  const floors = useMazeStore((s) => s.floors);
  const applyPostEditToolAt = useMazeStore((s) => s.applyPostEditToolAt);
  const rotateSplitPoint = useMazeStore((s) => s.rotateSplitPoint);
  const setPostEditHoveredEntity = useMazeStore((s) => s.setPostEditHoveredEntity);
  const setPostEditChangesOpen = useMazeStore((s) => s.setPostEditChangesOpen);
  const setPostEditChangesEntityFilter = useMazeStore((s) => s.setPostEditChangesEntityFilter);
  const applySplitBlueprint = useMazeStore((s) => s.applySplitBlueprint);
  const setPostEditFocusedPointCovered = useMazeStore((s) => s.setPostEditFocusedPointCovered);

  const [activeKind, setActiveKind] = useState<SplitEdgeKind>("passage");

  const key = splitPointKey(point, level);
  const slots = useMemo(() => [...(splitPoints[key] ?? [])].sort((a, b) => a - b), [splitPoints, key]);
  const inFieldCells = useSplitDialogFieldCells(fieldPoints, fieldEditMode, cfg);
  const splitLabelContext: SplitLabelContext = {
    allNodes,
    splitPoints,
    activeSplitNode,
    draftEdges: draftEdges ?? null,
    cfgAt: (rawLevel) => {
      const floor = floorFields[floors[rawLevel ?? 0]?.id ?? ""];
      return floor ? floor.fieldConfig : cfg;
    },
    inFieldCellsAt: (rawLevel) => {
      const floor = floorFields[floors[rawLevel ?? 0]?.id ?? ""];
      if (!floor) return inFieldCells;
      return buildCellSet(buildActiveCells(floor.fieldPoints, floor.fieldEditMode, floor.fieldConfig));
    },
  };

  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);
  const pointNodeMap = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const n of nodes) {
      const k = `${n.x},${n.y}`;
      const list = m.get(k);
      if (list) list.push(n.id); else m.set(k, [n.id]);
    }
    return m;
  }, [nodes]);
  const levelSplitPoints = useMemo(() => recordOnLevel(splitPoints, level), [splitPoints, level]);
  const resolveSplit = useMemo(() => buildSplitNodeResolver(pointNodeMap, levelSplitPoints), [pointNodeMap, levelSplitPoints]);
  const floorNodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  // Two endpoints are "the same link" if they resolve to the same real `NodeId` — a plain `node`
  // endpoint and a `split` endpoint can both resolve to the same id (GitHub issue #222: an
  // auto-split node already has a real id right after generation, but `draftEdges`/`draftMeta`
  // only ever carry plain `node` endpoints, built straight from wasm's `NodeId`s — see
  // `buildPostEditDraftEdgesFromGenerated`). Falls back to structural equality when either side
  // doesn't resolve yet (a freshly `addSplitNode`-added slot has no real id until the next
  // confirm — see `resolveEndpoint`'s doc comment).
  //
  // `a`/`b` can come straight from the store (`draftEdges`/`draftTeleports`/`draftMeta`), which is
  // maze-wide and can carry a split endpoint's original non-zero `level`, while `resolveSplit`
  // above is built from a bare-keyed `levelSplitPoints`/`pointNodeMap` already scoped to this
  // floor — resolving a level-tagged endpoint against it silently returns `undefined` on any floor
  // above the first (GitHub issue #425). `floorScopedEndpoint` strips `level` after confirming the
  // endpoint belongs to this floor; an off-floor endpoint is left as-is and correctly fails to
  // resolve, falling back to structural equality below (which will not match a same-point
  // different-floor endpoint, since `endpointsEqual` compares `level` too).
  const endpointsMatch = (a: PostEditEndpoint, b: PostEditEndpoint): boolean => {
    const ra = resolveEndpoint(floorScopedEndpoint(a, level, floorNodeIds) ?? a, resolveSplit);
    const rb = resolveEndpoint(floorScopedEndpoint(b, level, floorNodeIds) ?? b, resolveSplit);
    if (ra !== undefined && rb !== undefined) return ra === rb;
    return endpointsEqual(a, b);
  };
  // Every real node at this point, in snapshot order (index 0 is always the point's original
  // node — see `Field::nodes_at`/`all_cells`'s contract, mirrored by `PostEditController`'s
  // `buildNodeMap`). Needed to resolve the original node's real `NodeId` — it's a graph node id
  // like any other, nothing about the point's coordinates.
  const originalNodeId = useMemo(() => {
    for (const n of nodes) if (n.x === point[0] && n.y === point[1]) return n.id;
    return undefined;
  }, [nodes, point]);
  const originalEndpoint: PostEditEndpoint | null = originalNodeId !== undefined ? nodeEndpoint(originalNodeId) : null;
  const nodeLevelOf = (ep: PostEditEndpoint): number => ep.kind === "node" ? (nodeById.get(ep.id)?.level ?? 0) : (ep.level ?? 0);
  // Cross-floor bubble for a vertical-passage/elevator partner (GitHub issue #602) — always shows
  // the floor (the point's `(x, y)` never disambiguates floors on its own, unlike a same-floor
  // link's `describeEndpoint`), via the shared `postEditTargetLabel`.
  const floorNodeLabel = (ep: PostEditEndpoint): string => postEditTargetLabel(splitLabelContext, ep, nodeById, true);

  const entityOriginal = nodes.find((n) => n.x === point[0] && n.y === point[1]);
  const entityNodes: PostEditEndpoint[] = entityOriginal
    ? [nodeEndpoint(entityOriginal.id), ...slots.map((slotId) => splitEndpoint(point, slotId, level))]
    : [];
  const pointElements = buildPostEditPointEntities(
    entityNodes, slots,
    {
      postEditDraftSplitPoints: splitPoints,
      postEditDraftMeta: draftMeta, postEditDraftTeleports: draftTeleports,
      postEditDraftVerticalPassages: draftVerticalPassages, postEditDraftElevators: draftElevators,
      nodeLevel: (ep) => ep.kind === "node" ? (nodeById.get(ep.id)?.level ?? 0) : (ep.level ?? 0),
      nodeById, multiFloor: new Set(nodes.map((n) => n.level ?? 0)).size > 1, splitCtx: splitLabelContext,
    },
  );
  const elementsFor = (ep: PostEditEndpoint): ElementInfo<PostEditEndpoint>[] => {
    const elements = pointElements
    .filter((e) => ["start", "finish", "teleport", "vertical_passage", "elevator"].includes(e.kind) && endpointsMatch(e.endpoint, ep))
    .map((e) => ({
      title: e.title,
      entityId: e.entityId,
      bubbles: e.kind === "start" || e.kind === "finish" ? [] : e.kind === "vertical_passage"
        ? (() => { const v = draftVerticalPassages.find((entry) => entry.id === e.id); const other = v ? (endpointsMatch(v.from, ep) ? v.to : v.from) : undefined; return other ? [floorNodeLabel(other)] : []; })()
        : e.kind === "elevator"
          ? (() => { const elevator = draftElevators.find((entry) => entry.id === e.id); return elevator ? elevator.floors.filter((floor) => !endpointsMatch(floor, ep)).map(floorNodeLabel) : []; })()
        : e.bubbles.slice(1).map((b) => b.text),
      bubbleFloors: e.kind === "teleport" ? (draftTeleports.find((t) => t.id === e.id) ? (() => { const t = draftTeleports.find((t) => t.id === e.id)!; const other = endpointsMatch(t.from, ep) ? t.to : t.from; return [nodeLevelOf(other)]; })() : undefined)
        : e.kind === "vertical_passage" ? (draftVerticalPassages.find((v) => v.id === e.id) ? (() => { const v = draftVerticalPassages.find((v) => v.id === e.id)!; const other = endpointsMatch(v.from, ep) ? v.to : v.from; return [nodeLevelOf(other)]; })() : undefined)
        : e.kind === "elevator" ? draftElevators.find((v) => v.id === e.id)?.floors.filter((floor) => !endpointsMatch(floor, ep)).map(nodeLevelOf)
        : undefined,
      showArrow: e.showArrow, arrow: e.arrow,
      hoverEndpoints: e.kind === "teleport" ? (draftTeleports.find((t) => t.id === e.id) ? (() => { const t = draftTeleports.find((t) => t.id === e.id)!; return endpointsMatch(t.from, ep) ? [t.from, t.to] : [t.to, t.from]; })() : undefined)
        : e.kind === "vertical_passage" ? (draftVerticalPassages.find((v) => v.id === e.id) ? (() => { const v = draftVerticalPassages.find((v) => v.id === e.id)!; return endpointsMatch(v.from, ep) ? [v.from, v.to] : [v.to, v.from]; })() : undefined)
        : e.kind === "elevator" ? draftElevators.find((v) => v.id === e.id)?.floors : undefined,
    }));
    if (draftMeta?.start && endpointsMatch(draftMeta.start, ep) && !elements.some((e) => e.title === m["status.cell_start"]())) {
      elements.unshift({ title: m["status.cell_start"](), entityId: undefined, bubbles: [], bubbleFloors: undefined, showArrow: false, arrow: "->", hoverEndpoints: undefined });
    }
    if (draftMeta?.finish && endpointsMatch(draftMeta.finish, ep) && !elements.some((e) => e.title === m["status.cell_finish"]())) {
      elements.unshift({ title: m["status.cell_finish"](), entityId: undefined, bubbles: [], bubbleFloors: undefined, showArrow: false, arrow: "->", hoverEndpoints: undefined });
    }
    return elements;
  };

  // Resolves which of a (possibly split) point's nodes is currently active — the point's own
  // rule for `key`'s point when it's the dialog's own point, or the point's active-map entry
  // (falling back to its original node) for any other point (e.g. a neighbor across a tile face).
  const resolveActiveAt = (p: [number, number]): PostEditEndpoint | null => {
    const pKey = level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
    const ids: number[] = [];
    for (const n of nodes) if (n.x === p[0] && n.y === p[1]) ids.push(n.id);
    if (ids.length === 0) return null;
    const activeEntry = useMazeStore.getState().postEditActiveSplitNode[pKey];
    return activeEntry ?? nodeEndpoint(ids[0]);
  };

  // Which of a (possibly split) neighbor point's nodes actually connects back to `endpoint` — a
  // thin wrapper over the shared `resolvePartnerForPlacement` (GitHub issue #580): tries every real
  // node at `p` for a decided/wall edge with `endpoint` before falling back to the neighbor's
  // active UI slot, so a neighbor that's itself split doesn't get checked against the wrong one of
  // its nodes.
  const resolveConnectedNeighborAt = (p: [number, number], endpoint: PostEditEndpoint): PostEditEndpoint | null => {
    if (!draftEdges) return resolveActiveAt(p);
    const ids: number[] = [];
    for (const n of nodes) if (n.x === p[0] && n.y === p[1]) ids.push(n.id);
    if (ids.length === 0) return null;
    const pSlots = recordOnLevel(splitPoints, level)[`${p[0]},${p[1]}`] ?? [];
    const candidates = buildLogicalCandidates(p, ids, pSlots, level);
    const result = resolvePartnerForPlacement([endpoint], candidates, draftEdges, activeSplitNode, p, level);
    return result?.endpoint ?? null;
  };

  // Faces of one node (any row, not just the active one) — used both to build `tileNodes` (all of
  // the point's nodes drawn on the tile diagram at once, GitHub issue #234) and to recognize a
  // named special-split topology for `semanticNames` below.
  const facesOf = (endpoint: PostEditEndpoint): TileFace[] => {
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    return offsets.map(([dx, dy]) => {
      const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
      const boundary = !inFieldCells.has(`${neighbor[0]},${neighbor[1]}`);
      if (boundary) return { kind: "wall" as TileFaceKind, boundary };
      if (!draftEdges) return { kind: "wall" as TileFaceKind, boundary };

      const neighborActive = resolveConnectedNeighborAt(neighbor, endpoint);
      if (!neighborActive) return { kind: "wall" as TileFaceKind, boundary: false };

      const fwd = draftEdges[edgeKey(endpoint, neighborActive)];
      const bwd = draftEdges[edgeKey(neighborActive, endpoint)];
      let kind: TileFaceKind = "wall";
      if (fwd?.kind === "basic" || bwd?.kind === "basic") kind = "passage";
      else if (fwd?.kind === "one_way_forward" || fwd?.kind === "one_way_backward") kind = "one_way_out";
      else if (bwd?.kind === "one_way_forward" || bwd?.kind === "one_way_backward") kind = "one_way_in";
      else if (fwd?.kind === "wall" || bwd?.kind === "wall") kind = "wall";
      return { kind, boundary: false };
    });
  };

  // Node endpoints in row order (original node first, then each slot in slotId order) — the same
  // order `rows` and `tileNodes` use.
  const nodeEndpointsInOrder: PostEditEndpoint[] = [
    ...(originalEndpoint ? [originalEndpoint] : []),
    ...slots.map((slotId) => splitEndpoint(point, slotId, level)),
  ];
  // Semantic per-node names when this point's current face configuration matches a recognized
  // special-split topology (GitHub issue #487) — `null` otherwise, falling back to "Node N".
  const semanticNames = splitNodeSemanticNames(
    nodeEndpointsInOrder.map((ep) => ({ faces: facesOf(ep) })),
    cfg.tessellation.kind === "cairo" ? cairoCanonicalFaceOrder(point[0], point[1]) : undefined,
  );
  // Formats one side of a link bubble — used for both the card's own endpoint and its partner, so
  // every node always gets an "(N{N})" suffix on whichever side it appears on, not just the
  // partner's. A `split` endpoint or this point's original node gets its compact node label
  // (semantic tag when this point is a recognized special split, GitHub issue #487); a plain
  // `node` endpoint elsewhere on the maze (not this point's original node) has no label at all,
  // just its coordinates.
  const describeEndpoint = (ep: PostEditEndpoint): string => postEditTargetLabel(splitLabelContext, ep, nodeById, false);

  // Groups a node's edges/teleports by partner, collapsing a passage's two directed `basic`
  // entries (A->B and B->A — see `applyPostEditEdgeTool`'s "passage" branch, which always writes
  // both) into a single "<->" link instead of showing the same passage twice.
  const links = (ep: PostEditEndpoint): LinkInfo<PostEditEndpoint>[] => {
    const { mark, finalize } = createRequiredLinksTracker(endpointKey, describeEndpoint);
    const forbidden: LinkInfo<PostEditEndpoint>[] = [];
    if (draftEdges) {
      for (const e of Object.values(draftEdges)) {
        if (e.kind === "wall") {
          if (endpointsMatch(e.from, ep)) forbidden.push({ otherLabel: describeEndpoint(e.to), otherEndpoint: e.to, arrow: "->", category: "forbidden" });
          else if (endpointsMatch(e.to, ep)) forbidden.push({ otherLabel: describeEndpoint(e.from), otherEndpoint: e.from, arrow: "<-", category: "forbidden" });
          continue;
        }
        if (endpointsMatch(e.from, ep)) mark(e.to, "out");
        else if (endpointsMatch(e.to, ep)) mark(e.from, "in");
      }
    }
    return [...finalize(), ...forbidden];
  };

  const activeEndpoint = resolveActiveSplitEndpoint(activeSplitNode, key, originalEndpoint);
  const { rows, tileNodes, blueprints } = useSplitNodesDialogOrchestration({
    point, cfg, slots, originalEndpoint, endpointForSlot: (slotId) => splitEndpoint(point, slotId, level),
    endpointKey, activeEndpoint, semanticNames,
    fallbackTitle: (rowIndex) => splitNodeLabel(rowIndex === 0 ? undefined : slots[rowIndex - 1]),
    describeEndpoint, linksFor: links, elementsFor, facesOf,
  });

  // Resolves the real (point-node, neighbor-node) pair a click on `offsetIndex` addresses. The
  // `point` side is always the user's explicitly active node — a click edits whichever node the
  // user selected in the dialog, never a different one of `point`'s own nodes picked by evidence
  // (that would silently retarget the wrong node whenever a non-active node of `point` happened to
  // already have a decided/wall face here). Only the `neighbor` side is resolved by evidence
  // (GitHub issue #580's click-handler counterpart — `resolveActiveAt` alone on the neighbor picked
  // the wrong node whenever the neighbor was itself split and its active slot wasn't the one
  // connected to `point`'s active side).
  const resolveFaceClickPair = (offsetIndex: number): { point: PostEditEndpoint; neighbor: PostEditEndpoint } | null => {
    if (!draftEdges) return null;
    const activeEndpoint = activeSplitNode[key] ?? originalEndpoint;
    if (!activeEndpoint) return null;
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    const [dx, dy] = offsets[offsetIndex];
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    const neighborActive = resolveConnectedNeighborAt(neighbor, activeEndpoint);
    return neighborActive ? { point: activeEndpoint, neighbor: neighborActive } : null;
  };

  const handleFaceClick = (offsetIndex: number) => {
    const pair = resolveFaceClickPair(offsetIndex);
    if (!pair) return;
    const tool = activeKind === "passage" ? "passage" : activeKind === "one_way" ? "one_way" : "wall";
    applyPostEditToolAt(tool, edgeKey(pair.point, pair.neighbor), pair.point, pair.neighbor);
  };

  const handleFaceRightClick = (offsetIndex: number) => {
    const pair = resolveFaceClickPair(offsetIndex);
    if (!pair) return;
    applyPostEditToolAt("wall", edgeKey(pair.point, pair.neighbor), pair.point, pair.neighbor);
  };

  return (
    <SplitNodesDialogView
      title={m["post_edit.manage_split_nodes"]({ coords: formatTargetLabel(point, level ?? 0, floors.length > 1, undefined) })}
      point={point}
      cfg={cfg}
      currentLevel={level ?? 0}
      rows={rows}
      tileNodes={tileNodes}
      availableKinds={AVAILABLE_KINDS}
      activeKind={activeKind}
      onKindChange={setActiveKind}
      onFaceClick={handleFaceClick}
      onFaceRightClick={handleFaceRightClick}
      onClose={() => { setPostEditHoveredEntity(null); onClose(); }}
      onSetActive={(ep) => setActiveSplitNode(point, ep)}
      onAdd={() => addSplitNode(point)}
      onRemove={(row) => { if (row.endpoint.kind === "split") removeSplitNode(point, row.endpoint.slotId); }}
      onRotate={(direction) => rotateSplitPoint(point, direction)}
      wouldBreakNeighborShape={(direction) => draftEdges !== null && rotateSplitPointBreaksNeighborShape(
        draftEdges, point, slots, direction, cfg, inFieldCells, nodes, activeSplitNode, splitPoints, level,
      )}
      onHoverLink={(row, link) => {
        const from = resolveEndpointToHoverPoint(row.endpoint, nodeById);
        const to = resolveEndpointToHoverPoint(link.otherEndpoint, nodeById);
        if (from && to) setPostEditHoveredEntity({ kind: "link", from, to });
      }}
      onUnhoverLink={() => setPostEditHoveredEntity(null)}
      onHoverElement={(_row, element) => {
        const points = element.hoverEndpoints?.map((endpoint) => resolveEndpointToHoverPoint(endpoint, nodeById)).filter((p): p is NonNullable<typeof p> => p !== undefined) ?? [];
        if (points.length > 0) setPostEditHoveredEntity({ kind: "points", points });
      }}
      onUnhoverElement={() => setPostEditHoveredEntity(null)}
      onEntityIdClick={(id) => {
        setPostEditHoveredEntity(null);
        setPostEditChangesEntityFilter(id);
        setPostEditChangesOpen(true);
      }}
      blueprints={blueprints}
      onApplyBlueprint={(blueprint) => applySplitBlueprint(point, blueprint)}
      onTopChange={(isTop) => setPostEditFocusedPointCovered(!isTop)}
    />
  );
}
