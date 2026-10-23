import { describe, it, expect, vi } from "vitest";

// Identity wasm mapping (square cell (x, y) IS its own cartesian coordinate), same rationale as
// `baseGraphRenderer.test.ts` — lets `buildNodePositions`/`buildCrossFloorMarkers` run without a
// real wasm module.
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

// Minimal fake pixi (same pattern as `RegionOverlayRenderer.test.ts`).
vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    children: unknown[] = [];
    x = 0;
    y = 0;
    interactive = false;
    cursor = "";
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
    addChild(child: unknown) { this.children.push(child); return child; }
    destroy() {}
    on() { return this; }
  }
  class FakeContainer {
    children: unknown[] = [];
    addChild(child: unknown) { this.children.push(child); return child; }
    removeChildren() { const c = this.children; this.children = []; return c; }
    destroy() {}
  }
  // Stands in for pixi's `BitmapText` (GitHub issue #352 — MSDF label font). Node labels are
  // constructed directly (top-left, no centering); cross-floor badge digits go through
  // `makeCenteredLabel`, which sets `anchor`/`pivot` — so both must exist here.
  class FakeBitmapText {
    anchor = { set: vi.fn() };
    pivot = { y: 0 };
    x = 0;
    y = 0;
    options: { text: string };
    constructor(opts: { text: string }) { this.options = opts; }
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics, BitmapText: FakeBitmapText, Cache: { get: () => undefined } };
});

const { MazeGraphRenderer } = await import("../pixi/MazeGraphRenderer");
const { Graphics: FakeGraphics, BitmapText: FakeText, Container } = await import("pixi.js");
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });
const n = (id: number, x: number, y: number, level: number): NodeDto => ({ id, x, y, i: 0, level });

/** Collects every descendant recursively (badge fill + digit Text land in the same overlay
 *  container tree). */
function allDescendants(root: { children: unknown[] }): unknown[] {
  const out: unknown[] = [];
  const walk = (c: { children?: unknown[] }) => {
    for (const child of c.children ?? []) {
      out.push(child);
      walk(child as { children?: unknown[] });
    }
  };
  walk(root);
  return out;
}

describe("MazeGraphRenderer — cross-floor badges for vertical edges (GitHub issue #461)", () => {
  it("draws a floor badge for a vertical_passage edge passed via crossFloorEdges", () => {
    const container = new Container();
    const renderer = new MazeGraphRenderer(container as never);

    // Active-floor node 1; node 2 lives on floor 1 and is NOT in `nodes` (floor-scoped).
    const nodes = [n(1, 2, 2, 0)];
    const edges: EdgeDto[] = []; // post-edit draft never carries the vertical edge
    const crossFloorEdges: EdgeDto[] = [{ from: 1, to: 2, kind: "vertical_passage" }];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const resolveNodeCell = (id: number): [number, number] | undefined =>
      id === 1 ? [2, 2] : id === 2 ? [2, 2] : undefined;

    renderer.render({
      nodes, edges,
      showNodeIds: false, showCoords: false,
      selectedNode: null, start: null, finish: null, cfg,
      interactive: false,
      resolveNodeLevel, resolveNodeCell, activeFloorIndex: 0,
      crossFloorEdges,
    });

    const digits = allDescendants(container as never).filter(
      (c): c is { options: { text: string } } => c instanceof FakeText,
    );
    // The badge's digit is the target floor's 1-based number: floor index 1 -> "2".
    expect(digits.map((d) => d.options.text)).toContain("2");
  });

  it("draws no direction arrow for a bidirectional vertical passage (both EdgeDto directions present)", () => {
    const container = new Container();
    const renderer = new MazeGraphRenderer(container as never);

    const nodes = [n(1, 2, 2, 0)];
    // A two-way passage is two directed EdgeDto entries; `selectFloorScopedMaze` would drop the
    // reverse one, so the renderer must receive both to know it is bidirectional (GitHub issue #461).
    const crossFloorEdges: EdgeDto[] = [
      { from: 1, to: 2, kind: "vertical_passage" },
      { from: 2, to: 1, kind: "vertical_passage" },
    ];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const resolveNodeCell = (id: number): [number, number] | undefined => (id === 1 ? [2, 2] : [2, 2]);

    renderer.render({
      nodes, edges: [],
      showNodeIds: false, showCoords: false,
      selectedNode: null, start: null, finish: null, cfg,
      interactive: false,
      resolveNodeLevel, resolveNodeCell, activeFloorIndex: 0,
      crossFloorEdges,
    });

    // The stub line is drawn (moveTo/lineTo) but no arrow head (poly).
    const graphics = allDescendants(container as never).filter(
      (c): c is { calls: { fn: string }[] } => c instanceof FakeGraphics,
    );
    const stubGraphics = graphics.find((g) => g.calls.some((k) => k.fn === "lineTo"));
    expect(stubGraphics).toBeDefined();
    const hasStubLine = stubGraphics!.calls.some((k) => k.fn === "lineTo");
    const hasArrow = stubGraphics!.calls.some((k) => k.fn === "poly");
    expect(hasStubLine).toBe(true);
    expect(hasArrow).toBe(false);
  });

  it("draws a direction arrow for a one-way vertical passage (single EdgeDto direction)", () => {
    const container = new Container();
    const renderer = new MazeGraphRenderer(container as never);

    const nodes = [n(1, 2, 2, 0)];
    const crossFloorEdges: EdgeDto[] = [{ from: 1, to: 2, kind: "vertical_passage" }];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const resolveNodeCell = (id: number): [number, number] | undefined => (id === 1 ? [2, 2] : [2, 2]);

    renderer.render({
      nodes, edges: [],
      showNodeIds: false, showCoords: false,
      selectedNode: null, start: null, finish: null, cfg,
      interactive: false,
      resolveNodeLevel, resolveNodeCell, activeFloorIndex: 0,
      crossFloorEdges,
    });

    const graphics = allDescendants(container as never).filter(
      (c): c is { calls: { fn: string }[] } => c instanceof FakeGraphics,
    );
    expect(graphics.some((g) => g.calls.some((k) => k.fn === "poly"))).toBe(true);
  });

  it("draws no cross-floor badge when crossFloorEdges is omitted", () => {
    const container = new Container();
    const renderer = new MazeGraphRenderer(container as never);

    const nodes = [n(1, 2, 2, 0)];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const resolveNodeCell = (id: number): [number, number] | undefined => (id === 1 ? [2, 2] : [2, 2]);

    renderer.render({
      nodes, edges: [],
      showNodeIds: false, showCoords: false,
      selectedNode: null, start: null, finish: null, cfg,
      interactive: false,
      resolveNodeLevel, resolveNodeCell, activeFloorIndex: 0,
    });

    const digits = allDescendants(container as never).filter((c) => c instanceof FakeText);
    expect(digits).toHaveLength(0);
  });

  it("adds the badge fill Graphics before its digit Text (z-order, GitHub issue #461/#449)", () => {
    const container = new Container();
    const renderer = new MazeGraphRenderer(container as never);

    const nodes = [n(1, 2, 2, 0)];
    const crossFloorEdges: EdgeDto[] = [{ from: 1, to: 2, kind: "elevator" }];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const resolveNodeCell = (id: number): [number, number] | undefined => (id === 1 ? [2, 2] : [2, 2]);

    renderer.render({
      nodes, edges: [],
      showNodeIds: false, showCoords: false,
      selectedNode: null, start: null, finish: null, cfg,
      interactive: false,
      resolveNodeLevel, resolveNodeCell, activeFloorIndex: 0,
      crossFloorEdges,
    });

    const descendants = allDescendants(container as never);
    const fillIdx = descendants.findIndex(
      (c) => c instanceof FakeGraphics && (c as unknown as { calls: { fn: string }[] }).calls.some((k) => k.fn === "fill"),
    );
    const textIdx = descendants.findIndex((c) => c instanceof FakeText);
    expect(fillIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(fillIdx).toBeLessThan(textIdx);
  });

  it("rebuilds the graph when only crossFloorEdges changes identity (dirty check, GitHub issue #461)", () => {
    const container = new Container();
    const renderer = new MazeGraphRenderer(container as never);

    const nodes = [n(1, 2, 2, 0)];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const resolveNodeCell = (id: number): [number, number] | undefined => (id === 1 ? [2, 2] : [2, 2]);
    const base = {
      nodes, edges: [] as EdgeDto[],
      showNodeIds: false, showCoords: false,
      selectedNode: null, start: null, finish: null, cfg,
      interactive: false,
      resolveNodeLevel, resolveNodeCell, activeFloorIndex: 0,
    };

    // First render: no vertical edge -> no badge.
    renderer.render({ ...base, crossFloorEdges: [] });
    expect(allDescendants(container as never).filter((c) => c instanceof FakeText)).toHaveLength(0);

    // Second render: same nodes/edges by identity, only crossFloorEdges differs -> badge appears.
    renderer.render({ ...base, crossFloorEdges: [{ from: 1, to: 2, kind: "vertical_passage" }] });
    const digits = allDescendants(container as never).filter(
      (c): c is { options: { text: string } } => c instanceof FakeText,
    );
    expect(digits.map((d) => d.options.text)).toContain("2");
  });
});
