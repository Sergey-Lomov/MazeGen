import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { splitSlotColor } from "../../pixi/colorUtils";
import { canvas } from "../../pixi/colorTokens";
import { splitPointFaceKindsByNode } from "../../pixi/splitNodeGeometry";
import { detectSplitSpecialShapeKind } from "../../pixi/splitFaceLayout";
import { activeFloorLevel } from "../../store/storeHelpers";
import { resolveEndpoint, buildSplitNodeResolver } from "../../pixi/postEditEndpoint";
import { recordOnLevel } from "../../pixi/fieldEditUtils";
import type { EdgeDto } from "../../wasm/types";
import { SplitPointPixiPreview } from "./SplitPointPixiPreview";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** "Which split node?" picker for an in-progress post-edit vertex-tool placement (GitHub issue
 * #474). The active-node concept must not decide which of a split point's nodes a vertical
 * passage / elevator / teleport endpoint / start-finish marker attaches to, so
 * `PostEditController` defers the placement and opens this dialog; picking a node calls
 * `applyPostEditSplitTargetPick`, which dispatches the deferred tool to that node. `nodeIds` are
 * the point's confirmed nodes in snapshot order — index 0 the original node, the rest its slots
 * (same order and palette `ManageSplitNodesDialog` uses).
 *
 * A small Pixi preview on the right (`SplitPointPixiPreview`) renders the point with the exact
 * same pipeline the main canvas uses — a recognised special shape (bridge/diagonal) draws with
 * its real geometry. On a special shape each node also gets a marker dot in its colour at its
 * real anchor position so the user can tell the nodes apart by position; on a plain split the
 * line colours already disambiguate, so no dots. */
export function PostEditSplitTargetDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.postEditSplitTargetPrompt);
  const pick = useMazeStore((s) => s.applyPostEditSplitTargetPick);
  const allNodes = useMazeStore((s) => s.nodes);
  const cfg = useMazeStore((s) => s.activeTessellationConfig);
  const draftEdges = useMazeStore((s) => s.postEditDraftEdges);
  const draftTeleports = useMazeStore((s) => s.postEditDraftTeleports);
  const splitPoints = useMazeStore((s) => s.postEditDraftSplitPoints);
  const level = useMazeStore(activeFloorLevel);

  const point = prompt?.point ?? null;

  const preview = useMemo(() => {
    if (!point) return null;
    const floorNodes = allNodes.filter((n) => (n.level ?? 0) === (level ?? 0));
    const pointNodes = floorNodes.filter((n) => n.x === point[0] && n.y === point[1]);
    if (pointNodes.length < 2) return null;

    // Draft basic/one-way edges + teleports as directed real-id edges, resolved against the
    // confirmed node snapshot — the full floor's set (a split point's edges run to neighbouring
    // cells) feeds the preview geometry and special-shape detection alike.
    const bareNodeMap = new Map<string, number[]>();
    for (const n of allNodes) {
      const k = `${n.x},${n.y}`;
      const list = bareNodeMap.get(k);
      if (list) list.push(n.id); else bareNodeMap.set(k, [n.id]);
    }
    const resolveSplit = buildSplitNodeResolver(bareNodeMap, recordOnLevel(splitPoints, level));
    const floorNodeIds = new Set(floorNodes.map((n) => n.id));
    const edges: EdgeDto[] = [];
    for (const e of Object.values(draftEdges ?? {})) {
      if (e.kind === "wall") continue;
      const from = resolveEndpoint(e.from, resolveSplit);
      const to = resolveEndpoint(e.to, resolveSplit);
      if (from === undefined || to === undefined) continue;
      if (!floorNodeIds.has(from) || !floorNodeIds.has(to)) continue;
      edges.push({ from, to, kind: "basic" });
    }
    for (const t of draftTeleports) {
      const from = resolveEndpoint(t.from, resolveSplit);
      const to = resolveEndpoint(t.to, resolveSplit);
      if (from === undefined || to === undefined) continue;
      if (!floorNodeIds.has(from) || !floorNodeIds.has(to)) continue;
      if (t.direction !== "backward") edges.push({ from, to, kind: "teleport" });
      if (t.direction !== "forward") edges.push({ from: to, to: from, kind: "teleport" });
    }

    const directed = new Set(
      edges.filter((e) => e.kind !== "teleport").map((e) => `${e.from}->${e.to}`),
    );
    const byTile = new Map<string, typeof floorNodes>();
    for (const n of floorNodes) {
      const k = `${n.x}:${n.y}`;
      const list = byTile.get(k);
      if (list) list.push(n); else byTile.set(k, [n]);
    }
    const faceKindsByNode = splitPointFaceKindsByNode(pointNodes, byTile, directed, cfg);
    const special = detectSplitSpecialShapeKind(faceKindsByNode) !== null;

    return { pointNodes, floorNodes, edges, special };
  }, [point, allNodes, level, cfg, draftEdges, draftTeleports, splitPoints]);

  if (!prompt || !point) return null;
  const [x, y] = point;

  return (
    <Modal title={m["post_edit.split_target_title"]({ x, y })} size="approve" onClose={onClose}>
      <p style={styles.hint}>{m["post_edit.split_target_hint"]()}</p>
      <div style={styles.body}>
        <div style={styles.list}>
          {prompt.nodeIds.map((id, index) => (
            <Button
              key={id}
              variant="secondary"
              layoutStyle={styles.item}
              onClick={() => { pick(id); onClose(); }}
            >
              <span style={{ ...styles.dot, background: colorToCss(splitSlotColor(index, canvas.node.splitSlots)) }} />
              {index === 0
                ? m["post_edit.split_original_node"]()
                : m["post_edit.split_node_label"]({ slotId: index - 1 })}
            </Button>
          ))}
        </div>
        {preview && (
          <SplitPointPixiPreview
            point={point}
            cfg={cfg}
            pointNodes={preview.pointNodes}
            allNodes={preview.floorNodes}
            allEdges={preview.edges}
            showMarkers={preview.special}
          />
        )}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
      </div>
    </Modal>
  );
}

// Mirrors PostEditElevatorFloorDialog's row/footer styling.
const styles: Record<string, React.CSSProperties> = {
  hint: {
    ...typography.control,
    color: ui.text.secondary,
    margin: 0,
    paddingBottom: dialogSpacing.paddingY,
  },
  body: {
    display: "flex",
    gap: dialogSpacing.paddingX,
    alignItems: "flex-start",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
    flex: 1,
    minWidth: 0,
  },
  item: {
    ...typography.control,
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    justifyContent: "flex-start",
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    borderRadius: radius.sm,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flex: "0 0 auto",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
