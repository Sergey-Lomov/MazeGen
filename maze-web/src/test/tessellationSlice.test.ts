import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { encodePoint } from "../pixi/tessellationProjection";
import { baseStoreState, emptyFreePoints, freeFieldEditState, hexPredefinedState, trianglePredefinedState } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  // Cartesian coordinates aren't asserted on in this suite -- any deterministic per-point
  // stand-in is fine, as long as its shape matches `getCartesianCoords`'s real return type.
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
});

describe("mazeStore setters", () => {
  it("setSeed updates seed and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setSeed(99);
    expect(useMazeStore.getState().seed).toBe(99);
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setTessellationConfig updates config and clears error", () => {
    useMazeStore.setState({ error: "old error" });
    useMazeStore.getState().setTessellationConfig({ type: "hex_parallelogram", cols: 5, rows: 7, orientation: "pointy_top" });
    const cfg = useMazeStore.getState().tessellationConfig;
    expect(cfg).toMatchObject({ type: "hex_parallelogram", cols: 5, rows: 7, orientation: "pointy_top" });
    expect(useMazeStore.getState().error).toBeNull();
  });

  it("setTessellationConfig syncs tessellationKind and hexShape", () => {
    useMazeStore.getState().setTessellationConfig({ type: "hex_hexagon", radius: 3, orientation: "flat_top" });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.hexShape).toBe("hexagon");
  });

  it("setTessellationConfig syncs tessellationKind and triangleShape", () => {
    useMazeStore.getState().setTessellationConfig({ type: "triangle_triangle", side: 5, orientation: "r90" });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("triangle");
    expect(s.triangleShape).toBe("triangle");
  });

  it("setTessellationConfig with square_custom sets isEditingField and syncs freeFieldPoints", () => {
    useMazeStore.getState().setTessellationConfig({ type: "square_custom", points: [[1, 2], [3, 4]] });
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("square");
    expect(s.squareShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.fieldPoints.size).toBe(2);
    expect(s.freeFieldPoints.square.size).toBe(2);
  });

  it("setTessellationConfig with hex_custom syncs freeFieldPoints.hex", () => {
    useMazeStore.getState().setTessellationConfig({ type: "hex_custom", points: [[0, 0], [1, 0], [0, 1]], orientation: "pointy_top" });
    const s = useMazeStore.getState();
    expect(s.freeFieldPoints.hex.size).toBe(3);
    expect(s.freeFieldPoints.square.size).toBe(0);
    expect(s.hexOrientation).toBe("pointy_top");
  });
});

describe("mazeStore tessellation kind/shape actions", () => {
  it("setTessellationKind to hex sets tessellationKind and hex config type", () => {
    useMazeStore.getState().setTessellationKind("hex");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.tessellationConfig.type).toBe("hex_hexagon");
  });

  it("setTessellationKind to triangle sets tessellationKind and triangle config type", () => {
    useMazeStore.getState().setTessellationKind("triangle");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("triangle");
    expect(s.tessellationConfig.type).toBe("triangle_triangle");
  });

  it("setTessellationKind to square sets tessellationKind and square config type", () => {
    useMazeStore.setState({ tessellationKind: "hex" });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("square");
    expect(s.tessellationConfig.type).toBe("square");
  });

  it("setTessellationKind resets freeFieldPoints for target kind", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      freeFieldPoints: { square: new Set([1, 2]), hex: new Set([3]), triangle: new Set() },
    });
    useMazeStore.getState().setTessellationKind("square");
    const s = useMazeStore.getState();
    expect(s.freeFieldPoints.square.size).toBe(0);
    expect(s.freeFieldPoints.hex.size).toBe(1);
  });

  it("setTessellationKind resets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "hex", squareShape: "free", isEditingField: true });
    useMazeStore.getState().setTessellationKind("square");
    expect(useMazeStore.getState().isEditingField).toBe(false);
  });

  it("setHexShape to hexagon sets hexShape and hex_hexagon config type", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "pointy_top" },
    });
    useMazeStore.getState().setHexShape("hexagon");
    const s = useMazeStore.getState();
    expect(s.hexShape).toBe("hexagon");
    expect(s.tessellationConfig.type).toBe("hex_hexagon");
  });

  it("setHexShape preserves hex orientation", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      hexOrientation: "pointy_top",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "pointy_top" },
    });
    useMazeStore.getState().setHexShape("hexagon");
    expect(useMazeStore.getState().tessellationConfig).toMatchObject({ type: "hex_hexagon", orientation: "pointy_top" });
  });

  it("setHexShape to free sets isEditingField and empty fieldPoints (first time)", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setHexShape("free");
    const s = useMazeStore.getState();
    expect(s.hexShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.fieldPoints.size).toBe(0);
    expect(s.tessellationConfig.type).toBe("hex_custom");
  });

  it("setHexShape to free restores previously saved points", () => {
    const pts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "parallelogram",
      freeFieldPoints: { ...emptyFreePoints(), hex: pts },
    });
    useMazeStore.getState().setHexShape("free");
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(2);
    expect(s.fieldPoints).toBe(pts);
  });

  it("setHexShape from free to parallelogram clears isEditingField", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "free",
      isEditingField: true,
      fieldPoints: new Set([1]),
    });
    useMazeStore.getState().setHexShape("parallelogram");
    const s = useMazeStore.getState();
    expect(s.isEditingField).toBe(false);
    expect(s.tessellationConfig.type).toBe("hex_parallelogram");
  });

  it("setSquareShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "square", squareShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setSquareShape("free");
    const s = useMazeStore.getState();
    expect(s.squareShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.tessellationConfig.type).toBe("square_custom");
  });

  it("setTriangleShape to free sets isEditingField", () => {
    useMazeStore.setState({ tessellationKind: "triangle", triangleShape: "rect", freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().setTriangleShape("free");
    const s = useMazeStore.getState();
    expect(s.triangleShape).toBe("free");
    expect(s.isEditingField).toBe(true);
    expect(s.tessellationConfig.type).toBe("tri_custom");
  });

  it("setTriangleShape to triangle sets triangleShape and triangle_triangle config type", () => {
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "rect",
      tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r90" },
    });
    useMazeStore.getState().setTriangleShape("triangle");
    const s = useMazeStore.getState();
    expect(s.triangleShape).toBe("triangle");
    expect(s.tessellationConfig.type).toBe("triangle_triangle");
  });

  it("setTriangleShape preserves triangle orientation", () => {
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "rect",
      triOrientation: "r180",
      tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r180" },
    });
    useMazeStore.getState().setTriangleShape("hexagon");
    expect(useMazeStore.getState().tessellationConfig).toMatchObject({ type: "triangle_hexagon", orientation: "r180" });
  });

  it("setTessellationKind hex→triangle preserves triangle orientation default when coming from non-triangle", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
    });
    useMazeStore.getState().setTessellationKind("triangle");
    expect(useMazeStore.getState().tessellationConfig).toMatchObject({ type: "triangle_triangle", orientation: "r0" });
  });
});

describe("mazeStore free field actions", () => {
  it("addFieldPoint adds encoded point and updates tessellationConfig", () => {
    useMazeStore.setState(freeFieldEditState("square", new Set<number>()));
    useMazeStore.getState().addFieldPoint(3, 5);
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(1);
    expect(s.freeFieldPoints.square.size).toBe(1);
    expect(s.tessellationConfig.type).toBe("square_custom");
  });

  it("addFieldPoint is idempotent for same coord", () => {
    useMazeStore.setState(freeFieldEditState("square", new Set<number>()));
    useMazeStore.getState().addFieldPoint(1, 1);
    useMazeStore.getState().addFieldPoint(1, 1);
    expect(useMazeStore.getState().fieldPoints.size).toBe(1);
  });

  it("removeFieldPoint removes point and updates tessellationConfig", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState(freeFieldEditState("square", pts));
    useMazeStore.getState().removeFieldPoint(0, 0);
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(1);
    expect(s.freeFieldPoints.square.size).toBe(1);
  });

  it("removeFieldPoint is no-op for absent coord", () => {
    const pts = new Set([encodePoint(0, 0)]);
    useMazeStore.setState(freeFieldEditState("square", pts));
    useMazeStore.getState().removeFieldPoint(99, 99);
    expect(useMazeStore.getState().fieldPoints.size).toBe(1);
  });

  it("freeFieldPoints persists per-kind when switching shapes", () => {
    const hexPts = new Set([encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState(freeFieldEditState("hex", hexPts));
    useMazeStore.getState().setHexShape("parallelogram");
    const s1 = useMazeStore.getState();
    expect(s1.isEditingField).toBe(false);
    expect(s1.freeFieldPoints.hex.size).toBe(2);

    useMazeStore.getState().setHexShape("free");
    const s2 = useMazeStore.getState();
    expect(s2.isEditingField).toBe(true);
    expect(s2.fieldPoints.size).toBe(2);
    expect(s2.fieldPoints).toBe(hexPts);
  });
});

describe("mazeStore.setHexOrientation", () => {
  it("updates hexOrientation only when tessellationKind is not hex", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 10, height: 10 },
      hexOrientation: "flat_top",
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfig.type).toBe("square");
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "hex", hexOrientation: "flat_top" });
    const before = useMazeStore.getState().tessellationConfig;
    useMazeStore.getState().setHexOrientation("flat_top");
    expect(useMazeStore.getState().tessellationConfig).toBe(before);
  });

  it("updates tessellationConfig orientation in predefined mode", () => {
    useMazeStore.setState(hexPredefinedState({
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top", cols: 8, rows: 6 });
  });

  it("rebuilds tessellationConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({
      tessellationKind: "hex",
      hexShape: "free",
      squareShape: "rect",
      triangleShape: "rect",
      hexOrientation: "flat_top",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), hex: pts },
      tessellationConfig: { type: "hex_custom", points: [[0, 0], [1, 0]], orientation: "flat_top" },
    });
    useMazeStore.getState().setHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfig).toMatchObject({ type: "hex_custom", orientation: "pointy_top" });
  });

  it("updates activeTessellationConfig orientation when nodes exist", () => {
    useMazeStore.setState(hexPredefinedState({
      tessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
      activeTessellationConfig: { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" },
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
    }));
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeTessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top", cols: 8 });
  });

  it("does not update activeTessellationConfig when no nodes", () => {
    useMazeStore.setState(hexPredefinedState({
      tessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 5, orientation: "flat_top" },
      activeTessellationConfig: { type: "hex_parallelogram", cols: 5, rows: 5, orientation: "flat_top" },
      nodes: [],
    }));
    const activeBefore = useMazeStore.getState().activeTessellationConfig;
    useMazeStore.getState().setHexOrientation("pointy_top");
    expect(useMazeStore.getState().activeTessellationConfig).toBe(activeBefore);
  });
});

describe("mazeStore.setTriOrientation", () => {
  it("updates triOrientation only when tessellationKind is not triangle", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 10, height: 10 },
      triOrientation: "r0",
    });
    useMazeStore.getState().setTriOrientation("r90");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r90");
    expect(s.tessellationConfig.type).toBe("square");
  });

  it("is no-op when orientation unchanged", () => {
    useMazeStore.setState({ tessellationKind: "triangle", triOrientation: "r0" });
    const before = useMazeStore.getState().tessellationConfig;
    useMazeStore.getState().setTriOrientation("r0");
    expect(useMazeStore.getState().tessellationConfig).toBe(before);
  });

  it("updates tessellationConfig orientation in predefined mode", () => {
    useMazeStore.setState(trianglePredefinedState({
      tessellationConfig: { type: "triangle_rect", cols: 10, rows: 10, orientation: "r0" },
    }));
    useMazeStore.getState().setTriOrientation("r180");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r180");
    expect(s.tessellationConfig).toMatchObject({ type: "triangle_rect", orientation: "r180", cols: 10 });
  });

  it("rebuilds tessellationConfig via buildFreeConfig in free mode", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({
      tessellationKind: "triangle",
      triangleShape: "free",
      hexShape: "parallelogram",
      squareShape: "rect",
      triOrientation: "r0",
      hexOrientation: "flat_top",
      isEditingField: true,
      fieldPoints: pts,
      freeFieldPoints: { ...emptyFreePoints(), triangle: pts },
      tessellationConfig: { type: "tri_custom", points: [[0, 0], [1, 0]], orientation: "r0" },
    });
    useMazeStore.getState().setTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.triOrientation).toBe("r270");
    expect(s.tessellationConfig).toMatchObject({ type: "tri_custom", orientation: "r270" });
  });

  it("updates activeTessellationConfig orientation when nodes exist", () => {
    useMazeStore.setState(trianglePredefinedState({
      tessellationConfig: { type: "triangle_rect", cols: 6, rows: 4, orientation: "r0" },
      activeTessellationConfig: { type: "triangle_rect", cols: 6, rows: 4, orientation: "r0" },
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
    }));
    useMazeStore.getState().setTriOrientation("r90");
    expect(useMazeStore.getState().activeTessellationConfig).toMatchObject({ type: "triangle_rect", orientation: "r90", cols: 6 });
  });
});

describe("mazeStore preview/confirm flow", () => {
  it("setPreviewKind does not reset orientation", () => {
    useMazeStore.setState({ previewHexOrientation: "pointy_top", previewTriOrientation: "r90" });
    useMazeStore.getState().setPreviewKind("hex");
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r90");
  });

  it("setPreviewKind updates previewTessellationConfig", () => {
    useMazeStore.getState().setPreviewKind("triangle");
    expect(useMazeStore.getState().previewTessellationConfig.type).toBe("triangle_rect");
  });

  it("syncPreviewToConfirmed copies all confirmed values atomically", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      hexOrientation: "pointy_top",
      triOrientation: "r180",
      previewKind: "triangle",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
    });
    useMazeStore.getState().syncPreviewToConfirmed();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("hex");
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTriOrientation).toBe("r180");
    expect(s.previewTessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top" });
  });

  it("confirmTessellation copies preview into confirmed", () => {
    useMazeStore.setState({
      previewKind: "hex",
      previewHexOrientation: "pointy_top",
      previewTriOrientation: "r0",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.tessellationKind).toBe("hex");
    expect(s.hexOrientation).toBe("pointy_top");
    expect(s.tessellationConfirmed).toBe(true);
  });

  it("confirmTessellation syncs preview fields to confirmed", () => {
    useMazeStore.setState({
      previewKind: "triangle",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r90",
      tessellationKind: "square",
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.previewKind).toBe("triangle");
    expect(s.previewTriOrientation).toBe("r90");
    expect(s.previewTessellationConfig.type).toBe("triangle_rect");
  });

  it("confirmTessellation with same kind does not clear maze", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "square",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
    });
    useMazeStore.getState().confirmTessellation();
    expect(useMazeStore.getState().nodes.length).toBe(1);
  });

  it("confirmTessellation with different kind clears maze", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      previewKind: "hex",
      previewHexOrientation: "flat_top",
      previewTriOrientation: "r0",
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [{ from: 0, to: 0, kind: "basic" }],
      start: 0,
      finish: 0,
    });
    useMazeStore.getState().confirmTessellation();
    const s = useMazeStore.getState();
    expect(s.nodes).toHaveLength(0);
    expect(s.edges).toHaveLength(0);
    expect(s.start).toBeNull();
    expect(s.finish).toBeNull();
  });
});

describe("mazeStore tessellation misc actions", () => {
  it("setPreviewHexOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "hex" });
    useMazeStore.getState().setPreviewHexOrientation("pointy_top");
    const s = useMazeStore.getState();
    expect(s.previewHexOrientation).toBe("pointy_top");
    expect(s.previewTessellationConfig).toMatchObject({ type: "hex_parallelogram", orientation: "pointy_top" });
  });

  it("setPreviewTriOrientation updates preview config", () => {
    useMazeStore.setState({ previewKind: "triangle" });
    useMazeStore.getState().setPreviewTriOrientation("r270");
    const s = useMazeStore.getState();
    expect(s.previewTriOrientation).toBe("r270");
    expect(s.previewTessellationConfig).toMatchObject({ type: "triangle_rect", orientation: "r270" });
  });

  it("addFieldPoints adds multiple cells and marks fieldDirty", () => {
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: new Set<number>(), freeFieldPoints: emptyFreePoints() });
    useMazeStore.getState().addFieldPoints([[0, 0], [1, 0], [0, 1]]);
    const s = useMazeStore.getState();
    expect(s.fieldPoints.size).toBe(3);
    expect(s.fieldDirty).toBe(true);
  });

  it("addFieldPoints is no-op when all cells already present", () => {
    const pts = new Set([encodePoint(0, 0)]);
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts }, fieldDirty: false });
    useMazeStore.getState().addFieldPoints([[0, 0]]);
    expect(useMazeStore.getState().fieldDirty).toBe(false);
  });

  it("removeFieldPoints removes multiple cells", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1)]);
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts } });
    useMazeStore.getState().removeFieldPoints([[0, 0], [1, 0]]);
    expect(useMazeStore.getState().fieldPoints.size).toBe(1);
  });

  it("clearFieldPoints empties the set", () => {
    const pts = new Set([encodePoint(0, 0), encodePoint(1, 0)]);
    useMazeStore.setState({ tessellationKind: "square", fieldPoints: pts, freeFieldPoints: { ...emptyFreePoints(), square: pts } });
    useMazeStore.getState().clearFieldPoints();
    expect(useMazeStore.getState().fieldPoints.size).toBe(0);
  });

  it("clearFieldPoints is no-op on already-empty set", () => {
    useMazeStore.setState({ fieldPoints: new Set<number>(), fieldDirty: false });
    useMazeStore.getState().clearFieldPoints();
    expect(useMazeStore.getState().fieldDirty).toBe(false);
  });

  it("setShowFieldOverlay toggles flag", () => {
    useMazeStore.getState().setShowFieldOverlay(false);
    expect(useMazeStore.getState().showFieldOverlay).toBe(false);
  });

  it("setShowFieldOrigin toggles flag", () => {
    useMazeStore.getState().setShowFieldOrigin(false);
    expect(useMazeStore.getState().showFieldOrigin).toBe(false);
  });

  it("setFieldPrimitive updates primitive", () => {
    useMazeStore.getState().setFieldPrimitive("hex_hexagon");
    expect(useMazeStore.getState().fieldPrimitive).toBe("hex_hexagon");
  });

  it("setFieldEditMode('custom') derives fieldPoints from predefined config cells", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      tessellationConfig: { type: "square", width: 3, height: 3 },
      freeFieldPoints: emptyFreePoints(),
    });
    useMazeStore.getState().setFieldEditMode("custom");
    const s = useMazeStore.getState();
    expect(s.fieldEditMode).toBe("custom");
    expect(s.isEditingField).toBe(true);
    expect(s.fieldPoints.size).toBe(9);
    expect(s.tessellationConfig.type).toBe("square_custom");
  });

  it("setFieldEditMode('default') rebuilds predefined config", () => {
    useMazeStore.setState({
      tessellationKind: "square",
      squareShape: "rect",
      hexShape: "parallelogram",
      triangleShape: "rect",
      fieldEditMode: "custom",
      savedConfigs: {},
    });
    useMazeStore.getState().setFieldEditMode("default");
    const s = useMazeStore.getState();
    expect(s.fieldEditMode).toBe("default");
    expect(s.isEditingField).toBe(false);
    expect(s.tessellationConfig.type).toBe("square");
  });
});
