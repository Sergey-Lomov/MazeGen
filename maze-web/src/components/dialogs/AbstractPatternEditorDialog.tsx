import { useMemo, useState } from "react";
import type React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { activeTessellationOf } from "../../store/storeHelpers";
import { Modal } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { Inline, Stack } from "../Layout";
import { dialogPanelStyles, type SplitEdgeKind, KIND_LABEL } from "../features/SplitNodesDialogView";
import { TileFaceEditor, type TileFaceNode } from "../features/TileFaceEditor";
import { buttonStyle, sharedStyles } from "../../styles/shared";
import { ui, typography, spacing, dialogSpacing } from "../../styles/theme";
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

const AVAILABLE_KINDS: SplitEdgeKind[] = ["passage", "one_way", "undefined", "wall"];

/** A pattern-local node index, addressed directly (no `NodeId`/point+slot concept — a pattern is
 *  pure face-index data until applied during generation, see `SplitGenerationConfig`'s doc
 *  comment). */
type NodeRef = number;

/** Abstract, tessellation-relative split-pattern editor (GitHub issue #222), redesigned to match
 *  `ManageSplitNodesDialog`'s tile+card layout (`SplitNodesDialogView`): a tile diagram on the
 *  left (clicking a face cycles/sets the active node's requirement there), one card per
 *  pattern-local node on the right (click activates it, Add/Remove manage `node_count`). Unlike
 *  the post-edit/preset dialogs there's no real field point, no start/finish, no "undefined"
 *  connections carried over from a previous confirm — `sibling_target` (this face connects to
 *  another of the pattern's own nodes, not an outside neighbor) is the one concept unique to this
 *  editor, picked via a small select shown next to the kind switcher whenever the active node has
 *  at least one `passage`/`one_way` face selected. */
export function AbstractPatternEditorDialog({ pattern, onChange, onClose }: Props) {
  const tessellationConfig = useMazeStore((s) => activeTessellationOf(s));
  const degree = degreeFor(tessellationConfig);
  const [activeNode, setActiveNode] = useState(0);
  const [activeKind, setActiveKind] = useState<SplitEdgeKind>("passage");

  function faceFor(nodeIndex: number, faceIndex: number): SplitPatternFace | undefined {
    return pattern.faces[nodeIndex]?.find((f) => f.face_index === faceIndex);
  }

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

  function setFaceSibling(nodeIndex: number, faceIndex: number, siblingTarget: number | undefined) {
    const nodeFaces = pattern.faces[nodeIndex] ?? [];
    const existing = nodeFaces.find((f) => f.face_index === faceIndex);
    if (!existing) return;
    const rest = nodeFaces.filter((f) => f.face_index !== faceIndex);
    updateNodeFaces(nodeIndex, [...rest, { ...existing, sibling_target: siblingTarget }]);
  }

  function requirementFor(kind: SplitEdgeKind): SplitFaceRequirement {
    if (kind === "one_way") return { kind: "one_way", direction: "forward" };
    if (kind === "undefined") return { kind: "unspecified" };
    return { kind };
  }

  function handleFaceClick(faceIndex: number) {
    setFaceRequirement(activeNode, faceIndex, requirementFor(activeKind));
  }

  function handleFaceRightClick(faceIndex: number) {
    setFaceRequirement(activeNode, faceIndex, { kind: "wall" });
  }

  const nodeRefs: NodeRef[] = useMemo(() => Array.from({ length: pattern.node_count }, (_, i) => i), [pattern.node_count]);
  const colorAt = splitPatternNodeColor;
  const tileNodes: TileFaceNode[] = tileNodesForPattern(pattern, degree);

  const activeFace = (faceIndex: number) => faceFor(activeNode, faceIndex);
  // Faces of the active node that connect somewhere (`passage`/`one_way`) — the only ones a
  // `sibling_target` (this face meets another of the pattern's own nodes, rather than an outside
  // neighbor determined only at apply time) is meaningful for.
  const siblingFaces = Array.from({ length: degree }, (_, i) => i)
    .filter((faceIndex) => {
      const kind = activeFace(faceIndex)?.requirement.kind;
      return kind === "passage" || kind === "one_way";
    });

  const [pendingRemove, setPendingRemove] = useState<NodeRef | null>(null);

  return (
    <>
    <Modal title={m["generation.split_pattern_editor_title"]()} size="wide" onClose={onClose} rawBody={
      <div style={dialogPanelStyles.split}>
        <div style={dialogPanelStyles.left}>
          <Inline gap="itemGap" justify="center" style={{ flexWrap: "wrap" }}>
            {AVAILABLE_KINDS.map((kind) => (
              <button
                key={kind}
                className={kind === activeKind ? "hoverable-accent" : "hoverable"}
                style={buttonStyle(kind === activeKind ? "toggle-active" : "toggle")}
                onClick={() => setActiveKind(kind)}
              >
                {KIND_LABEL[kind]()}
              </button>
            ))}
          </Inline>
          <TileFaceEditor
            point={ANCHOR_POINT} cfg={tessellationConfig} nodes={tileNodes} activeIndex={activeNode}
            onFaceClick={handleFaceClick} onFaceRightClick={handleFaceRightClick} onRotate={() => {}}
          />
          {siblingFaces.length > 0 && (
            <Stack gap="itemGap">
              {siblingFaces.map((faceIndex) => (
                <div key={faceIndex} style={styles.siblingRow}>
                  <span style={styles.siblingLabel}>{faceIndex}</span>
                  <select
                    style={sharedStyles.selectSm}
                    value={activeFace(faceIndex)?.sibling_target ?? ""}
                    onChange={(e) => setFaceSibling(activeNode, faceIndex, e.target.value === "" ? undefined : Number(e.target.value))}
                  >
                    <option value="">{m["generation.split_face_sibling_none"]()}</option>
                    {nodeRefs.filter((n) => n !== activeNode).map((n) => (
                      <option key={n} value={n}>{m["generation.split_face_sibling_target"]()} {n}</option>
                    ))}
                  </select>
                </div>
              ))}
            </Stack>
          )}
        </div>

        <div style={dialogPanelStyles.right}>
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
                  <span style={typography.body}>{m["generation.split_pattern_nodes"]()} {nodeIndex}</span>
                </div>
              </div>
            ))}
            <Inline gap="itemGap">
              <button className="hoverable-accent" style={{ ...buttonStyle("primary"), flex: 1 }} onClick={addNode}>
                {m["post_edit.split_add_node"]()}
              </button>
              <button
                className="hoverable-danger"
                style={{ ...buttonStyle("destructive"), flex: 1, ...(pattern.node_count <= 1 ? sharedStyles.btnDisabled : {}) }}
                disabled={pattern.node_count <= 1}
                onClick={() => setPendingRemove(activeNode)}
              >
                {m["post_edit.split_remove"]()}
              </button>
            </Inline>
          </Stack>
        </div>
      </div>
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
  siblingRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    padding: `2px ${dialogSpacing.paddingX}px`,
  },
  siblingLabel: {
    ...typography.control,
    color: ui.text.secondary,
    width: 20,
    textAlign: "right" as const,
  },
};
