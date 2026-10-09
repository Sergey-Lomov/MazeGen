import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";

const stubs = vi.hoisted(() => ({
  grids: [] as unknown[],
  floors: [] as unknown[],
  symmetryCells: [] as unknown[],
  origins: [] as unknown[],
  papers: [] as unknown[],
  walls: [] as unknown[],
  graphics: [] as unknown[],
}));

vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    visible = true;
    x = 0;
    y = 0;
    scale = { x: 1, y: 1 };
    addChild(child: unknown) { this.children.push(child); return child; }
    setChildIndex(child: unknown, index: number) {
      const current = this.children.indexOf(child);
      if (current < 0) return;
      this.children.splice(current, 1);
      this.children.splice(index, 0, child);
    }
    destroy() {}
  }
  class FakeGraphics {
    calls: { name: string; args: unknown[] }[] = [];
    constructor() { stubs.graphics.push(this); }
    clear(...args: unknown[]) { this.calls.push({ name: "clear", args }); return this; }
    moveTo(...args: unknown[]) { this.calls.push({ name: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ name: "lineTo", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ name: "stroke", args }); return this; }
    circle(...args: unknown[]) { this.calls.push({ name: "circle", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ name: "fill", args }); return this; }
    destroy() { this.calls.push({ name: "destroy", args: [] }); }
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

vi.mock("../pixi/renderers/GridRenderer", () => ({
  GridRenderer: class {
    render = vi.fn();
    destroy = vi.fn();
    constructor() { stubs.grids.push(this); }
  },
}));

vi.mock("../pixi/renderers/WallRenderer", () => ({
  WallRenderer: class {
    render = vi.fn();
    destroy = vi.fn();
    constructor() { stubs.walls.push(this); }
  },
}));

vi.mock("../pixi/renderers/CellFillRenderer", () => ({
  CellFillRenderer: class {
    render = vi.fn();
    destroy = vi.fn();
    constructor() { stubs.floors.push(this); }
  },
}));

vi.mock("../pixi/renderers/OriginRenderer", () => ({
  OriginRenderer: class {
    render = vi.fn();
    destroy = vi.fn();
    constructor() { stubs.origins.push(this); }
  },
}));

vi.mock("../pixi/PaperLayoutRenderer", () => ({
  PaperLayoutRenderer: class {
    render = vi.fn();
    destroy = vi.fn();
    constructor() { stubs.papers.push(this); }
  },
}));

vi.mock("../pixi/BackgroundImageLayer", () => ({
  backgroundImageChanged: (state: { showBackgroundImage?: boolean; backgroundImage?: unknown; backgroundImageManualPositioning?: boolean; backgroundImageCropping?: boolean }, prev: { showBackgroundImage?: boolean; backgroundImage?: unknown; backgroundImageManualPositioning?: boolean; backgroundImageCropping?: boolean }) => (
    state.showBackgroundImage !== prev.showBackgroundImage
    || state.backgroundImage !== prev.backgroundImage
    || state.backgroundImageManualPositioning !== prev.backgroundImageManualPositioning
    || state.backgroundImageCropping !== prev.backgroundImageCropping
  ),
  BackgroundImageHost: class {
    render = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock("../pixi/tessellationProjection", () => ({
  encodePoint: (x: number, y: number) => ((x & 0xFFFF) << 16) | (y & 0xFFFF),
  decodePoint: (key: number): [number, number] => [key >> 16, ((key & 0xFFFF) << 16) >> 16],
  makeProjection: () => ({
    gridToScreen: (x: number, y: number) => ({ x: x * 10, y: y * 20 }),
    gridBounds: () => ({ minX: 0, maxX: 1, minY: 0, maxY: 1 }),
  }),
}));

vi.mock("../pixi/tessellationCells", () => ({
  configAllCells: (cfg: { width?: number }) => cfg.width === 0 ? [] : [[0, 0], [2, 4]],
  resolveFieldConfig: (cfg: unknown) => cfg,
}));

vi.mock("../pixi/tessellationGeometry", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pixi/tessellationGeometry")>(),
  cellBounds: (cells: [number, number][]) => cells.length === 0
    ? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    : { minX: -10, minY: 20, maxX: 30, maxY: 60 },
}));

vi.mock("../pixi/symmetry", () => ({
  computeSymmetryPreview: vi.fn(() => ({ sourceCells: [[0, 0]], mirroredCells: [[2, 0]] })),
  symmetryCandidateCells: vi.fn(() => [[0, 0]]),
}));

import { Container } from "pixi.js";
import { FieldEditorOverlay, configScreenCenter, fitFieldViewport } from "../pixi/FieldEditorOverlay";
import { encodePoint } from "../pixi/tessellationProjection";

type FakeContainer = InstanceType<typeof Container> & { visible: boolean; children: unknown[] };
type Stub = { render: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };

let overlays: FieldEditorOverlay[] = [];

beforeEach(() => {
  stubs.grids.length = 0;
  stubs.floors.length = 0;
  stubs.symmetryCells.length = 0;
  stubs.origins.length = 0;
  stubs.papers.length = 0;
  stubs.walls.length = 0;
  stubs.graphics.length = 0;
  overlays = [];
  useMazeStore.setState({
    ...baseStoreState(),
    openCard: "basic_config",
    showFieldOrigin: true,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        fieldEditMode: "custom",
        fieldPrimitive: "point",
        fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        tessellationConfig: { type: "square", width: 4, height: 4 },
      }),
    },
  });
});

afterEach(() => {
  for (const overlay of overlays) overlay.destroy();
});

function openOverlay(): { overlay: FieldEditorOverlay; root: FakeContainer } {
  const root = new Container() as FakeContainer;
  const overlay = new FieldEditorOverlay(root);
  overlays.push(overlay);
  useMazeStore.setState({ openCard: "field_setup" });
  return { overlay, root };
}

describe("FieldEditorOverlay", () => {
  it("redraws the editor layers when the field setup card opens and the viewport changes", () => {
    const { overlay, root } = openOverlay();
    const cfg = useMazeStore.getState().floorFields[TEST_FLOOR_ID].tessellationConfig;

    expect(root.visible).toBe(true);
    expect((stubs.grids[0] as Stub).render).toHaveBeenCalled();
    expect((stubs.floors[0] as Stub).render).toHaveBeenCalledWith(
      expect.objectContaining({ cells: [[0, 0], [1, 0]] }), cfg,
    );

    overlay.updateHover([2, 3], cfg);
    expect((stubs.floors[2] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [[2, 3]], color: 0x888888 }), cfg,
    );
    overlay.updateHover([[2, 3], [3, 3]], cfg);
    expect((stubs.floors[2] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [[2, 3], [3, 3]], color: 0x888888 }), cfg,
    );
    overlay.updateHover([[2, 3], [3, 3]], cfg, 0x00ff00, 0.5);
    expect((stubs.floors[2] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [[2, 3], [3, 3]], color: 0x00ff00, alpha: 0.5 }), cfg,
    );
    overlay.updateHover(null, cfg);
    expect((stubs.floors[2] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [] }), cfg,
    );

    overlay.onViewportChanged(10, 20, 800, 600, 2);
    expect((stubs.grids[0] as Stub).render).toHaveBeenLastCalledWith(
      { viewport: { x: 10, y: 20, w: 800, h: 600, scale: 2 } }, cfg,
    );
    expect((stubs.origins[0] as Stub).render).toHaveBeenLastCalledWith({ show: true }, cfg);
    expect((stubs.papers[0] as Stub).render).toHaveBeenCalled();
  });

  it("uses the preset wall renderer for the field boundary even without an underlay", () => {
    openOverlay();
    const boundary = stubs.walls[0] as Stub;

    expect(boundary.render).toHaveBeenCalledWith(
      { edges: expect.arrayContaining([
        expect.objectContaining({ a: [0, 0], b: [0, 1], kind: "none", style: "solid" }),
      ]) },
      expect.objectContaining({ type: "square" }),
    );
    expect(boundary.render.mock.calls[0][0].edges).toHaveLength(6);
  });

  it("draws symmetry cells and polygon geometry only while symmetry is active", () => {
    const { overlay } = openOverlay();
    const state = useMazeStore.getState();
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      symmetryScope: "polygon",
      symmetryPolygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      symmetryPolygonFinished: true,
      floorFields: {
        ...state.floorFields,
        [TEST_FLOOR_ID]: { ...state.floorFields[TEST_FLOOR_ID], fieldPrimitive: "symmetry" },
      },
    });

    overlay.updateSymmetryPreview();

    expect((stubs.floors[1] as Stub).render).toHaveBeenCalledWith(
      expect.objectContaining({ cells: [[2, 0]], alpha: 0.45 }), expect.anything(),
    );
    expect((stubs.graphics[0] as { calls: { name: string }[] }).calls.some(call => call.name === "stroke")).toBe(true);
    expect((stubs.graphics[0] as { calls: { name: string }[] }).calls.some(call => call.name === "circle")).toBe(true);

    useMazeStore.setState({
      floorFields: {
        ...useMazeStore.getState().floorFields,
        [TEST_FLOOR_ID]: { ...useMazeStore.getState().floorFields[TEST_FLOOR_ID], fieldPrimitive: "point" },
      },
    });
    expect((stubs.floors[1] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [], alpha: 0 }), expect.anything(),
    );
  });

  it("hides the source cells and renders only the temporary translated cells while moving", () => {
    const { overlay } = openOverlay();
    const cfg = useMazeStore.getState().floorFields[TEST_FLOOR_ID].tessellationConfig;

    overlay.setSelectionMovePreview([[0, 0]], [[2, 0]]);
    expect((stubs.floors[0] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [[1, 0], [2, 0]] }), cfg,
    );

    overlay.setSelectionMovePreview([], []);
    expect((stubs.floors[0] as Stub).render).toHaveBeenLastCalledWith(
      expect.objectContaining({ cells: [[0, 0], [1, 0]] }), cfg,
    );
  });

  it("cleans up subscriptions and renderer resources", () => {
    const { overlay } = openOverlay();
    const renderers = [...stubs.grids, ...stubs.floors, ...stubs.origins, ...stubs.papers, ...stubs.walls] as Stub[];
    overlay.destroy();
    overlays = [];
    expect(renderers.every(renderer => renderer.destroy.mock.calls.length === 1)).toBe(true);
  });
});

describe("FieldEditorOverlay viewport helpers", () => {
  it("returns the center of configured cells and a centered fit transform", () => {
    expect(configScreenCenter({ type: "square", width: 4, height: 4 })).toEqual({ x: 10, y: 40 });
    expect(configScreenCenter({ type: "square", width: 0, height: 0 })).toEqual({ x: 0, y: 0 });

    const fit = fitFieldViewport(
      { type: "square", width: 4, height: 4 },
      [{ type: "square", width: 4, height: 4 }],
      800,
      600,
    );
    expect(fit.scale).toBeGreaterThan(0);
    expect((400 - fit.x) / fit.scale).toBeCloseTo(10);
    expect((300 - fit.y) / fit.scale).toBeCloseTo(40);
  });
});
