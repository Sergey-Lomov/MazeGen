import { useMemo, useState } from "react";
import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { Modal } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { Button } from "../Button";
import { Inline, Stack } from "../Layout";
import { dialogPanelStyles, type SplitEdgeKind, KIND_LABEL } from "../features/SplitNodesDialogView";
import { TileFaceEditor, type TileFaceNode } from "../features/TileFaceEditor";
import { splitNodeDiagnostics, patternEmptyNodeDiagnostics, patternSiblingDiagnostics } from "../../pixi/splitNodeDiagnostics";
import { typography, spacing } from "../../styles/theme";
import { embeddedNotificationStyle, notificationPalette } from "../EmbeddedNotification";
import { degreeFor, splitPatternNodeColor, tileNodesForPattern, resizePatternNodes, removePatternNode } from "../../pixi/splitPatternTile";
import type { SplitPattern, SplitPatternFace, SplitFaceRequirement } from "../../wasm/types";
import * as m from "~/paraglide/messages";

interface Props {
  pattern: SplitPattern;
  onChange: (next: SplitPattern) => void;
  onClose: () => void;
}

/** Synthetic anchor point for `TileFaceEditor`'s tile geometry — a pattern has no real field point
 *  (it's rotated/mirrored against an actual tile only when applied during generation, see
 *  `SplitGenerationConfig`'s doc comment), but `getTileDiagram` only ever uses its `(x,y)` argument
 *  to compute the tile's own shape/faces, centering the result around the origin regardless — any
 *  fixed point works identically. */
const ANCHOR_POINT: [number, number] = [0, 0];

// "undefined" (`SplitFaceRequirement::Unspecified`) deliberately excluded from this editor's
// switcher — it queues an unvisited neighbor into `reserve` for the ordinary corridor/junction
// logic to maybe connect later, but does nothing at all once that neighbor is already visited by
// the time this pattern applies (no cyclic-style retry the way Passage/OneWay faces get) — in
// practice it reads to the user as "maybe a passage" but behaves as "wall" far more often than
// not. See the tracking issue for making it actually probabilistic before re-exposing it here.
const AVAILABLE_KINDS: SplitEdgeKind[] = ["passage", "one_way", "wall"];

/** A pattern-local node index, addressed directly (no `NodeId`/point+slot concept — a pattern is
 *  pure face-index data until applied during generation, see `SplitGenerationConfig`'s doc
 *  comment). */
type NodeRef = number;

/** Abstract, tessellation-relative split-pattern editor (GitHub issue #222): a tile diagram on top
 *  (clicking a face cycles/sets the active node's requirement there), one card per pattern-local
 *  node below (click activates it, Add/Remove manage `node_count`). Unlike the post-edit/preset
 *  panels there's no real field point, no start/finish, no "undefined" connections carried over
 *  from a previous confirm, and no rotate (a pattern has no fixed orientation until applied during
 *  generation).
 *
 *  Stays a `Modal` (GitHub issue #237 follow-up — briefly tried as a `SidePanel` like the post-edit/
 *  preset panels, reverted) — it's opened from inside `SplitSettingsDialog`, itself a `Modal`; a
 *  `SidePanel` doesn't portal above another modal's overlay, so the tile/card controls ended up
 *  visually present but unclickable behind it. `dialogPanelStyles`' vertical tileArea/nodeList
 *  layout is unaffected either way — only the outer chrome (`Modal` vs `SidePanel`) changed.
 *
 *  `SplitPatternFace.sibling_target` (a face connecting to another of the pattern's own nodes
 *  rather than an outside neighbor) still exists on the wire type and in `maze-core`, but this
 *  editor no longer exposes any UI for setting it (GitHub issue #237 — the per-face sibling
 *  dropdown read as confusing and siblings aren't meant to link to each other directly); a
 *  follow-up issue tracks removing the field itself from both sides. */
export function AbstractPatternEditorDialog({ pattern, onChange, onClose }: Props) {
  const tessellationConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const degree = degreeFor(tessellationConfig);
  const [activeNode, setActiveNode] = useState(0);
  const [activeKind, setActiveKind] = useState<SplitEdgeKind>("passage");

  function updateNodeFaces(nodeIndex: number, faces: SplitPatternFace[]) {
    const next = pattern.faces.map((f, i) => i === nodeIndex ? faces : f);
    onChange({ ...pattern, faces: next });
  }

  function setNodeCount(n: number) {
    const nodeCount = Math.max(1, Math.trunc(n));
    onChange(resizePatternNodes(pattern, nodeCount));
    if (activeNode >= nodeCount) setActiveNode(nodeCount - 1);
  }

  function addNode() {
    setNodeCount(pattern.node_count + 1);
    setActiveNode(pattern.node_count);
  }

  function removeNode(nodeIndex: number) {
    if (pattern.node_count <= 1) return;
    onChange(removePatternNode(pattern, nodeIndex));
    setActiveNode((i) => i >= nodeIndex && i > 0 ? i - 1 : i);
  }

  function setFaceRequirement(nodeIndex: number, faceIndex: number, requirement: SplitFaceRequirement | null) {
    const nodeFaces = pattern.faces[nodeIndex] ?? [];
    const rest = nodeFaces.filter((f) => f.face_index !== faceIndex);
    if (requirement === null) {
      updateNodeFaces(nodeIndex, rest);
      return;
    }
    const existing = nodeFaces.find((f) => f.face_index === faceIndex);
    updateNodeFaces(nodeIndex, [...rest, { face_index: faceIndex, requirement, sibling_target: existing?.sibling_target }]);
  }

  function requirementFor(kind: SplitEdgeKind, existing: SplitFaceRequirement | undefined): SplitFaceRequirement {
    if (kind === "one_way") {
      // Re-clicking an already-one_way face flips its direction instead of re-pinning it to
      // "forward" every time — mirrors post-edit's `applyPostEditEdgeTool`'s "one_way" toggle.
      const flipped = existing?.kind === "one_way" && existing.direction === "forward" ? "backward" : "forward";
      return { kind: "one_way", direction: flipped };
    }
    if (kind === "undefined") return { kind: "unspecified" };
    return { kind };
  }

  function handleFaceClick(faceIndex: number) {
    const existing = pattern.faces[activeNode]?.find((f) => f.face_index === faceIndex)?.requirement;
    setFaceRequirement(activeNode, faceIndex, requirementFor(activeKind, existing));
  }

  function handleFaceRightClick(faceIndex: number) {
    setFaceRequirement(activeNode, faceIndex, { kind: "wall" });
  }

  const nodeRefs: NodeRef[] = useMemo(() => Array.from({ length: pattern.node_count }, (_, i) => i), [pattern.node_count]);
  const colorAt = splitPatternNodeColor;
  const tileNodes: TileFaceNode[] = tileNodesForPattern(pattern, degree);
  const emptyNodeIndices = new Set(
    nodeRefs.filter((i) => (pattern.faces[i]?.length ?? 0) === 0),
  );
  const warnings = [
    ...patternEmptyNodeDiagnostics(pattern),
    ...splitNodeDiagnostics(tileNodes, emptyNodeIndices),
    ...patternSiblingDiagnostics(pattern),
  ];

  const [pendingRemove, setPendingRemove] = useState<NodeRef | null>(null);

  return (
    <>
    <Modal title={m["generation.split_pattern_editor_title"]()} size="wide" onClose={onClose} rawBody={
      <>
        {warnings.length > 0 && (
          <div style={styles.warningsStrip}>
            {warnings.map((w, i) => (
              <div key={i} style={styles.warningItem}>{w}</div>
            ))}
          </div>
        )}
        <div style={dialogPanelStyles.tileArea}>
          <Inline gap="itemGap" justify="center" style={{ flexWrap: "wrap" }}>
            {AVAILABLE_KINDS.map((kind) => (
              <Button
                key={kind}
                variant={kind === activeKind ? "toggle-selected" : "toggle"}
                onClick={() => setActiveKind(kind)}
              >
                {KIND_LABEL[kind]()}
              </Button>
            ))}
          </Inline>
          <TileFaceEditor
            point={ANCHOR_POINT} cfg={tessellationConfig} nodes={tileNodes} activeIndex={activeNode}
            onFaceClick={handleFaceClick} onFaceRightClick={handleFaceRightClick} onRotate={() => {}}
            showRotateControls={false}
          />
        </div>

        <div style={dialogPanelStyles.nodeListWrap}>
          <div style={dialogPanelStyles.nodeList}>
            <Stack gap="itemGap">
              {nodeRefs.map((nodeIndex) => (
                <div
                  key={nodeIndex}
                  style={{ ...dialogPanelStyles.card, cursor: nodeIndex === activeNode ? "default" : "pointer" }}
                  className={nodeIndex === activeNode ? undefined : "hoverable"}
                  onClick={nodeIndex === activeNode ? undefined : () => setActiveNode(nodeIndex)}
                >
                  {nodeIndex === activeNode && (
                    <div style={dialogPanelStyles.cardCorner}>
                      <span style={dialogPanelStyles.activeBadge}>{m["post_edit.split_active_badge"]()}</span>
                    </div>
                  )}
                  <div style={dialogPanelStyles.titleLine}>
                    <span style={{ ...dialogPanelStyles.colorDot, background: colorAt(nodeIndex) }} />
                    <span style={typography.body}>{m["generation.split_pattern_node_label"]()} {nodeIndex}</span>
                  </div>
                </div>
              ))}
            </Stack>
          </div>

          {/* Fixed footer (GitHub issue #237 follow-up) — Add/Remove stay reachable regardless of
           * how far the card list above is scrolled. */}
          <div style={dialogPanelStyles.nodeListFooter}>
            <Inline gap="itemGap">
              <Button variant="primary" layoutStyle={{ flex: 1 }} onClick={addNode}>
                {m["post_edit.split_add_node"]()}
              </Button>
              <Button
                variant="destructive"
                layoutStyle={{ flex: 1 }}
                disabled={pattern.node_count <= 1}
                onClick={() => setPendingRemove(activeNode)}
              >
                {m["post_edit.split_remove"]()}
              </Button>
            </Inline>
          </div>
        </div>
      </>
    } />
    {pendingRemove !== null && (
      <ConfirmModal
        message={m["post_edit.confirm_remove_split_node"]()}
        onConfirm={() => { removeNode(pendingRemove); setPendingRemove(null); }}
        onCancel={() => setPendingRemove(null)}
      />
    )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  warningsStrip: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    padding: `${spacing.groupGap}px ${spacing.sectionGap}px`,
    background: notificationPalette("warning").bg,
    borderBottom: `1px solid ${notificationPalette("warning").text}`,
    flexShrink: 0,
  },
  warningItem: {
    ...embeddedNotificationStyle,
    background: "transparent",
    borderWidth: 0,
    padding: 0,
    color: notificationPalette("warning").text,
  },
};
