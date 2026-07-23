import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, endpointKey,
} from "../../pixi/postEditEndpoint";
import { SplitNodesDialogView, type SplitNodesRow, type LinkInfo } from "./SplitNodesDialogView";
import * as m from "~/paraglide/messages";

interface Props {
  point: [number, number];
  onClose: () => void;
}

/** Post-edit adapter for `SplitNodesDialogView` (GitHub issue #221) — manages a split point's
 * extra nodes and picks which one edge-tool clicks on the point's faces currently target. Builds
 * rows/labels/links from `nodes`/`postEditDraftEdges`/`postEditDraftTeleports` (resolved
 * `NodeId`s, since post-edit runs after generation) and delegates layout/remove-confirmation to
 * the shared view. */
export function ManageSplitNodesDialog({ point, onClose }: Props) {
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const activeSplitNode = useMazeStore((s) => s.postEditActiveSplitNode);
  const addSplitNode = useMazeStore((s) => s.addSplitNode);
  const removeSplitNode = useMazeStore((s) => s.removeSplitNode);
  const setActiveSplitNode = useMazeStore((s) => s.setActiveSplitNode);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const draftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const nodes = useMazeStore((s) => s.nodes);

  const key = `${point[0]},${point[1]}`;
  const slots = useMemo(() => [...(splitPoints[key] ?? [])].sort((a, b) => a - b), [splitPoints, key]);
  const isActive = (ep: PostEditEndpoint) => {
    const current = activeSplitNode[key];
    return current === undefined ? ep.kind === "node" : endpointsEqual(current, ep);
  };

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Every real node at this point, in snapshot order (index 0 is always the point's original
  // node — see `Field::nodes_at`/`all_points`'s contract, mirrored by `PostEditController`'s
  // `buildNodeMap`). Needed to resolve the original node's real `NodeId` — it's a graph node id
  // like any other, nothing about the point's coordinates.
  const originalNodeId = useMemo(() => {
    for (const n of nodes) if (n.x === point[0] && n.y === point[1]) return n.id;
    return undefined;
  }, [nodes, point]);
  const originalEndpoint: PostEditEndpoint | null = originalNodeId !== undefined ? nodeEndpoint(originalNodeId) : null;
  // Formats one side of a link bubble — used for both the card's own endpoint and its partner, so
  // a non-original node always gets a "(<title>)" suffix on whichever side it appears on, not just
  // the partner's. The original node itself never does — it's the maze's plain, un-split node, its
  // coordinates alone already identify it uniquely. A `split` endpoint gets its generic slot label
  // as the suffix; a plain `node` endpoint elsewhere on the maze (not this point's original node)
  // has no title at all, just its coordinates.
  const describeEndpoint = (ep: PostEditEndpoint): string => {
    if (originalEndpoint && endpointsEqual(ep, originalEndpoint)) {
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
  const links = (ep: PostEditEndpoint): LinkInfo[] => {
    const byPartner = new Map<string, { otherLabel: string; out: boolean; in: boolean }>();
    const mark = (partnerEp: PostEditEndpoint, direction: "out" | "in") => {
      const partnerKey = endpointKey(partnerEp);
      const entry = byPartner.get(partnerKey) ?? { otherLabel: describeEndpoint(partnerEp), out: false, in: false };
      entry[direction] = true;
      byPartner.set(partnerKey, entry);
    };
    if (draftEdges) {
      for (const e of Object.values(draftEdges)) {
        if (e.kind === "wall") continue;
        if (endpointsEqual(e.from, ep)) mark(e.to, "out");
        else if (endpointsEqual(e.to, ep)) mark(e.from, "in");
      }
    }
    for (const t of draftTeleports) {
      if (t.direction === "two_way") {
        if (endpointsEqual(t.from, ep)) { mark(t.to, "out"); mark(t.to, "in"); }
        else if (endpointsEqual(t.to, ep)) { mark(t.from, "out"); mark(t.from, "in"); }
      } else if (endpointsEqual(t.from, ep)) {
        mark(t.to, t.direction === "backward" ? "in" : "out");
      } else if (endpointsEqual(t.to, ep)) {
        mark(t.from, t.direction === "backward" ? "out" : "in");
      }
    }
    return [...byPartner.values()].map(({ otherLabel, out, in: isIn }) => ({
      otherLabel,
      arrow: out && isIn ? "<->" : isIn ? "<-" : "->",
    }));
  };

  const rows: SplitNodesRow<PostEditEndpoint>[] = [
    ...(originalEndpoint ? [{
      key: endpointKey(originalEndpoint), endpoint: originalEndpoint, title: m["post_edit.split_original_node"](),
      removable: false, active: isActive(originalEndpoint), ownLabel: describeEndpoint(originalEndpoint), links: links(originalEndpoint),
    }] : []),
    ...slots.map((slotId) => {
      const ep = splitEndpoint(point, slotId);
      return {
        key: endpointKey(ep), endpoint: ep, title: m["post_edit.split_node_label"]({ slotId }),
        removable: true, active: isActive(ep), ownLabel: describeEndpoint(ep), links: links(ep),
      };
    }),
  ];

  return (
    <SplitNodesDialogView
      title={m["post_edit.manage_split_nodes"]({ x: point[0], y: point[1] })}
      rows={rows}
      onClose={onClose}
      onSetActive={(ep) => setActiveSplitNode(point, ep)}
      onAdd={() => addSplitNode(point)}
      onRemove={(row) => { if (row.endpoint.kind === "split") removeSplitNode(point, row.endpoint.slotId); }}
    />
  );
}
