import { useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, endpointKey, edgeKey,
  resolveEndpoint, buildSplitNodeResolver,
} from "../../pixi/postEditEndpoint";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { blueprintsForDegree } from "../../pixi/splitBlueprints";
import { SplitNodesDialogView, createRequiredLinksTracker, type SplitNodesRow, type LinkInfo, type SplitEdgeKind } from "./SplitNodesDialogView";
import type { TileFace, TileFaceKind, TileFaceNode } from "./TileFaceEditor";
import * as m from "~/paraglide/messages";

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

interface Props {
  point: [number, number];
  onClose: () => void;
}

const AVAILABLE_KINDS: SplitEdgeKind[] = ["passage", "one_way"];

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
  const draftMeta = useMazeStore((s) => s.postEditDraftMeta);
  const nodes = useMazeStore((s) => s.nodes);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const fieldPoints = useMazeStore((s) => s.fieldPoints);
  const fieldEditMode = useMazeStore((s) => s.fieldEditMode);
  const applyPostEditToolAt = useMazeStore((s) => s.applyPostEditToolAt);
  const setPostEditEndpoint = useMazeStore((s) => s.setPostEditEndpoint);
  const clearPostEditEndpoint = useMazeStore((s) => s.clearPostEditEndpoint);
  const rotateSplitPoint = useMazeStore((s) => s.rotateSplitPoint);
  const setPostEditHoveredLink = useMazeStore((s) => s.setPostEditHoveredLink);
  const applySplitBlueprint = useMazeStore((s) => s.applySplitBlueprint);

  const [activeKind, setActiveKind] = useState<SplitEdgeKind>("passage");

  const key = `${point[0]},${point[1]}`;
  const slots = useMemo(() => [...(splitPoints[key] ?? [])].sort((a, b) => a - b), [splitPoints, key]);
  const isActive = (ep: PostEditEndpoint) => {
    const current = activeSplitNode[key];
    return current === undefined ? ep.kind === "node" : endpointsEqual(current, ep);
  };

  const inFieldCells = useMemo(
    () => buildCellSet(buildActiveCells(fieldPoints, fieldEditMode, cfg)),
    [fieldPoints, fieldEditMode, cfg],
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const pointNodeMap = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const n of nodes) {
      const k = `${n.x},${n.y}`;
      const list = m.get(k);
      if (list) list.push(n.id); else m.set(k, [n.id]);
    }
    return m;
  }, [nodes]);
  const resolveSplit = useMemo(() => buildSplitNodeResolver(pointNodeMap, splitPoints), [pointNodeMap, splitPoints]);
  // Two endpoints are "the same link" if they resolve to the same real `NodeId` — a plain `node`
  // endpoint and a `split` endpoint can both resolve to the same id (GitHub issue #222: an
  // auto-split node already has a real id right after generation, but `draftEdges`/`draftMeta`
  // only ever carry plain `node` endpoints, built straight from wasm's `NodeId`s — see
  // `buildPostEditDraftEdgesFromGenerated`). Falls back to structural equality when either side
  // doesn't resolve yet (a freshly `addSplitNode`-added slot has no real id until the next
  // confirm — see `resolveEndpoint`'s doc comment).
  const endpointsMatch = (a: PostEditEndpoint, b: PostEditEndpoint): boolean => {
    const ra = resolveEndpoint(a, resolveSplit);
    const rb = resolveEndpoint(b, resolveSplit);
    if (ra !== undefined && rb !== undefined) return ra === rb;
    return endpointsEqual(a, b);
  };
  // Every real node at this point, in snapshot order (index 0 is always the point's original
  // node — see `Field::nodes_at`/`all_points`'s contract, mirrored by `PostEditController`'s
  // `buildNodeMap`). Needed to resolve the original node's real `NodeId` — it's a graph node id
  // like any other, nothing about the point's coordinates.
  const originalNodeId = useMemo(() => {
    for (const n of nodes) if (n.x === point[0] && n.y === point[1]) return n.id;
    return undefined;
  }, [nodes, point]);
  const originalEndpoint: PostEditEndpoint | null = originalNodeId !== undefined ? nodeEndpoint(originalNodeId) : null;

  // Resolves which of a (possibly split) point's nodes is currently active — the point's own
  // rule for `key`'s point when it's the dialog's own point, or the point's active-map entry
  // (falling back to its original node) for any other point (e.g. a neighbor across a tile face).
  const resolveActiveAt = (p: [number, number]): PostEditEndpoint | null => {
    const pKey = `${p[0]},${p[1]}`;
    const ids: number[] = [];
    for (const n of nodes) if (n.x === p[0] && n.y === p[1]) ids.push(n.id);
    if (ids.length === 0) return null;
    const activeEntry = useMazeStore.getState().postEditActiveSplitNode[pKey];
    return activeEntry ?? nodeEndpoint(ids[0]);
  };

  // Formats one side of a link bubble — used for both the card's own endpoint and its partner, so
  // a non-original node always gets a "(<title>)" suffix on whichever side it appears on, not just
  // the partner's. The original node itself never does — it's the maze's plain, un-split node, its
  // coordinates alone already identify it uniquely. A `split` endpoint gets its generic slot label
  // as the suffix; a plain `node` endpoint elsewhere on the maze (not this point's original node)
  // has no title at all, just its coordinates.
  const describeEndpoint = (ep: PostEditEndpoint): string => {
    if (originalEndpoint && endpointsMatch(ep, originalEndpoint)) {
      return `${point[0]},${point[1]}`;
    }
    if (ep.kind === "split") {
      return `${ep.point[0]},${ep.point[1]} (${m["post_edit.split_node_label"]({ slotId: ep.slotId })})`;
    }
    const n = nodeById.get(ep.id);
    return n ? `${n.x},${n.y}` : `#${ep.id}`;
  };

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
    for (const t of draftTeleports) {
      if (t.direction === "two_way") {
        if (endpointsMatch(t.from, ep)) { mark(t.to, "out"); mark(t.to, "in"); }
        else if (endpointsMatch(t.to, ep)) { mark(t.from, "out"); mark(t.from, "in"); }
      } else if (endpointsMatch(t.from, ep)) {
        mark(t.to, t.direction === "backward" ? "in" : "out");
      } else if (endpointsMatch(t.to, ep)) {
        mark(t.from, t.direction === "backward" ? "out" : "in");
      }
    }
    return [...finalize(), ...forbidden];
  };

  const isStart = (ep: PostEditEndpoint) => draftMeta?.start != null && endpointsMatch(draftMeta.start, ep);
  const isFinish = (ep: PostEditEndpoint) => draftMeta?.finish != null && endpointsMatch(draftMeta.finish, ep);

  // Node color by row order (original node first, then each slot in slotId order) — same
  // fixed-then-generated palette the canvas uses for resolved split nodes (GitHub issue #223).
  const colorAt = (rowIndex: number) => colorToCss(splitSlotColor(rowIndex, canvas.node.splitSlots));

  const rows: SplitNodesRow<PostEditEndpoint>[] = [
    ...(originalEndpoint ? [{
      key: endpointKey(originalEndpoint), endpoint: originalEndpoint, title: m["post_edit.split_original_node"](),
      color: colorAt(0), removable: false, active: isActive(originalEndpoint), ownLabel: describeEndpoint(originalEndpoint), links: links(originalEndpoint),
      isStart: isStart(originalEndpoint), isFinish: isFinish(originalEndpoint),
    }] : []),
    ...slots.map((slotId, i) => {
      const ep = splitEndpoint(point, slotId);
      return {
        key: endpointKey(ep), endpoint: ep, title: m["post_edit.split_node_label"]({ slotId }),
        color: colorAt((originalEndpoint ? 1 : 0) + i), removable: true, active: isActive(ep), ownLabel: describeEndpoint(ep), links: links(ep),
        isStart: isStart(ep), isFinish: isFinish(ep),
      };
    }),
  ];

  const activeEndpoint: PostEditEndpoint | null = activeSplitNode[key] ?? originalEndpoint;

  const blueprints = useMemo(
    () => blueprintsForDegree(getNeighborData(cfg, point[0], point[1]).offsets.length),
    [cfg, point],
  );

  // Faces of one node (any row, not just the active one) — used to build `tileNodes` below, all
  // of the point's nodes drawn on the tile diagram at once (GitHub issue #234).
  const facesOf = (endpoint: PostEditEndpoint): TileFace[] => {
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    return offsets.map(([dx, dy]) => {
      const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
      const boundary = !inFieldCells.has(`${neighbor[0]},${neighbor[1]}`);
      if (boundary) return { kind: "wall" as TileFaceKind, boundary };
      if (!draftEdges) return { kind: "wall" as TileFaceKind, boundary };

      const neighborActive = resolveActiveAt(neighbor);
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

  const tileNodes: TileFaceNode[] = useMemo(
    () => rows.map((row) => ({ color: row.color, faces: facesOf(row.endpoint) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, cfg, point, inFieldCells, draftEdges, nodes, activeSplitNode],
  );

  const handleFaceClick = (offsetIndex: number) => {
    if (!activeEndpoint) return;
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    const [dx, dy] = offsets[offsetIndex];
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    const neighborActive = resolveActiveAt(neighbor);
    if (!neighborActive) return;
    const tool = activeKind === "passage" ? "passage" : "one_way";
    applyPostEditToolAt(tool, edgeKey(activeEndpoint, neighborActive), activeEndpoint, neighborActive);
  };

  const handleFaceRightClick = (offsetIndex: number) => {
    if (!activeEndpoint) return;
    const { offsets } = getNeighborData(cfg, point[0], point[1]);
    const [dx, dy] = offsets[offsetIndex];
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    const neighborActive = resolveActiveAt(neighbor);
    if (!neighborActive) return;
    applyPostEditToolAt("wall", edgeKey(activeEndpoint, neighborActive), activeEndpoint, neighborActive);
  };

  return (
    <SplitNodesDialogView
      title={m["post_edit.manage_split_nodes"]({ x: point[0], y: point[1] })}
      point={point}
      cfg={cfg}
      rows={rows}
      tileNodes={tileNodes}
      availableKinds={AVAILABLE_KINDS}
      activeKind={activeKind}
      onKindChange={setActiveKind}
      onFaceClick={handleFaceClick}
      onFaceRightClick={handleFaceRightClick}
      onClose={() => { setPostEditHoveredLink(null); onClose(); }}
      onSetActive={(ep) => setActiveSplitNode(point, ep)}
      onAdd={() => addSplitNode(point)}
      onRemove={(row) => { if (row.endpoint.kind === "split") removeSplitNode(point, row.endpoint.slotId); }}
      onToggleStart={() => {
        if (!activeEndpoint) return;
        isStart(activeEndpoint) ? clearPostEditEndpoint("start") : setPostEditEndpoint("start", activeEndpoint);
      }}
      onToggleFinish={() => {
        if (!activeEndpoint) return;
        isFinish(activeEndpoint) ? clearPostEditEndpoint("finish") : setPostEditEndpoint("finish", activeEndpoint);
      }}
      onRotate={(direction) => rotateSplitPoint(point, direction)}
      onHoverLink={(row, link) => setPostEditHoveredLink({ from: row.endpoint, to: link.otherEndpoint })}
      onUnhoverLink={() => setPostEditHoveredLink(null)}
      blueprints={blueprints}
      onApplyBlueprint={(blueprint) => applySplitBlueprint(point, blueprint)}
    />
  );
}
