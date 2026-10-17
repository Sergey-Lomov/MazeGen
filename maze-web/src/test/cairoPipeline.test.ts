import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeDigitalExportFit } from "../pixi/imageExport/exportFit";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { useMazeStore } from "../store/mazeStore";
import { computeAnalyticsAsync, generateMaze } from "../wasm/mazeService";
import { baseStoreState, mockSnapshot } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeTessellationShapes } from "./tessellationShapesFake";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)),
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getAvailableRuleParams: vi.fn(() => []),
}));

vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

const CAIRO_POINTS: [number, number][] = [
  [-14, -15], [-14, -13],
  [-9, -14], [-6, -15], [-6, -13],
  [-15, -10], [-13, -10], [-10, -11], [-10, -9], [-7, -10], [-5, -10],
];

const generatedSnapshot = {
  ...mockSnapshot,
  nodes: [
    { id: 0, x: CAIRO_POINTS[0][0], y: CAIRO_POINTS[0][1], i: 0, level: 0 },
    { id: 1, x: CAIRO_POINTS[1][0], y: CAIRO_POINTS[1][1], i: 0, level: 0 },
    { id: 2, x: CAIRO_POINTS[0][0], y: CAIRO_POINTS[0][1], i: 0, level: 1 },
    { id: 3, x: CAIRO_POINTS[1][0], y: CAIRO_POINTS[1][1], i: 0, level: 1 },
  ],
  edges: [
    { from: 0, to: 1, kind: "basic" as const },
    { from: 1, to: 0, kind: "basic" as const },
    { from: 2, to: 3, kind: "basic" as const },
    { from: 3, to: 2, kind: "basic" as const },
  ],
  start: 0,
  finish: 3,
};

const editedSnapshot = {
  ...generatedSnapshot,
  edges: generatedSnapshot.edges.filter((edge) => edge.from >= 2),
};

describe("Cairo application pipeline", () => {
  beforeEach(() => {
    useMazeStore.setState(baseStoreState());
    vi.mocked(generateMaze).mockReset();
    vi.mocked(generateMaze).mockReturnValue({ snapshot: generatedSnapshot, debugTape: undefined });
    vi.mocked(computeAnalyticsAsync).mockReset();
    vi.mocked(computeAnalyticsAsync).mockResolvedValue(editedSnapshot);
  });

  it("selects, edits, generates, post-edits, saves/loads, analyzes, and sizes a Cairo export", async () => {
    const store = useMazeStore.getState();

    // Basic-config selection, then the field editor's custom point workflow.
    store.setPreviewKind("cairo");
    store.confirmTessellation();
    store.setFieldEditMode("custom");
    store.clearFieldPoints();
    store.addFieldPoints(CAIRO_POINTS);
    store.addFloor();

    const selected = useMazeStore.getState();
    expect(selected.tessellationKind).toBe("cairo");
    expect(selected.floors).toHaveLength(2);
    expect(selected.floorFields[selected.floors[0].id].fieldConfig).toEqual(fieldOf("cairo", { shape: "custom", points: CAIRO_POINTS }));

    selected.generate();
    const generateConfig = vi.mocked(generateMaze).mock.calls[0][1];
    expect(generateConfig.tessellation).toEqual({ kind: "cairo" as const, params: {} });
    expect(generateConfig.level_fields).toEqual([CAIRO_POINTS, CAIRO_POINTS]);
    expect(useMazeStore.getState().nodes.map(({ x, y, level }) => [x, y, level])).toContainEqual([-14, -15, 1]);

    // Change a generated Cairo passage through the actual post-edit command/replay path.
    useMazeStore.getState().setPostEditAutoConfirm(false);
    useMazeStore.getState().applyPostEditToolAt("wall", "", nodeEndpoint(0), nodeEndpoint(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);
    await useMazeStore.getState().confirmPostEdit();

    const analyticsConfig = vi.mocked(computeAnalyticsAsync).mock.calls[0][0];
    expect(analyticsConfig.tessellation).toEqual({ kind: "cairo" as const, params: {} });
    expect(analyticsConfig.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: -14, y: -15, level: 1 }),
    ]));
    expect(useMazeStore.getState().postEditAnalytics).not.toBeNull();

    // Project export/import must preserve the custom negative coordinates, floors, and edit log.
    const saved = serializeProject(useMazeStore.getState());
    const restoredFile = parseAndValidate(JSON.parse(JSON.stringify(saved)));
    expect(restoredFile.tessellation.kind).toBe("cairo");
    expect(restoredFile.floorFields[restoredFile.floors.floors[0].id].shape).toEqual({ shape: "custom", points: CAIRO_POINTS });
    expect(restoredFile.postEdit?.commands).toHaveLength(1);

    useMazeStore.getState().loadProject(restoredFile);
    await vi.waitFor(() => {
      expect(useMazeStore.getState().postEditAnalytics).not.toBeNull();
    });
    const restored = useMazeStore.getState();
    expect(restored.tessellationKind).toBe("cairo");
    expect(restored.floors).toHaveLength(2);
    expect(restored.floorFields[restored.floors[0].id].fieldConfig).toEqual(fieldOf("cairo", { shape: "custom", points: CAIRO_POINTS }));
    expect(restored.postEditCommands).toHaveLength(1);
    expect(restored.postEditAnalytics).not.toBeNull();
    expect(restored.nodes).toHaveLength(4);

    // Image export's fit calculation consumes the restored Cairo geometry and negative nodes.
    const fit = computeDigitalExportFit(
      restored.activeFieldConfig,
      restored.nodes,
      { left: 0, right: 0, top: 0, bottom: 0 },
      { ...restored.pngExportSettings.digital, canvasMode: "edge_to_edge" },
    );
    expect(fit.width).toBeGreaterThan(0);
    expect(fit.height).toBeGreaterThan(0);
    expect(Number.isFinite(fit.worldX)).toBe(true);
    expect(Number.isFinite(fit.worldY)).toBe(true);
  });
});
