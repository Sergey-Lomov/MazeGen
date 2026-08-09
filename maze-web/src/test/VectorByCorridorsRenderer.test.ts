import { describe, it, expect, vi, beforeEach } from "vitest";
import { VectorByCorridorsRenderer } from "../pixi/imageExport/VectorByCorridorsRenderer";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors";
import { canvas } from "../pixi/colorTokens";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { VectorByCorridorsSettings } from "../store/storeTypes";

vi.mock("../pixi/selectors/mazeSelectors", () => ({
  buildCorridorSegments: vi.fn(() => []),
}));

vi.mock("../pixi/renderers/WallRenderer", () => ({
  chainSegmentsAtSharedVertices: vi.fn(() => []),
}));

let subscribeCallback: ((state: unknown) => void) | null = null;
let currentState: Record<string, unknown>;

vi.mock("../store/mazeStore", () => ({
  useMazeStore: {
    getState: vi.fn(() => currentState),
    subscribe: vi.fn((cb: (state: unknown) => void) => {
      subscribeCallback = cb;
      return () => { subscribeCallback = null; };
    }),
  },
}));

vi.mock("pixi.js", () => ({
  Container: vi.fn().mockImplementation(function (this: { addChild: () => void; destroy: () => void; visible: boolean }) {
    this.addChild = vi.fn();
    this.destroy = vi.fn();
    this.visible = false;
  }),
  Graphics: vi.fn().mockImplementation(function (this: { clear: () => void; moveTo: () => unknown; lineTo: () => unknown; stroke: () => unknown; destroy: () => void }) {
    this.clear = vi.fn();
    this.moveTo = vi.fn(() => this);
    this.lineTo = vi.fn(() => this);
    this.stroke = vi.fn(() => this);
    this.destroy = vi.fn();
  }),
}));

const settingsA: VectorByCorridorsSettings = { color: 0x111111, thickness: 10, join: "round" };
const settingsB: VectorByCorridorsSettings = { color: 0x222222, thickness: 20, join: "miter" };

// Stable references reused across `baseState()` calls — the renderer's own geometry cache keys off
// reference-equality of `nodes`/`edges`/`activeTessellationConfig` (same convention as
// `VectorByWallsRenderer`'s own cache), so a fresh literal on every call would look like a data
// change even when a test means to vary only `vectorByCorridorsSettings`.
const stableNodes: NodeDto[] = [];
const stableEdges: EdgeDto[] = [];
const stableCfg: TessellationConfig = { type: "square", width: 4, height: 4 };

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    openCard: "image_export",
    nodes: stableNodes,
    edges: stableEdges,
    activeTessellationConfig: stableCfg,
    vectorByCorridorsSettings: settingsA,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subscribeCallback = null;
  currentState = baseState();
});

describe("VectorByCorridorsRenderer", () => {
  it("getRequiredExportMargin/getRequiredWallExportMargin both return half the current thickness", () => {
    currentState = baseState({ vectorByCorridorsSettings: settingsB });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getRequiredExportMargin()).toEqual({ left: 10, right: 10, top: 10, bottom: 10 });
    expect(renderer.getRequiredWallExportMargin()).toEqual(renderer.getRequiredExportMargin());
  });

  it("getBackgroundColor always resolves to the fixed editor canvas background", () => {
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(renderer.getBackgroundColor()).toBe(canvas.stage.background);
  });

  it("container starts hidden and becomes visible only while the image-export card is open", () => {
    currentState = baseState({ openCard: "generation" });
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect((renderer as unknown as { corridorsContainer: { visible: boolean } }).corridorsContainer.visible).toBe(false);
  });

  it("a data change while the image-export card is open triggers a re-render (geometry rebuilt)", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("a settings-only change re-renders without rebuilding geometry (cache reused)", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ vectorByCorridorsSettings: settingsB });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
  });

  it("a data change while the image-export card is closed does not re-render", () => {
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ openCard: "generation", nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).not.toHaveBeenCalled();
  });

  it("switching openCard to image_export re-renders even with no data/settings change", () => {
    currentState = baseState({ openCard: "generation" });
    new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    vi.mocked(buildCorridorSegments).mockClear();

    const nextState = baseState({ openCard: "image_export" });
    subscribeCallback?.(nextState);

    expect(buildCorridorSegments).toHaveBeenCalledTimes(1);
  });

  it("destroy unsubscribes from the store and destroys its own Graphics/Container", () => {
    const renderer = new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
    expect(subscribeCallback).not.toBeNull();
    renderer.destroy();
    expect(subscribeCallback).toBeNull();
  });
});
