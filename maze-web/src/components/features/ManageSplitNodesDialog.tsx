import { useState, useMemo } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { ui, typography, radius, spacing } from "../../styles/theme";
import { Stack } from "../Layout";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, endpointKey,
} from "../../pixi/postEditEndpoint";
import * as m from "~/paraglide/messages";
import type React from "react";

interface Props {
  point: [number, number];
  onClose: () => void;
}

/** One link (edge or teleport) from a node, resolved to a small display label — the other
 * endpoint's cell coordinates when known, or a generic slot label for a not-yet-confirmed split
 * node (see `postEditEndpoint.ts`'s unresolved-endpoint contract). */
interface LinkInfo {
  otherLabel: string;
  arrow: string;
}

/** Manages a split point's extra nodes (GitHub issue #221) — add/remove nodes at this point and
 * pick which one is "active" for edge-tool clicks on the point's faces. One card per node (the
 * point's original node first, never removable, then each confirmed extra slot in slotId order).
 * Each card's links (one bubble per connected edge/teleport, a passage's two directed entries
 * collapsed into one "<->" link) reuse `DebugRefBubble`'s bubble visual style, not its click/hover
 * logic — both sides of a bubble get a "(<title>)" suffix whenever that side isn't the point's
 * original node (`describeEndpoint`), since every node at a split point shares the same
 * coordinates and the title is what actually distinguishes them. */
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

  const [pendingRemove, setPendingRemove] = useState<number | null>(null);

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

  const rows: { ep: PostEditEndpoint; title: string; removable: boolean }[] = [
    ...(originalEndpoint ? [{ ep: originalEndpoint, title: m["post_edit.split_original_node"](), removable: false }] : []),
    ...slots.map((slotId) => ({
      ep: splitEndpoint(point, slotId),
      title: m["post_edit.split_node_label"]({ slotId }),
      removable: true,
    })),
  ];

  return (
    <Modal title={m["post_edit.manage_split_nodes"]({ x: point[0], y: point[1] })} onClose={onClose}>
      <Stack gap="itemGap">
        {rows.map((row) => {
          const active = isActive(row.ep);
          const rowLinks = links(row.ep);
          const own = describeEndpoint(row.ep);
          const removable = row.removable && row.ep.kind === "split";
          // The corner (Remove button and/or Active badge) is absolutely positioned over the
          // title row — when it has anything in it, push the links row down so its bubbles don't
          // visually collide with the corner instead of just wrapping under the title.
          const hasCorner = active || removable;
          return (
            <div
              key={endpointKey(row.ep)}
              style={{ ...styles.card, cursor: active ? "default" : "pointer" }}
              className={active ? undefined : "hoverable"}
              onClick={active ? undefined : () => setActiveSplitNode(point, row.ep)}
            >
              <div style={styles.cardCorner}>
                {removable && (
                  <button
                    className="hoverable-danger"
                    style={styles.iconBtn}
                    title={m["post_edit.split_remove"]()}
                    onClick={(e) => { e.stopPropagation(); setPendingRemove(row.ep.kind === "split" ? row.ep.slotId : null); }}
                  >
                    <X size={18} color={ui.text.tertiary} />
                  </button>
                )}
                {active && <span style={styles.activeBadge}>{m["post_edit.split_active_badge"]()}</span>}
              </div>
              <span style={styles.cardTitle}>{row.title}</span>
              <div style={{ ...styles.linksCell, marginTop: hasCorner ? 4 : 0 }}>
                {rowLinks.length === 0 ? (
                  <span style={typography.body}>{m["post_edit.split_no_links"]()}</span>
                ) : (
                  rowLinks.map((link, i) => (
                    <span key={i} style={styles.bubble}>{own} {link.arrow} {link.otherLabel}</span>
                  ))
                )}
              </div>
            </div>
          );
        })}
        <button
          className="hoverable-accent"
          style={styles.addBtn}
          onClick={() => addSplitNode(point)}
        >
          {m["post_edit.split_add_node"]()}
        </button>
      </Stack>

      {pendingRemove !== null && (
        <ConfirmModal
          message={m["post_edit.confirm_remove_split_node"]()}
          onConfirm={() => { removeSplitNode(point, pendingRemove); setPendingRemove(null); }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // One bordered card per node — clearer separation than a borderless grid row, especially once
  // link bubbles wrap onto a second line. The whole card (except its corner controls) is a click
  // target that activates the node — `position: relative` anchors `cardCorner`. Deliberately no
  // `paddingRight` reservation on the card itself — an earlier version added one to keep the
  // title/corner from overlapping, but padding on a flex column narrows *every* child's content
  // box, including `linksCell`, which pushed link bubbles onto extra wrapped lines even when the
  // corner (only tall enough for its own row) had nothing above the links row to collide with.
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    padding: spacing.itemGap,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.md,
  },
  // Top-right corner row — Remove button (removable cards only) to the left of the Active badge
  // (when active). Absolutely positioned (overlaps only the title row, not links below it) so it
  // doesn't consume card width the links row would otherwise wrap around.
  cardCorner: {
    position: "absolute",
    top: spacing.itemGap,
    right: spacing.itemGap,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  cardTitle: {
    ...typography.body,
    color: ui.text.primary,
    textAlign: "center",
  },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "default",
    padding: 4,
    display: "flex",
    alignItems: "center",
  },
  linksCell: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap,
  },
  // Same shape as `DebugRefBubble`'s coordinate bubble — reused for visual consistency, not its
  // hover/click behavior (this dialog's bubbles are plain, non-interactive labels).
  bubble: {
    ...typography.body,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text,
    color: ui.debug.refHighlight.text,
    whiteSpace: "nowrap",
  },
  activeBadge: {
    ...typography.control,
    padding: "0 6px",
    border: `1px solid ${ui.accent.base}`,
    background: ui.accent.base,
    color: ui.text.inverse,
    borderRadius: radius.sm,
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  addBtn: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: 8,
    cursor: "default",
    borderRadius: radius.sm,
    width: "100%",
  },
};
