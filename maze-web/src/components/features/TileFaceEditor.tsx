import { useState } from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import { getTileDiagram } from "../../pixi/tessellationGeometry";
import { computeSplitFaceLayouts, computeSplitConnectors, type SplitFaceKind } from "../../pixi/splitFaceLayout";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { ui, radius, spacing, typography } from "../../styles/theme";
import { disabledOf } from "../../styles/palette";
import * as m from "~/paraglide/messages";
import type React from "react";

/** What a tile's face currently shows for one node, for the "Manage split nodes" dialog's
 * large-tile diagram (GitHub issue #234). `"one_way_out"`/`"one_way_in"` are relative to that
 * node — `out` means the node is the passage's source. */
export type TileFaceKind = SplitFaceKind;

export interface TileFace {
  kind: TileFaceKind;
  /** No neighboring tile outside the field on this side — not clickable, shows a hint instead.
   * Identical for every node at this point (a property of the side itself), but carried per-face
   * for convenience at the call site. */
  boundary: boolean;
}

export interface TileFaceNode {
  color: string;
  /** One entry per `getNeighborData` offset index for this cell. */
  faces: TileFace[];
}

interface Props {
  point: [number, number];
  cfg: TessellationConfig;
  nodes: TileFaceNode[];
  /** Index into `nodes` of the currently active node (tile-face clicks/z-order), or `null` if
   * none is active. Its segments/connectors always draw last (on top) — GitHub issue #234
   * follow-up ("active node always on top"). */
  activeIndex: number | null;
  onFaceClick: (index: number) => void;
  /** Right-click on a non-boundary face — forbids the active node's connection there (GitHub
   * issue #234 follow-up: a quick "wall" shortcut independent of the kind switcher). */
  onFaceRightClick: (index: number) => void;
  /** Rotates every node's connections by one geometric face, clockwise (`1`) or counter-clockwise
   * (`-1`) — see `rotatePostEditSplitPoint`/`rotatePresetSplitPoint`. Rendered as two small buttons
   * beside the tile (outside its own bounding box, so they never overlap a node's drawing) —
   * counter-clockwise on the left, clockwise on the right. */
  onRotate: (direction: 1 | -1) => void;
}

/** Large single-tile diagram, rendered in the field's own tessellation — shows every node's
 * faces at once, each in its own color (mirrors the canvas's per-slot split-passage coloring),
 * clicking a non-boundary side adds/edits a connection there for the dialog's currently active
 * node (see `SplitNodesDialogView`); right-clicking forbids it (`wall`). A side with no connected
 * node at all renders as a single neutral line; a side with one or more connected nodes divides
 * evenly among them, each getting its own colored sub-segment — `undefined` (preset "optional
 * connection") too, but desaturated (`disabledOf`) to read as tentative rather than a real
 * passage. A `wall` face draws nothing at all for that node (forbidding a face is drawn as an
 * *absence*, not a distinct color). A boundary side (no neighboring tile outside the field) is not
 * clickable — clicking it shows an inline hint instead. The active node's own segments/connectors
 * always draw last (on top of every other node's).
 *
 * The geometric layout itself (dividing a face among connected nodes, straightening a 2-passage
 * connector, hub-point fan-out, z-order) is `splitFaceLayout.ts`'s shared algorithm — the same one
 * the post-generation canvas (`SplitJunctionRenderer`) uses, so the two never drift apart. Each
 * node's connector (hub/straight-through line to a face's own segment) and the face segment itself
 * always match: a one-way's arrowhead sits only on the connector, never on the along-face
 * segment. */
export function TileFaceEditor({ point, cfg, nodes, activeIndex, onFaceClick, onFaceRightClick, onRotate }: Props) {
  const [boundaryHint, setBoundaryHint] = useState(false);
  const diagram = getTileDiagram(point[0], point[1], cfg);
  if (!diagram) return null;

  const { vertices, sides } = diagram;
  const xs = vertices.map(v => v.x);
  const ys = vertices.map(v => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  // `pad` must scale with the tile's own coordinate units (`TILE_SIZE`-based, tens of units), not
  // a fixed pixel-like constant — a fixed `pad = 24` next to a ~40-unit tile ate most of the
  // viewBox as empty margin, rendering the tile tiny in the middle of its own (correctly
  // full-size) SVG viewport. Rotate buttons no longer live inside this SVG (GitHub issue #234
  // follow-up — moved to plain HTML buttons below the diagram), so the viewBox no longer needs
  // the extra side padding they used to require.
  const pad = Math.max(w, h) * 0.08;
  const viewBox = `${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`;
  const polygonPoints = vertices.map(v => `${v.x},${v.y}`).join(" ");
  const strokeWidth = Math.max(w, h) * 0.05;

  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) =>
    ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  // Arrowhead for a connector line (hub/center -> face share, or share -> share for a straight
  // 2-passage connector): a triangle at the line's midpoint, tip pointing along the line's own
  // direction — `out` (true) points from `from` toward `to` (away from the hub, toward the face,
  // i.e. this node's passage runs outward); `false` points the other way.
  const arrowMarker = (from: { x: number; y: number }, to: { x: number; y: number }, out: boolean) => {
    const c = lerp(from, to, 0.5);
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const dir = out ? 1 : -1;
    const ux = (dx / len) * dir, uy = (dy / len) * dir;
    const perpX = -uy, perpY = ux;
    const size = strokeWidth * 1.6;
    const tipX = c.x + ux * size, tipY = c.y + uy * size;
    const baseX = c.x - ux * size * 0.6, baseY = c.y - uy * size * 0.6;
    return `${tipX},${tipY} ${baseX + perpX * size * 0.5},${baseY + perpY * size * 0.5} ${baseX - perpX * size * 0.5},${baseY - perpY * size * 0.5}`;
  };

  const faceInputs = sides.map((side) => ({ v0: side.v0, v1: side.v1 }));
  // `?? "wall"` is a defensive fallback for a malformed `faces` array (shorter than the
  // tessellation's real face count) — should never happen with consistent caller data, but
  // `"none"` isn't a valid `SplitFaceKind` (see splitFaceLayout.ts's module doc comment) and a
  // bogus fallback literal here would silently typecheck (TS narrows an impossible `??` default
  // away instead of flagging it) while still being reachable at runtime.
  const kindsByFace = sides.map((side) =>
    nodes.map((n, nodeIndex) => ({ nodeIndex, kind: n.faces[side.index]?.kind ?? "wall" })));
  const faceLayouts = computeSplitFaceLayouts(faceInputs, kindsByFace, activeIndex);

  const centerX = 0, centerY = 0;
  const hubRadius = Math.max(w, h) * 0.12;
  const rotationRad = (cfg.type === "square" || cfg.type === "square_custom" ? 45 : 0) * Math.PI / 180;
  const connectors = computeSplitConnectors(
    faceLayouts, nodes.length, activeIndex, { x: centerX, y: centerY }, hubRadius, rotationRad,
  );

  const colorFor = (nodeIndex: number, kind: TileFaceKind) => {
    const color = nodes[nodeIndex]?.color ?? ui.border.default;
    return kind === "undefined" ? disabledOf(color) : color;
  };

  // Per-face segments, grouped by node — `connectors` is already in strict draw order (active
  // node last), so rendering each node's connector immediately followed by its own face segments,
  // node by node in that same order, keeps the active node's entire drawing on top everywhere, not
  // just within the connector or segment group separately (GitHub issue #234 follow-up).
  const segmentsByNode = new Map<number, { faceIndex: number; v0: { x: number; y: number }; v1: { x: number; y: number }; kind: TileFaceKind }[]>();
  faceLayouts.forEach((layout, faceIndex) => {
    for (const seg of layout.segments) {
      const list = segmentsByNode.get(seg.nodeIndex);
      const entry = { faceIndex, v0: seg.v0, v1: seg.v1, kind: seg.kind };
      if (list) list.push(entry); else segmentsByNode.set(seg.nodeIndex, [entry]);
    }
  });

  return (
    <div style={styles.outer}>
    <div style={styles.wrap}>
      <svg viewBox={viewBox} style={styles.svg}>
        <polygon points={polygonPoints} fill={ui.bg.panelAlt} stroke="none" style={{ pointerEvents: "none" }} />
        {/* Click/right-click hit targets, one per face — a separate layer from the visual drawing
         * below so per-face interaction doesn't force per-face z-order on the drawing itself. */}
        {sides.map((side) => {
          const boundary = nodes[0]?.faces[side.index]?.boundary ?? false;
          return (
            <g
              key={side.index}
              onClick={() => (!boundary ? onFaceClick(side.index) : setBoundaryHint(true))}
              onContextMenu={(e) => { e.preventDefault(); if (!boundary) onFaceRightClick(side.index); }}
              onMouseLeave={() => setBoundaryHint(false)}
              style={{ cursor: "default" }}
            >
              <line x1={side.v0.x} y1={side.v0.y} x2={side.v1.x} y2={side.v1.y}
                stroke="transparent" strokeWidth={strokeWidth * 4} />
            </g>
          );
        })}
        {/* Boundary sides drawn first (deepest) — a field-edge face has no node connections, so
         * nothing else ever needs to sit under it. Solid white, not dashed — reads as a definite
         * field edge, not a tentative/undecided state. */}
        {sides.map((side) => {
          const boundary = nodes[0]?.faces[side.index]?.boundary ?? false;
          return boundary ? (
            <line key={`b${side.index}`} x1={side.v0.x} y1={side.v0.y} x2={side.v1.x} y2={side.v1.y}
              stroke={ui.text.inverse} strokeWidth={strokeWidth} strokeLinecap="round"
              style={{ pointerEvents: "none" }} />
          ) : null;
        })}
        {/* A face every node explicitly walls off draws as one plain solid wall spanning the whole
         * face (same visual language as an ordinary non-split wall) — distinct from the thinner
         * neutral placeholder below, which means "not yet decided", not "forbidden by everyone". */}
        {sides.map((side, sideIndex) => {
          const boundary = nodes[0]?.faces[side.index]?.boundary ?? false;
          return !boundary && faceLayouts[sideIndex].allWall ? (
            <line key={`w${side.index}`} x1={side.v0.x} y1={side.v0.y} x2={side.v1.x} y2={side.v1.y}
              stroke={ui.border.strong} strokeWidth={strokeWidth} strokeLinecap="round" style={{ pointerEvents: "none" }} />
          ) : null;
        })}
        {/* A face with no connected node at all draws once as a shared neutral line (not
         * attributable to any node) — independent of the per-node z-order below. */}
        {sides.map((side, sideIndex) => {
          const boundary = nodes[0]?.faces[side.index]?.boundary ?? false;
          return !boundary && faceLayouts[sideIndex].segments.length === 0 && !faceLayouts[sideIndex].allWall ? (
            <line key={`n${side.index}`} x1={side.v0.x} y1={side.v0.y} x2={side.v1.x} y2={side.v1.y}
              stroke={ui.border.default} strokeWidth={strokeWidth} strokeLinecap="round" style={{ pointerEvents: "none" }} />
          ) : null;
        })}
        {/* Per-node groups, in `connectors`' own draw order (active node last) — each node's
         * connector and every one of its own face segments render together, so the active node's
         * entire drawing sits on top everywhere, not just within the connector or segment set
         * considered separately (GitHub issue #234 follow-up). */}
        {connectors.map((connector) => {
          const color = nodes[connector.nodeIndex]?.color ?? ui.border.default;
          return (
            <g key={connector.nodeIndex} style={{ pointerEvents: "none" }}>
              {(segmentsByNode.get(connector.nodeIndex) ?? []).map((seg, i) => (
                <line key={`s${i}`} x1={seg.v0.x} y1={seg.v0.y} x2={seg.v1.x} y2={seg.v1.y}
                  stroke={colorFor(connector.nodeIndex, seg.kind)} strokeWidth={strokeWidth} strokeLinecap="round" />
              ))}
              {connector.lines.map((line, i) => (
                <line key={`c${i}`} x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
                  stroke={line.isUndefined ? disabledOf(color) : color} strokeWidth={strokeWidth} strokeLinecap="round" />
              ))}
              {connector.lines.map((line, i) => line.oneWayOut === undefined ? null : (
                <polygon key={`a${i}`} points={arrowMarker(line.from, line.to, line.oneWayOut)}
                  fill={line.isUndefined ? disabledOf(color) : color} stroke={ui.bg.panelAlt} strokeWidth={strokeWidth * 0.25} strokeLinejoin="round" />
              ))}
            </g>
          );
        })}
      </svg>
      {boundaryHint && (
        <div style={styles.hint}>{m["post_edit.split_boundary_hint"]()}</div>
      )}
    </div>
    <div style={styles.rotateRow}>
      <span style={typography.body}>{m["post_edit.split_rotate_label"]()}</span>
      <button className="hoverable" style={styles.rotateBtn} onClick={() => onRotate(1)} title={m["post_edit.split_rotate_ccw"]()}>
        <RotateCcw size={16} />
      </button>
      <button className="hoverable" style={styles.rotateBtn} onClick={() => onRotate(-1)} title={m["post_edit.split_rotate_cw"]()}>
        <RotateCw size={16} />
      </button>
    </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Outer column: the tile diagram (`wrap`, grows to fill available space) stacked above the
  // rotate-buttons row (fixed height) — the rotate buttons used to live inside the SVG itself
  // (GitHub issue #234 follow-up: moved out to plain HTML buttons below the diagram instead).
  outer: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  // The tile diagram's viewBox is roughly square — without an explicit square aspect ratio, `wrap`
  // grows to fill whatever box shape its flex parent gives it (often taller than wide, since the
  // dialog's left panel is a narrow, tall column), and the SVG's default `preserveAspectRatio`
  // then fits it by the *shorter* dimension, leaving large empty margins on the other axis.
  // `alignSelf: "center"` opts `wrap` out of the flex column's default cross-axis stretch — with a
  // stretched (100%-of-parent) width AND a `flex: 1` height both externally fixed, `aspectRatio`
  // has no free dimension to resolve and is a no-op. Freeing the width lets `aspectRatio` derive
  // it from the `flex: 1`-resolved height instead; `maxWidth: 100%` then clamps (and, per spec,
  // proportionally shrinks the height too) if that derived width would overflow the panel.
  wrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    alignSelf: "center",
    aspectRatio: "1 / 1",
    maxWidth: "100%",
    maxHeight: "100%",
    minWidth: 0,
    minHeight: 0,
  },
  svg: {
    width: "100%",
    height: "100%",
    maxWidth: "100%",
    maxHeight: "100%",
  },
  hint: {
    ...typography.body,
    position: "absolute",
    bottom: spacing.groupGap,
    left: spacing.groupGap,
    right: spacing.groupGap,
    padding: spacing.itemGap,
    background: ui.bg.warning,
    color: ui.text.warning,
    borderRadius: radius.md,
    textAlign: "center",
  },
  rotateRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.groupGap,
    flexShrink: 0,
  },
  rotateBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: `1px solid ${ui.border.default}`,
    background: ui.bg.panelAlt,
    color: ui.text.secondary,
    cursor: "pointer",
    padding: 0,
  },
};
