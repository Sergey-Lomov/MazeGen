import { useEffect, useMemo, useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import { Modal } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { Button } from "../Button";
import { dialogPanelStyles, type SplitEdgeKind, KIND_LABEL } from "../features/SplitNodesDialogView";
import { TileFaceEditor } from "../features/TileFaceEditor";
import type { TileFaceNode } from "../../domain/tileFace";
import { indent, muted, spacing, typography } from "../../styles/theme";
import { anchorCanonicalFaces } from "../../domain/tessellationGeometry";
import { originCellOf, splitPatternNodeColor, tileNodesForPattern, resizePatternNodes, removePatternNode } from "../../domain/splitPatternTile";
import type { SplitPattern, SplitPatternFace, SplitFaceRequirement } from "../../wasm/types";
import { ToolIconButton } from "../ToolIconButton";
import { ToolGlyph } from "../features/ToolGlyph";
import { ListCell, ListCellAction } from "../ListCell";
import { EntityColorSwatch } from "../EntityColorSwatch";
import { AddIconButton } from "../AddIconButton";
import { sharedStyles } from "../../styles/shared";
import { WarningIcon } from "../WarningIcon";
import { isTypingTarget } from "../../pixi/domUtils";
import { presetToolForShortcut, presetToolShortcut } from "../../pixi/toolShortcuts";
import * as m from "~/paraglide/messages";

interface Props {
  pattern: SplitPattern;
  onConfirm: (next: SplitPattern) => void;
  onClose: () => void;
}
/** Synthetic anchor point for `TileFaceEditor`'s tile geometry — a pattern has no real field point
 *  (it's rotated/mirrored against an actual tile only when applied during generation, see
 *  `SplitGenerationConfig`'s doc comment), but `getTileDiagram` only ever uses its `(x,y)` argument
 *  to compute the tile's own shape/faces, centering the result around the origin regardless — any
 *  fixed point works identically. */
// "undefined" (`SplitFaceRequirement::Unspecified`) deliberately excluded from this editor's
// switcher — it queues an unvisited neighbor into `reserve` for the ordinary corridor/junction
// logic to maybe connect later, but does nothing at all once that neighbor is already visited by
// the time this pattern applies (no cyclic-style retry the way Passage/OneWay faces get) — in
// practice it reads to the user as "maybe a passage" but behaves as "wall" far more often than
// not. See the tracking issue for making it actually probabilistic before re-exposing it here.
const AVAILABLE_KINDS = ["passage", "one_way", "wall"] as const;
type PatternTool = (typeof AVAILABLE_KINDS)[number];

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
export function AbstractPatternEditorDialog({ pattern, onConfirm, onClose }: Props) {
  const fieldConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const canonicalFaces = useMemo(() => anchorCanonicalFaces(fieldConfig), [fieldConfig]);
  const anchorPoint = originCellOf(fieldConfig);
  const [draft, setDraft] = useState(pattern);
  const [activeNode, setActiveNode] = useState(0);
  const [activeKind, setActiveKind] = useState<PatternTool>("passage");
  const [pendingRemove, setPendingRemove] = useState<NodeRef | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (pendingRemove !== null || isTypingTarget(event.target)) return;
      const tool = presetToolForShortcut(event);
      if (!tool || !AVAILABLE_KINDS.includes(tool as PatternTool)) return;
      event.preventDefault();
      setActiveKind(tool as PatternTool);
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [pendingRemove]);

  function updateNodeFaces(nodeIndex: number, faces: SplitPatternFace[]) {
    const next = draft.faces.map((f, i) => i === nodeIndex ? faces : f);
    setDraft({ ...draft, faces: next });
  }

  function setNodeCount(n: number) {
    const nodeCount = Math.max(1, Math.trunc(n));
    setDraft(resizePatternNodes(draft, nodeCount));
    if (activeNode >= nodeCount) setActiveNode(nodeCount - 1);
  }

  function addNode() {
    setNodeCount(draft.node_count + 1);
    setActiveNode(draft.node_count);
  }

  function removeNode(nodeIndex: number) {
    if (draft.node_count <= 1) return;
    setDraft(removePatternNode(draft, nodeIndex));
    setActiveNode((i) => i >= nodeIndex && i > 0 ? i - 1 : i);
  }

  function setFaceRequirement(nodeIndex: number, faceIndex: number, requirement: SplitFaceRequirement | null) {
    const nodeFaces = draft.faces[nodeIndex] ?? [];
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

  function handleFaceClick(side: number) {
    const faceIndex = canonicalFaces[side];
    const existing = draft.faces[activeNode]?.find((f) => f.face_index === faceIndex)?.requirement;
    setFaceRequirement(activeNode, faceIndex, requirementFor(activeKind, existing));
  }

  function handleFaceRightClick(side: number) {
    setFaceRequirement(activeNode, canonicalFaces[side], { kind: "wall" });
  }

  const nodeRefs: NodeRef[] = useMemo(() => Array.from({ length: draft.node_count }, (_, i) => i), [draft.node_count]);
  const colorAt = splitPatternNodeColor;
  const tileNodes: TileFaceNode[] = tileNodesForPattern(draft, fieldConfig);

  const nodeWarnings = nodeRefs.map(warningsForNode);

  function confirm() {
    onConfirm(draft);
  }

  function faceSummary(nodeIndex: number) {
    const counts = { passage: 0, wall: 0, oneWay: 0 };
    for (const face of tileNodes[nodeIndex]?.faces ?? []) {
      if (face.kind === "passage") counts.passage += 1;
      else if (face.kind === "wall") counts.wall += 1;
      else if (face.kind === "one_way_in" || face.kind === "one_way_out") counts.oneWay += 1;
    }
    return `${m["generation.split_face_passage"]()}: ${counts.passage} · ${m["generation.split_face_wall"]()}: ${counts.wall} · ${m["generation.split_face_one_way"]()}: ${counts.oneWay}`;
  }

  function warningsForNode(nodeIndex: number): string[] {
    const node = tileNodes[nodeIndex];
    if (!node) return [];
    const messages: string[] = [];
    const openable = node.faces.filter((face) => !face.boundary);
    if (openable.length > 0 && openable.every((face) => face.kind === "wall")) {
      messages.push(m["generation.split_pattern_warning_only_walls"]());
    } else if (!node.faces.some((face) => face.kind === "passage" || face.kind === "one_way_out" || face.kind === "one_way_in" || face.kind === "undefined")) {
      messages.push(m["generation.split_pattern_warning_no_connections"]());
    }
    for (const face of draft.faces[nodeIndex] ?? []) {
      if (face.sibling_target !== undefined && (face.sibling_target < 0 || face.sibling_target >= draft.node_count)) {
        messages.push(m["generation.split_pattern_warning_missing_sibling"]({ face: face.face_index }));
      }
    }
    return messages;
  }

  return (
    <>
    <Modal title={m["generation.split_pattern_editor_title"]()} size="wide" onClose={onClose} onConfirm={confirm} rawBody={
      <>
        <div style={dialogPanelStyles.tileArea}>
          <div style={styles.editorWorkspace}>
          <div style={styles.tools}>
            {AVAILABLE_KINDS.map((kind) => (
              <ToolIconButton key={kind} selected={kind === activeKind} title={KIND_LABEL[kind]()} shortcut={presetToolShortcut(kind)} onClick={() => setActiveKind(kind)}>
                <ToolGlyph tool={kind} />
              </ToolIconButton>
            ))}
          </div>
          <TileFaceEditor
            point={anchorPoint} cfg={fieldConfig} nodes={tileNodes} activeIndex={activeNode}
            onFaceClick={handleFaceClick} onFaceRightClick={handleFaceRightClick} onRotate={() => {}}
            showRotateControls={false}
          />
          </div>
        </div>

        <div style={dialogPanelStyles.nodeListWrap}>
          <div style={dialogPanelStyles.nodeList}>
            <div style={styles.nodesHeader}>
              <span style={sharedStyles.sectionHeader}>{m["generation.split_pattern_nodes"]()}</span>
              <AddIconButton title={m["post_edit.split_add_node"]()} onClick={addNode} />
            </div>
            <div style={styles.nodesList}>
              {nodeRefs.map((nodeIndex) => {
                const warnings = nodeWarnings[nodeIndex] ?? [];
                return (
                  <ListCell
                    key={nodeIndex}
                    className="hoverable"
                    onClick={() => setActiveNode(nodeIndex)}
                    current={nodeIndex === activeNode}
                    title={`${m["generation.split_pattern_node_label"]()} ${nodeIndex}`}
                    titleAddon={<><EntityColorSwatch color={colorAt(nodeIndex)} />{warnings.length > 0 && <WarningIcon title={<>{warnings.map((warning) => <span key={warning} style={styles.warningLine}>{warning}</span>)}</>} />}</>}
                    details={<span style={muted(typography.caption)}>{faceSummary(nodeIndex)}</span>}
                    actionsPlacement="title"
                    actions={(
                      <ListCellAction
                        action="delete"
                        title={m["post_edit.split_remove"]()}
                        description={draft.node_count <= 1 ? m["generation.split_pattern_remove_last_node_hint"]() : undefined}
                        danger
                        disabled={draft.node_count <= 1}
                        onAction={() => setPendingRemove(nodeIndex)}
                      />
                    )}
                  />
                );
              })}
            </div>
          </div>

          {/* Fixed footer (GitHub issue #237 follow-up) — Add/Remove stay reachable regardless of
           * how far the card list above is scrolled. */}
          <div style={dialogPanelStyles.nodeListFooter}>
            <Button variant="primary" dialogAction layoutStyle={styles.confirmButton} onClick={confirm}>
              {m["common.confirm"]()}
            </Button>
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
  editorWorkspace: { display: "flex", gap: spacing.groupGap, flex: 1, minHeight: 0 },
  tools: { display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: spacing.itemGap, flexShrink: 0 },
  nodesHeader: { display: "flex", alignItems: "center", gap: spacing.itemGap, padding: `${spacing.itemGap}px 0` },
  nodesList: { marginLeft: indent.tree },
  confirmButton: { width: "100%" },
  warningLine: { display: "block" },
};
