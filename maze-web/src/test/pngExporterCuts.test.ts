import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";
import { oneGlue, range } from "./seamFixtures";

// PngExporter with cut lines (GitHub issue #859): pixi and the mode renderer are replaced by
// recording fakes, so the test checks the passes the exporter makes, not pixels.

interface FakeNode {
  position: { x: number; y: number; set(x: number, y: number): void };
  scale: { set(s: number): void };
  mask: unknown;
  children: FakeNode[];
  addChild(child: FakeNode): void;
  removeChild(child: FakeNode): void;
  destroy(): void;
}

const renders: { offset: [number, number]; masked: boolean; clear: boolean | undefined; strokes: number; pass: string }[] = [];
const pass = { current: "full", log: [] as string[] };
const drawn = { fills: [] as unknown[], strokes: 0, polys: [] as number[][] };

vi.mock("pixi.js", () => {
  class Container implements FakeNode {
    position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
    scale = { set(_s: number) {} };
    mask: unknown = null;
    children: FakeNode[] = [];
    addChild(child: FakeNode) { this.children.push(child); }
    removeChild(child: FakeNode) { this.children = this.children.filter((c) => c !== child); }
    destroy() {}
  }
  class Graphics extends Container {
    private pendingStrokes = 0;
    rect() { return this; }
    poly(points: number[]) { drawn.polys.push(points); return this; }
    fill(color: unknown) { drawn.fills.push(color); return this; }
    moveTo() { return this; }
    lineTo() { this.pendingStrokes++; return this; }
    stroke() { drawn.strokes += this.pendingStrokes; return this; }
  }
  const RenderTexture = { create: () => ({ destroy() {} }) };
  return { Container, Graphics, RenderTexture };
});

vi.mock("../pixi/imageExport/modeRendererFactory", () => ({
  createModeRenderer: () => ({
    getRequiredExportMargin: () => ({ left: 5, right: 5, top: 5, bottom: 5 }),
    getBackgroundColor: () => 0xabcdef,
    onViewportChanged: () => {},
    setRenderPass: (p: string) => { pass.current = p; pass.log.push(p); },
    destroy: () => {},
  }),
}));

const { PngExporter } = await import("../pixi/imageExport/PngExporter");
const { useMazeStore } = await import("../store/mazeStore");
const { DEFAULT_PNG_EXPORT_SETTINGS } = await import("../store/slices/imageExportSlice");
const { baseStoreState, TEST_FLOOR_ID } = await import("./storeTestHelpers");

const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });
const fold = (a: [number, number], b: [number, number]): WireFold => ({
  a: { cell: a, face_idx: 0 },
  b: { cell: b, face_idx: 2 },
  twist: false,
  group: 0,
});
const cylinder = (): WireTopology => oneGlue("square{}", range(ROWS).map((y) => fold([COLUMNS - 1, y], [0, y])));

const app = {
  renderer: {
    render: vi.fn((options: { container: FakeNode; clear?: boolean }) => {
      const scene = options.container.children[0];
      renders.push({
        offset: scene ? [scene.position.x, scene.position.y] : [0, 0],
        masked: !!scene?.mask,
        clear: options.clear,
        strokes: drawn.strokes,
        pass: pass.current,
      });
    }),
    extract: { canvas: () => ({ convertToBlob: async () => new Blob(["png"], { type: "image/png" }) }) },
  },
};

function setState(lines: Record<string, Record<number, { mode: "none" | "auto" | "manual"; offset: number }>>, showLines = false) {
  const topology = cylinder();
  const cuts = { lines };
  const base = { ...baseStoreState(), vectorByWallsSettings: useMazeStore.getState().vectorByWallsSettings };
  useMazeStore.setState({
    ...base,
    vectorByWallsSettings: { ...base.vectorByWallsSettings, showCutLines: showLines },
    activeFieldConfig: field,
    nodes: cells.map(([x, y], id) => ({ id, x, y, i: 0 })),
    floorTopology: { [TEST_FLOOR_ID]: topology },
    openCard: "image_export",
    activeRenderMode: "vector_by_walls",
    pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, cuts },
  } as never);
  warmCartesianCache(field, topology);
  return { ...DEFAULT_PNG_EXPORT_SETTINGS, cuts };
}

beforeEach(() => {
  renders.length = 0;
  drawn.fills = [];
  drawn.strokes = 0;
  drawn.polys = [];
  pass.current = "full";
  pass.log = [];
  app.renderer.render.mockClear();
});

describe("PngExporter cut sheet", () => {
  it("renders the scene once without cuts", async () => {
    const settings = setState({});
    const blob = await new PngExporter(app as never).export(settings);
    expect(blob).not.toBeNull();
    expect(renders).toHaveLength(1);
    expect(renders[0].masked).toBe(false);
    expect(drawn.polys).toHaveLength(0);
  });

  it("fills the background, then draws the scene once per plan offset with the region as mask", async () => {
    const settings = setState({ [TEST_FLOOR_ID]: { 0: { mode: "auto", offset: 0 } } });
    const blob = await new PngExporter(app as never).export(settings);
    expect(blob).not.toBeNull();
    // Background fill, the backdrop, then the content copies (a cylinder cut once needs the plain and one shifted).
    expect(drawn.fills[0]).toBe(0xabcdef);
    const scenePasses = renders.slice(2);
    expect(renders).toHaveLength(4);
    expect(scenePasses.every((pass) => pass.masked && pass.clear === false)).toBe(true);
    expect(scenePasses.map((pass) => pass.offset)).toContainEqual([0, 0]);
    expect(scenePasses.some((pass) => pass.offset[0] !== 0)).toBe(true);
    // The backdrop is drawn once, unmasked, before the masked content passes; the mode is left whole afterwards.
    expect(renders[1].pass).toBe("backdrop");
    expect(renders[1].masked).toBe(false);
    expect(scenePasses.every((p) => p.pass === "content")).toBe(true);
    expect(pass.current).toBe("full");
    expect(drawn.polys).toHaveLength(1);
    expect(drawn.polys[0].length).toBeGreaterThanOrEqual(8);
  });

  it("draws guide lines only when the flag is on", async () => {
    const lines = { [TEST_FLOOR_ID]: { 0: { mode: "auto" as const, offset: 0 } } };
    await new PngExporter(app as never).export(setState(lines, false));
    expect(drawn.strokes).toBe(0);
    const withoutGuides = renders.length;

    renders.length = 0;
    await new PngExporter(app as never).export(setState(lines, true));
    expect(drawn.strokes).toBeGreaterThan(0);
    expect(renders.length).toBe(withoutGuides + 1);
  });
});
