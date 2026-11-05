import { Graphics, Rectangle, type Container } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import type { PointerHandler, ViewportListener } from "../sceneTypes";
import { toViewportCoordinates } from "../pointerInteraction";
import { getCellCenter, getCellVertices } from "../tessellationGeometry";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";
import { distanceToSegment } from "./cutLines";
import { CUBIC_SAMPLE_STEPS, curveControls, editableCurvePoints, manualPathMode, straightCubicControls, teleportConnectorKey } from "../renderers/teleportConnectorManual";
import type { TeleportEdge } from "../renderers/types";
import { notifyTeleportConnectorEndpointCannotBeRemoved } from "../../notifications/teleportConnectorEditNotifications";

type Drawn = { edge: TeleportEdge; points: readonly number[] };
const HIT_PX = 10;

/** Owns interaction and its disposable canvas-only affordances.  This Graphics is attached beside
 * export overlays, never to a mode renderer, so PNG exporters cannot include it. */
export class TeleportConnectorEditController implements PointerHandler, ViewportListener {
  private readonly view = new Graphics();
  private dragging: { key: string; index: number; original: [number, number]; originalPath: number[]; alignmentLocked: boolean } | null = null;
  private pendingPan: { x: number; y: number } | null = null;
  private panning = false;

  constructor(
    private readonly getViewport: () => Container,
    private readonly paths: () => readonly Drawn[],
    private readonly pan: { start(x: number, y: number): void; move(x: number, y: number): void; end(): void },
    container: Container,
  ) {
    // Pixi only dispatches stage events through an interactive hit target.  The regular export
    // picture is deliberately non-interactive, so give the modal editor its own full-canvas hit
    // plane and stop propagation to avoid the shared pan handler processing the same gesture.
    this.view.hitArea = new Rectangle(-1_000_000, -1_000_000, 2_000_000, 2_000_000);
    this.view.on("pointerdown", (e) => { e.stopPropagation(); this.onPointerDown(e.globalX, e.globalY, e.button); });
    this.view.on("pointermove", (e) => { e.stopPropagation(); this.onPointerMove(e.globalX, e.globalY, e.buttons, e.shiftKey, e.ctrlKey, e.metaKey, e.altKey); });
    this.view.on("pointerup", (e) => { e.stopPropagation(); this.onPointerUp(); });
    container.addChild(this.view);
  }

  render(): void {
    this.view.clear();
    const st = useMazeStore.getState();
    const edit = st.teleportConnectorEdit;
    const active = !!edit && st.openCard === "image_export" && st.activeRenderMode === edit.renderMode;
    this.view.eventMode = active ? "static" : "none";
    if (!active || !edit) return;
    const paths = this.paths();
    const selected = edit.selected;
    const r = 5 / Math.max(this.getViewport().scale.x, 1e-9);
    const manualPaths = st.vectorByWallsSettings.manualTeleportConnectorPaths ?? {};
    for (const { edge, points } of paths) {
      const key = teleportConnectorKey(edge);
      if (!key || points.length < 4) continue;
      const authored = manualPaths[key];
      const editable = authored ? manualPathMode(authored) === "curve" ? editableCurvePoints(authored) : authored.nodes.flat() : points;
      // Guides are behind every point marker, especially the selected anchor.
      if (authored && manualPathMode(authored) === "curve" && selected?.key === key && selected.index % 3 === 0) {
        for (let i = 0; i < editable.length; i += 2) {
          const index = i / 2;
          if (index % 3 === 0) continue;
          const anchor = index % 3 === 1 ? index - 1 : index + 1;
          if (anchor === selected.index) this.drawDottedGuide(editable[i], editable[i + 1], editable[anchor * 2], editable[anchor * 2 + 1], r);
        }
      }
      for (let i = 0; i < editable.length; i += 2) {
        const index = i / 2;
        const control = authored && manualPathMode(authored) === "curve" && index % 3 !== 0;
        const anchor = index % 3 === 1 ? index - 1 : index % 3 === 2 ? index + 1 : index;
        const shownControl = !!control && selected?.key === key && selected.index === anchor;
        if (control && !shownControl) continue;
        const chosen = selected?.key === key && selected.index === index;
        this.view.circle(editable[i], editable[i + 1], chosen ? r * 1.45 : control ? r * .8 : r).fill(chosen ? 0xffc107 : control ? 0x95a5a6 : 0x2d9cdb).stroke({ width: r * .35, color: 0xffffff });
      }
    }
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const st = useMazeStore.getState();
    if (!st.teleportConnectorEdit) return;
    const p = toViewportCoordinates(canvasX, canvasY, this.getViewport());
    const hit = this.pointHit(p.x, p.y);
    if (button === 2) {
      const authored = hit && st.vectorByWallsSettings.manualTeleportConnectorPaths?.[hit.key];
      if (authored && manualPathMode(authored) === "curve" && hit!.index % 3 !== 0) return;
      if (hit && hit.index > 0 && hit.index < hit.points.length / 2 - 1) this.remove(hit.key, hit.index);
      else if (hit) notifyTeleportConnectorEndpointCannotBeRemoved();
      return;
    }
    if (button === 1) { this.panning = true; this.pan.start(canvasX, canvasY); return; }
    if (button !== 0) return;
    if (hit) {
      const authored = st.vectorByWallsSettings.manualTeleportConnectorPaths?.[hit.key];
      const anchor = authored && manualPathMode(authored) === "curve" && hit.index % 3 !== 0 ? hit.index % 3 === 1 ? hit.index - 1 : hit.index + 1 : hit.index;
      st.setTeleportConnectorEditSelection({ key: hit.key, index: anchor });
      this.dragging = { key: hit.key, index: hit.index, original: [hit.points[hit.index * 2], hit.points[hit.index * 2 + 1]], originalPath: [...hit.points], alignmentLocked: this.isCurvePairAligned(hit.key, hit.index, hit.points) };
      return;
    }
    const segment = this.segmentHit(p.x, p.y);
    if (!segment) { st.setTeleportConnectorEditSelection(null); this.pendingPan = { x: canvasX, y: canvasY }; return; }
    const existing = st.vectorByWallsSettings.manualTeleportConnectorPaths?.[segment.key];
    if (existing && manualPathMode(existing) === "curve") {
      const nodeIndex = Math.min(existing.nodes.length - 2, Math.floor(segment.index / CUBIC_SAMPLE_STEPS));
      const originalPath = this.path(segment.key) ?? [];
      const { nodes, controls } = this.splitCurveSegment(existing, nodeIndex, (segment.index % CUBIC_SAMPLE_STEPS + .5) / CUBIC_SAMPLE_STEPS);
      this.write(segment.key, editableCurvePoints({ mode: "curve", nodes, controls }));
      const index = (nodeIndex + 1) * 3;
      st.setTeleportConnectorEditSelection({ key: segment.key, index });
      this.dragging = { key: segment.key, index, original: nodes[nodeIndex + 1], originalPath, alignmentLocked: false };
      return;
    }
    const points = this.materialize(segment);
    const insertionIndex = segment.index;
    points.splice((insertionIndex + 1) * 2, 0, p.x, p.y);
    this.write(segment.key, points);
    st.setTeleportConnectorEditSelection({ key: segment.key, index: insertionIndex + 1 });
    this.dragging = { key: segment.key, index: insertionIndex + 1, original: [p.x, p.y], originalPath: [...points], alignmentLocked: false };
  }

  onPointerMove(canvasX: number, canvasY: number, _buttons?: number, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean): void {
    if (this.panning) { this.pan.move(canvasX, canvasY); return; }
    if (this.pendingPan) {
      this.panning = true;
      this.pan.start(this.pendingPan.x, this.pendingPan.y);
      this.pendingPan = null;
      this.pan.move(canvasX, canvasY);
      return;
    }
    if (!this.dragging) return;
    const p = toViewportCoordinates(canvasX, canvasY, this.getViewport());
    const point = ctrlKey || metaKey ? this.snap(p.x, p.y) : [p.x, p.y] as [number, number];
    const current = this.path(this.dragging.key);
    if (!current) return;
    const authored = useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths?.[this.dragging.key];
    if (authored && manualPathMode(authored) === "curve") this.moveCurvePoint(current, this.dragging.index, point, !!shiftKey, !!altKey, this.dragging.alignmentLocked);
    else { current[this.dragging.index * 2] = point[0]; current[this.dragging.index * 2 + 1] = point[1]; }
    this.write(this.dragging.key, current);
  }

  onPointerUp(): void {
    this.dragging = null;
    this.pendingPan = null;
    if (this.panning) { this.panning = false; this.pan.end(); }
  }
  cancelPointerGesture(): void {
    if (this.dragging) {
      this.write(this.dragging.key, this.dragging.originalPath);
    }
    this.dragging = null;
    this.pendingPan = null;
    if (this.panning) { this.panning = false; this.pan.end(); }
  }
  escape(): void {
    if (this.dragging) { this.cancelPointerGesture(); return; }
    const st = useMazeStore.getState();
    if (st.teleportConnectorEdit?.selected) st.setTeleportConnectorEditSelection(null); else st.finishTeleportConnectorEdit();
  }
  deleteSelected(): void {
    const st = useMazeStore.getState(), selected = st.teleportConnectorEdit?.selected;
    if (!selected) return;
    const points = this.path(selected.key); if (!points) return;
    if (selected.index === 0 || selected.index === points.length / 2 - 1) {
      notifyTeleportConnectorEndpointCannotBeRemoved();
      return;
    }
    const authored = useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths?.[selected.key];
    if (authored && manualPathMode(authored) === "curve") { this.remove(selected.key, selected.index); return; }
    points.splice(selected.index * 2, 2); this.write(selected.key, points); st.setTeleportConnectorEditSelection(null);
  }
  destroy(): void { this.view.destroy(); }
  get isViewportPanning(): boolean { return this.panning; }
  onViewportChanged(): void { this.render(); }

  private tolerance(): number { return HIT_PX / Math.max(this.getViewport().scale.x, 1e-9); }
  private pointHit(x: number, y: number): { key: string; index: number; points: number[] } | null {
    const t = this.tolerance();
    for (const d of this.paths()) { const key = teleportConnectorKey(d.edge); if (!key) continue; const points = this.path(key) ?? this.materialize(d);
      const authored = useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths?.[key], selected = useMazeStore.getState().teleportConnectorEdit?.selected;
      for (let i = 0; i < points.length; i += 2) {
        const index = i / 2, control = authored && manualPathMode(authored) === "curve" && index % 3 !== 0;
        const anchor = index % 3 === 1 ? index - 1 : index % 3 === 2 ? index + 1 : index;
        if (control && (selected?.key !== key || selected.index !== anchor)) continue;
        if (Math.hypot(x - points[i], y - points[i + 1]) <= t) return { key, index, points };
      }
    } return null;
  }
  private segmentHit(x: number, y: number): { key: string; index: number; drawn: Drawn } | null {
    let best: { key: string; index: number; drawn: Drawn } | null = null, distance = this.tolerance();
    for (const drawn of this.paths()) { const key = teleportConnectorKey(drawn.edge); if (!key) continue;
      for (let i = 0; i + 3 < drawn.points.length; i += 2) { const d = distanceToSegment([x, y], [drawn.points[i], drawn.points[i + 1]], [drawn.points[i + 2], drawn.points[i + 3]]); if (d <= distance) { best = { key, index: i / 2, drawn }; distance = d; } }
    } return best;
  }
  private drawDottedGuide(x1: number, y1: number, x2: number, y2: number, r: number): void {
    const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy), dash = r * 1.1, gap = r * .7;
    if (length === 0) return;
    for (let offset = 0; offset < length; offset += dash + gap) {
      const end = Math.min(offset + dash, length);
      this.view.moveTo(x1 + dx * offset / length, y1 + dy * offset / length).lineTo(x1 + dx * end / length, y1 + dy * end / length).stroke({ width: r * .28, color: 0x95a5a6, alpha: .8, cap: "butt" });
    }
  }
  private splitCurveSegment(path: { nodes: [number, number][]; controls?: [number, number][] }, segment: number, t: number): { nodes: [number, number][]; controls: [number, number][] } {
    const nodes = [...path.nodes], controls = [...curveControls(path)];
    const a = nodes[segment], c1 = controls[segment * 2], c2 = controls[segment * 2 + 1], b = nodes[segment + 1];
    const mix = (from: [number, number], to: [number, number]): [number, number] => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    const ac1 = mix(a, c1), c1c2 = mix(c1, c2), c2b = mix(c2, b);
    const leftControl2 = mix(ac1, c1c2), rightControl1 = mix(c1c2, c2b), node = mix(leftControl2, rightControl1);
    nodes.splice(segment + 1, 0, node);
    controls.splice(segment * 2, 2, ac1, leftControl2, rightControl1, c2b);
    return { nodes, controls };
  }
  private isCurvePairAligned(key: string, index: number, points: readonly number[]): boolean {
    const authored = useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths?.[key];
    if (!authored || manualPathMode(authored) !== "curve" || index % 3 === 0) return false;
    const anchor = index % 3 === 1 ? index - 1 : index + 1;
    const paired = index % 3 === 1 ? index - 2 : index + 2;
    if (paired < 0 || paired >= points.length / 2) return false;
    const ax = points[anchor * 2], ay = points[anchor * 2 + 1];
    const dx = points[index * 2] - ax, dy = points[index * 2 + 1] - ay;
    const pdx = points[paired * 2] - ax, pdy = points[paired * 2 + 1] - ay;
    const lengths = Math.hypot(dx, dy) * Math.hypot(pdx, pdy);
    return lengths > 0 && dx * pdx + dy * pdy < 0 && Math.abs(dx * pdy - dy * pdx) / lengths < .02;
  }
  private moveCurvePoint(points: number[], index: number, point: readonly [number, number], symmetric: boolean, breakAlignment: boolean, alignmentLocked: boolean): void {
    const offset = index * 2, before: [number, number] = [points[offset], points[offset + 1]];
    points[offset] = point[0]; points[offset + 1] = point[1];
    if (index % 3 === 0) {
      const dx = point[0] - before[0], dy = point[1] - before[1];
      for (const control of [index - 1, index + 1]) if (control >= 0 && control < points.length / 2 && control % 3 !== 0) {
        points[control * 2] += dx; points[control * 2 + 1] += dy;
      }
      return;
    }
    const anchor = index % 3 === 1 ? index - 1 : index + 1;
    const paired = index % 3 === 1 ? index - 2 : index + 2;
    if (breakAlignment || paired < 0 || paired >= points.length / 2) return;
    const ax = points[anchor * 2], ay = points[anchor * 2 + 1];
    const dx = point[0] - ax, dy = point[1] - ay, length = Math.hypot(dx, dy);
    const pairedLength = Math.hypot(points[paired * 2] - ax, points[paired * 2 + 1] - ay);
    if (length === 0 || pairedLength === 0) return;
    const pdx = points[paired * 2] - ax, pdy = points[paired * 2 + 1] - ay;
    const snap = (dx * pdx + dy * pdy) < 0 && Math.abs(dx * pdy - dy * pdx) / (length * pairedLength) < .14;
    if (alignmentLocked || symmetric) {
      const otherLength = symmetric ? length : pairedLength;
      points[paired * 2] = ax - dx / length * otherLength;
      points[paired * 2 + 1] = ay - dy / length * otherLength;
    } else if (snap) {
      // A free (already broken) pair only snaps the dragged point for this pointer position.
      points[offset] = ax - pdx / pairedLength * length;
      points[offset + 1] = ay - pdy / pairedLength * length;
    }
  }
  private path(key: string): number[] | null {
    const authored = useMazeStore.getState().vectorByWallsSettings.manualTeleportConnectorPaths?.[key];
    if (authored) return manualPathMode(authored) === "curve" ? editableCurvePoints(authored) : authored.nodes.flat();
    const drawn = this.paths().find((candidate) => teleportConnectorKey(candidate.edge) === key);
    return drawn ? [...drawn.points] : null;
  }
  private materialize(drawn: Drawn | { key: string; drawn: Drawn }): number[] {
    if ("key" in drawn) return this.path(drawn.key) ?? [...drawn.drawn.points];
    const key = teleportConnectorKey(drawn.edge);
    return key ? this.path(key) ?? [...drawn.points] : [...drawn.points];
  }
  private write(key: string, points: number[]): void {
    const st = useMazeStore.getState(), paths = { ...(st.vectorByWallsSettings.manualTeleportConnectorPaths ?? {}) };
    const mode = paths[key]?.mode ?? "polyline";
    if (mode === "curve") {
      const sequence = points.reduce<[number, number][]>((out, _v, i) => { if ((i & 1) === 0) out.push([points[i], points[i + 1]]); return out; }, []);
      paths[key] = { mode, nodes: sequence.filter((_, i) => i % 3 === 0), controls: sequence.filter((_, i) => i % 3 !== 0) };
    } else paths[key] = { mode, nodes: points.reduce<[number, number][]>((out, _v, i) => { if ((i & 1) === 0) out.push([points[i], points[i + 1]]); return out; }, []) };
    st.setManualTeleportConnectorPaths(paths); this.render();
  }
  private remove(key: string, index: number): void {
    const st = useMazeStore.getState(), authored = st.vectorByWallsSettings.manualTeleportConnectorPaths?.[key];
    if (authored && manualPathMode(authored) === "curve") {
      // Only anchors can be selected for deletion; handles are exposed only while their anchor is selected.
      const nodeIndex = Math.floor(index / 3);
      if (nodeIndex <= 0 || nodeIndex >= authored.nodes.length - 1) { notifyTeleportConnectorEndpointCannotBeRemoved(); return; }
      const nodes = [...authored.nodes];
      nodes.splice(nodeIndex, 1);
      this.write(key, editableCurvePoints({ mode: "curve", nodes, controls: straightCubicControls(nodes) }));
      st.setTeleportConnectorEditSelection(null);
      return;
    }
    const points = this.path(key); if (!points) return;
    points.splice(index * 2, 2); this.write(key, points); st.setTeleportConnectorEditSelection(null);
  }
  private snap(x: number, y: number): [number, number] {
    const st = useMazeStore.getState(), cfg = st.activeFieldConfig, t = this.tolerance(); let best: [number, number] = [x, y], d = t;
    const { nodes } = selectFloorScopedMaze(st.nodes, st.edges, st.floors, st.activeFloorId);
    for (const { x: cx, y: cy } of nodes) { const vs = getCellVertices(cx, cy, cfg); const candidates = [getCellCenter(cx, cy, cfg), ...vs, ...vs.map((v, i) => ({ x: (v.x + vs[(i + 1) % vs.length].x) / 2, y: (v.y + vs[(i + 1) % vs.length].y) / 2 }))]; for (const p of candidates) { const q = Math.hypot(x - p.x, y - p.y); if (q <= d) { best = [p.x, p.y]; d = q; } } }
    return best;
  }
}
