import { describe, it, expect } from "vitest";
import { BaseController } from "../pixi/BaseController";
import type { FieldEdge } from "../pixi/fieldEditUtils";
import type { Container } from "pixi.js";

/** Exposes BaseController's protected members as public so tests can drive them directly,
 * without needing a real pixi.js Container/viewport. */
class TestController extends BaseController {
  constructor() {
    super(() => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }) as unknown as Container, () => {});
  }

  beginEdgeDrag(edgeKey: string): void { super.beginEdgeDrag(edgeKey); }
  continueEdgeDrag(edge: FieldEdge | null, onNewEdge: (edge: FieldEdge) => void): void { super.continueEdgeDrag(edge, onNewEdge); }
  beginCellDrag(point: [number, number]): void { super.beginCellDrag(point); }
  continueCellDrag(point: [number, number] | null, onNewCell: (point: [number, number]) => void): void { super.continueCellDrag(point, onNewCell); }
  endEdgeDrag(): void { super.endEdgeDrag(); }
  get isDragActive(): boolean { return super.isDragActive; }

  armMarkerDrag(marker: "set_start" | "set_finish"): void { super.armMarkerDrag(marker); }
  releaseMarkerDrag(): void { super.releaseMarkerDrag(); }
  getDraggingMarker(): "set_start" | "set_finish" | null { return this.draggingMarker; }

  clearHover(): void {}
}

function edge(key: string): FieldEdge {
  return { key, from: [0, 0], to: [1, 0] };
}

describe("BaseController edge drag", () => {
  it("is not active before beginEdgeDrag", () => {
    const c = new TestController();
    expect(c.isDragActive).toBe(false);
  });

  it("beginEdgeDrag activates drag and seeds the visited set with the starting edge", () => {
    const c = new TestController();
    c.beginEdgeDrag("a");
    expect(c.isDragActive).toBe(true);

    const seen: string[] = [];
    c.continueEdgeDrag(edge("a"), (e) => seen.push(e.key));
    expect(seen).toEqual([]); // starting edge already in dragVisited — not re-applied
  });

  it("continueEdgeDrag applies each newly-entered edge once", () => {
    const c = new TestController();
    c.beginEdgeDrag("a");

    const seen: string[] = [];
    c.continueEdgeDrag(edge("b"), (e) => seen.push(e.key));
    c.continueEdgeDrag(edge("b"), (e) => seen.push(e.key)); // re-entering same edge — no-op
    c.continueEdgeDrag(edge("c"), (e) => seen.push(e.key));

    expect(seen).toEqual(["b", "c"]);
  });

  it("continueEdgeDrag is a no-op when drag is not active", () => {
    const c = new TestController();
    const seen: string[] = [];
    c.continueEdgeDrag(edge("a"), (e) => seen.push(e.key));
    expect(seen).toEqual([]);
  });

  it("continueEdgeDrag is a no-op when edge is null (cursor left the field)", () => {
    const c = new TestController();
    c.beginEdgeDrag("a");
    const seen: string[] = [];
    c.continueEdgeDrag(null, (e) => seen.push(e.key));
    expect(seen).toEqual([]);
  });

  it("endEdgeDrag clears active state and visited set", () => {
    const c = new TestController();
    c.beginEdgeDrag("a");
    c.endEdgeDrag();
    expect(c.isDragActive).toBe(false);

    const seen: string[] = [];
    c.continueEdgeDrag(edge("a"), (e) => seen.push(e.key));
    expect(seen).toEqual([]);
  });

  it("endEdgeDrag is idempotent — safe to call when no drag was active", () => {
    const c = new TestController();
    expect(() => c.endEdgeDrag()).not.toThrow();
    expect(c.isDragActive).toBe(false);
  });

  it("a new beginEdgeDrag resets the visited set (does not carry over the previous session)", () => {
    const c = new TestController();
    c.beginEdgeDrag("a");
    c.continueEdgeDrag(edge("b"), () => {});
    c.endEdgeDrag();

    c.beginEdgeDrag("b"); // "b" was visited in the previous session, now starts a new one
    const seen: string[] = [];
    c.continueEdgeDrag(edge("b"), (e) => seen.push(e.key));
    expect(seen).toEqual([]); // "b" is the new session's starting edge, already seeded
  });
});

describe("BaseController cell drag", () => {
  it("beginCellDrag activates drag and seeds the visited set with the starting cell", () => {
    const c = new TestController();
    c.beginCellDrag([0, 0]);
    expect(c.isDragActive).toBe(true);

    const seen: [number, number][] = [];
    c.continueCellDrag([0, 0], (p) => seen.push(p));
    expect(seen).toEqual([]); // starting cell already visited
  });

  it("continueCellDrag applies each newly-entered cell once", () => {
    const c = new TestController();
    c.beginCellDrag([0, 0]);

    const seen: [number, number][] = [];
    c.continueCellDrag([1, 0], (p) => seen.push(p));
    c.continueCellDrag([1, 0], (p) => seen.push(p)); // re-entering same cell — no-op
    c.continueCellDrag([2, 0], (p) => seen.push(p));

    expect(seen).toEqual([[1, 0], [2, 0]]);
  });

  it("continueCellDrag is a no-op when drag is not active", () => {
    const c = new TestController();
    const seen: [number, number][] = [];
    c.continueCellDrag([1, 0], (p) => seen.push(p));
    expect(seen).toEqual([]);
  });

  it("continueCellDrag is a no-op when cell is null (cursor left the field)", () => {
    const c = new TestController();
    c.beginCellDrag([0, 0]);
    const seen: [number, number][] = [];
    c.continueCellDrag(null, (p) => seen.push(p));
    expect(seen).toEqual([]);
  });

  it("endEdgeDrag clears an active cell drag too (shared bookkeeping)", () => {
    const c = new TestController();
    c.beginCellDrag([0, 0]);
    c.endEdgeDrag();
    expect(c.isDragActive).toBe(false);

    const seen: [number, number][] = [];
    c.continueCellDrag([0, 0], (p) => seen.push(p));
    expect(seen).toEqual([]);
  });

  it("a cell drag and an edge drag never share a visited-set key (namespaced)", () => {
    const c = new TestController();
    // Cell branch starts the gesture, then the cursor grazes an edge whose key happens to
    // stringify like the cell's — the `cell:` prefix keeps them distinct so the edge still fires.
    c.beginCellDrag([1, 0]);
    const edgeSeen: string[] = [];
    c.continueEdgeDrag(edge("1,0"), (e) => edgeSeen.push(e.key));
    expect(edgeSeen).toEqual(["1,0"]);
  });
});

describe("BaseController marker drag", () => {
  it("starts with no marker armed", () => {
    const c = new TestController();
    expect(c.getDraggingMarker()).toBeNull();
  });

  it("armMarkerDrag sets the dragging marker", () => {
    const c = new TestController();
    c.armMarkerDrag("set_start");
    expect(c.getDraggingMarker()).toBe("set_start");
  });

  it("releaseMarkerDrag clears the dragging marker", () => {
    const c = new TestController();
    c.armMarkerDrag("set_finish");
    c.releaseMarkerDrag();
    expect(c.getDraggingMarker()).toBeNull();
  });

  it("onPointerUp(button=0) releases an armed marker drag", () => {
    const c = new TestController();
    c.armMarkerDrag("set_start");
    c.onPointerUp(0);
    expect(c.getDraggingMarker()).toBeNull();
  });

  it("onPointerUp(button=1) (pan release) does not release a marker drag", () => {
    const c = new TestController();
    c.armMarkerDrag("set_start");
    c.onPointerUp(1);
    expect(c.getDraggingMarker()).toBe("set_start");
  });
});
