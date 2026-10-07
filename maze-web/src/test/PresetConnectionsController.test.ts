import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import { encodePoint } from "../pixi/tessellationProjection";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { PresetConnectionsController } from "../pixi/PresetConnectionsController";
import type { PresetConnectionsRenderer } from "../pixi/PresetConnectionsRenderer";
import type { PresetConnectionEntry, PresetElevatorEntry, PresetTeleportEntry, PresetVerticalPassageEntry } from "../pixi/fieldEditUtils";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

const fieldCells = new Set([
  encodePoint(0, 0),
  encodePoint(1, 0),
  encodePoint(2, 0),
]);

const activeControllers: PresetConnectionsController[] = [];
const actionRestores: (() => void)[] = [];

type RendererOptions = {
  cells?: Set<number>;
  cachedCells?: [number, number][];
};

function makeRenderer(options: RendererOptions = {}): PresetConnectionsRenderer {
  const cells = options.cells ?? fieldCells;
  return {
    getCachedCellSet: () => cells,
    getCachedCells: () => options.cachedCells ?? [[0, 0], [1, 0], [2, 0]],
    updateCellHover: vi.fn(),
    updateHover: vi.fn(),
    updateTeleportPreview: vi.fn(),
  } as unknown as PresetConnectionsRenderer;
}

function makeController(options: RendererOptions = {}, onViewportPan = vi.fn()): PresetConnectionsController {
  const controller = new PresetConnectionsController(
    () => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }) as unknown as Container,
    makeRenderer(options),
    onViewportPan,
  );
  activeControllers.push(controller);
  return controller;
}

function makeHarness(options: RendererOptions = {}, onViewportPan = vi.fn()) {
  const renderer = makeRenderer(options);
  const controller = new PresetConnectionsController(
    () => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }) as unknown as Container,
    renderer,
    onViewportPan,
  );
  activeControllers.push(controller);
  return { controller, renderer };
}

function spyStoreAction<K extends keyof ReturnType<typeof useMazeStore.getState>>(name: K) {
  const original = useMazeStore.getState()[name] as unknown as (...args: any[]) => any;
  const spy = vi.fn((...args: any[]) => original(...args));
  useMazeStore.setState({ [name]: spy } as Partial<ReturnType<typeof useMazeStore.getState>>);
  actionRestores.push(() => useMazeStore.setState({ [name]: original } as Partial<ReturnType<typeof useMazeStore.getState>>));
  return spy;
}

function setTwoFloors(cells = fieldCells): void {
  useMazeStore.setState({
    floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 }, fieldPoints: cells }),
      floor_2: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 }, fieldPoints: cells }),
    },
  });
}

function cellCenter(x: number, y = 0): [number, number] {
  return [20 + x * 40, -20 - y * 40];
}

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    openCard: "preset_connections",
    presetConnectionsTool: "set_start",
    presetStart: presetEndpoint([0, 0]),
    presetFinish: null,
    presetDragOverride: null,
    presetDragFailureMessage: null,
    presetSplitTargetPrompt: null,
    presetEntityDeletePrompt: null,
    presetTeleportPendingFrom: null,
    presetTeleports: [],
    _nextPresetTeleportId: 1,
    presetVerticalPassages: [],
    presetVerticalPassagePending: null,
    _nextPresetVerticalPassageId: 1,
    presetElevators: [],
    presetElevatorPending: null,
    _nextPresetElevatorId: 1,
    presetConnections: new Map(),
    lockedNodes: new Map(),
    presetFocusedPoint: null,
    presetSplitPoints: {},
    _nextPresetSplitPointId: 1,
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        tessellationConfig: { type: "square", width: 3, height: 3 },
        fieldPoints: fieldCells,
      }),
    },
  });
});

afterEach(() => {
  for (const restore of actionRestores.splice(0)) restore();
  for (const controller of activeControllers.splice(0)) controller.destroy();
});

describe("PresetConnectionsController marker drag", () => {
  it("returns to the origin preview and can continue to a later cell", () => {
    const controller = makeController();

    // Square cell centers are (20, -20), (60, -20), and (100, -20).
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20);
    expect(useMazeStore.getState().presetDragOverride).toEqual({
      kind: "marker", marker: "start", point: [1, 0],
    });

    controller.onPointerMove(20, -20);
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
    controller.onPointerMove(20, -20);
    expect(useMazeStore.getState().presetDragOverride).toBeNull();

    controller.onPointerMove(100, -20);
    expect(useMazeStore.getState().presetDragOverride).toEqual({
      kind: "marker", marker: "start", point: [2, 0],
    });

    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([2, 0]));
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });

  it("applies the same origin reset when dragging the finish marker", () => {
    useMazeStore.setState({ presetStart: null, presetFinish: presetEndpoint([0, 0]) });
    const controller = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20);
    controller.onPointerMove(20, -20);
    controller.onPointerMove(100, -20);
    controller.onPointerUp(0);

    expect(useMazeStore.getState().presetStart).toBeNull();
    expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([2, 0]));
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });
});

describe("PresetConnectionsController lifecycle and marker interactions", () => {
  it("ignores pointer input while another card or a preset modal is active", () => {
    const onPan = vi.fn();
    const { controller, renderer } = makeHarness({}, onPan);

    useMazeStore.setState({ openCard: "post_edit" });
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([0, 0]));
    expect(renderer.updateHover).not.toHaveBeenCalled();

    useMazeStore.setState({
      openCard: "preset_connections",
      presetSplitTargetPrompt: { point: [0, 0], slotIds: [1], action: { tool: "set_start" } },
    });
    controller.onPointerDown(60, -20, 0);
    controller.onPointerMove(100, -20);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([0, 0]));
    expect(renderer.updateCellHover).toHaveBeenCalledWith(null);
    expect(onPan).not.toHaveBeenCalled();
  });

  it("pans with the middle button and releases the pan gesture", () => {
    const onPan = vi.fn();
    const controller = makeController({}, onPan);

    controller.onPointerDown(10, 20, 1);
    controller.onPointerMove(35, 55);
    controller.onPointerUp(1);
    controller.onPointerMove(50, 70);

    expect(onPan).toHaveBeenCalledTimes(1);
    expect(onPan).toHaveBeenCalledWith(25, 35);
  });

  it("handles left, middle, and right edge buttons distinctly", () => {
    const controller = makeController();
    useMazeStore.setState({ presetConnectionsTool: "wall" });

    controller.onPointerDown(40, -20, 1);
    expect(useMazeStore.getState().presetConnections.size).toBe(0);

    controller.onPointerDown(40, -20, 0);
    const key = "0,0-1,0";
    expect(useMazeStore.getState().presetConnections.get(key)?.state).toBe("wall");

    controller.onPointerDown(40, -20, 2);
    expect(useMazeStore.getState().presetConnections.has(key)).toBe(false);
  });

  it("cancels an armed marker drag without committing a release-only mutation", () => {
    const controller = makeController();
    const setStart = spyStoreAction("setPresetStart");

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(2));
    expect(useMazeStore.getState().presetDragOverride).not.toBeNull();
    controller.cancelPointerGesture();

    expect(setStart).not.toHaveBeenCalled();
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([0, 0]));
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });

  it("cancels pending placement and preview on Escape", () => {
    const { controller, renderer } = makeHarness();
    useMazeStore.setState({ presetConnectionsTool: "teleport_one_way", presetStart: null });

    controller.onPointerDown(...cellCenter(0), 0);
    expect(useMazeStore.getState().presetTeleportPendingFrom).toEqual(presetEndpoint([0, 0]));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));

    expect(useMazeStore.getState().presetTeleportPendingFrom).toBeNull();
    expect(renderer.updateTeleportPreview).toHaveBeenLastCalledWith(null, 0, 0);
  });

  it("creates start and finish markers only on empty field cells", () => {
    const controller = makeController();
    useMazeStore.setState({ presetConnectionsTool: "set_start", presetStart: null });
    controller.onPointerDown(...cellCenter(1), 0);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([1, 0]));

    useMazeStore.setState({ presetConnectionsTool: "set_finish" });
    controller.onPointerDown(...cellCenter(2), 0);
    expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([2, 0]));

    controller.onPointerDown(140, -20, 0);
    expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([2, 0]));
  });

  it("right-clicks markers away and gives the start marker priority when markers overlap", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "teleport_one_way",
      presetStart: presetEndpoint([0, 0]),
      presetFinish: presetEndpoint([0, 0]),
    });

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([1, 0]));
    expect(useMazeStore.getState().presetFinish).toEqual(presetEndpoint([0, 0]));

    controller.onPointerDown(...cellCenter(0), 2);
    expect(useMazeStore.getState().presetFinish).toBeNull();
  });

  it("does not commit a marker on a plain click or an out-of-field move", () => {
    const { controller, renderer } = makeHarness();
    const setStart = spyStoreAction("setPresetStart");

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerUp(0);
    expect(setStart).not.toHaveBeenCalled();

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(140, -20);
    expect(renderer.updateCellHover).toHaveBeenLastCalledWith(null);
    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([0, 0]));
    expect(setStart).not.toHaveBeenCalled();
  });
});

describe("PresetConnectionsController teleport interactions", () => {
  function teleport(id: number, from: [number, number], to: [number, number], direction: PresetTeleportEntry["direction"] = "forward"): PresetTeleportEntry {
    return { id, from: presetEndpoint(from), to: presetEndpoint(to), direction };
  }

  it("places two endpoints, rejects the same cell, and preserves click-time floors", () => {
    const controller = makeController();
    useMazeStore.setState({ presetConnectionsTool: "teleport_two_way", presetStart: null });

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerDown(...cellCenter(0), 0);
    expect(useMazeStore.getState().presetTeleports).toHaveLength(0);
    controller.onPointerDown(...cellCenter(2), 0);
    expect(useMazeStore.getState().presetTeleports).toEqual([teleport(1, [0, 0], [2, 0], "two_way")]);

    setTwoFloors();
    useMazeStore.setState({ activeFloorId: TEST_FLOOR_ID, presetConnectionsTool: "teleport_one_way", presetTeleports: [], presetTeleportPendingFrom: null });
    controller.onPointerDown(...cellCenter(0), 0);
    useMazeStore.setState({ activeFloorId: "floor_2" });
    controller.onPointerDown(...cellCenter(1), 0);
    expect(useMazeStore.getState().presetTeleports.at(-1)).toEqual({
      id: 2,
      from: presetEndpoint([0, 0]),
      to: presetEndpoint([1, 0], undefined, 1),
      direction: "forward",
    });
  });

  it("cycles a one-way endpoint on click, leaves two-way unchanged, and deletes on RMB", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "teleport_one_way",
      presetStart: null,
      presetTeleports: [teleport(1, [0, 0], [1, 0]), teleport(2, [0, 0], [2, 0], "two_way")],
    });

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetTeleports[0].direction).toBe("backward");
    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetTeleports[1].direction).toBe("two_way");

    controller.onPointerDown(...cellCenter(0), 2);
    expect(useMazeStore.getState().presetTeleports).toHaveLength(1);
    expect(useMazeStore.getState().presetTeleports[0].id).toBe(2);
  });

  it("completes a pending placement on an existing endpoint instead of cycling it", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "teleport_one_way",
      presetStart: null,
      presetTeleportPendingFrom: presetEndpoint([1, 0]),
      presetTeleports: [teleport(1, [0, 0], [2, 0])],
      _nextPresetTeleportId: 2,
    });

    controller.onPointerDown(...cellCenter(2), 0);
    controller.onPointerUp(0);

    expect(useMazeStore.getState().presetTeleports).toHaveLength(2);
    expect(useMazeStore.getState().presetTeleports.at(-1)).toEqual(teleport(2, [1, 0], [2, 0]));
    expect(useMazeStore.getState().presetTeleports[0].direction).toBe("forward");
  });

  it("moves one endpoint live, rejects the opposite endpoint, and commits each target once", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "teleport_one_way",
      presetStart: null,
      presetTeleports: [teleport(1, [0, 0], [2, 0])],
    });
    const move = spyStoreAction("movePresetTeleportEndpoint");

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    controller.onPointerMove(...cellCenter(1));
    expect(move).toHaveBeenCalledTimes(1);
    expect(useMazeStore.getState().presetTeleports[0].from).toEqual(presetEndpoint([1, 0]));

    controller.onPointerMove(...cellCenter(2));
    expect(move).toHaveBeenCalledTimes(1);
    controller.onPointerUp(0);
  });

  it("clears a pending teleport with RMB on empty space and cleans preview after completion", () => {
    const { controller, renderer } = makeHarness();
    useMazeStore.setState({ presetConnectionsTool: "teleport_one_way", presetStart: null });
    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    expect(renderer.updateTeleportPreview).toHaveBeenLastCalledWith([0, 0], 60, -20);

    controller.onPointerDown(...cellCenter(2), 2);
    expect(useMazeStore.getState().presetTeleportPendingFrom).toBeNull();
    expect(useMazeStore.getState().presetTeleports).toHaveLength(0);
    expect(renderer.updateTeleportPreview).toHaveBeenLastCalledWith(null, 0, 0);

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerDown(...cellCenter(1), 0);
    expect(useMazeStore.getState().presetTeleports).toHaveLength(1);
    expect(renderer.updateTeleportPreview).toHaveBeenLastCalledWith(null, 0, 0);
  });
});

describe("PresetConnectionsController vertical interactions", () => {
  function passage(id: number, direction: PresetVerticalPassageEntry["direction"] = "forward"): PresetVerticalPassageEntry {
    return {
      id,
      from: presetEndpoint([0, 0]),
      to: presetEndpoint([0, 0], undefined, 1),
      direction,
    };
  }

  it("drags a vertical endpoint through a live preview and mutates the store only on release", () => {
    setTwoFloors();
    useMazeStore.setState({
      presetConnectionsTool: "vertical_passage_one_way",
      presetStart: null,
      presetVerticalPassages: [passage(1)],
    });
    const controller = makeController();
    const move = spyStoreAction("movePresetVerticalPassageEndpoint");

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    expect(move).not.toHaveBeenCalled();
    expect(useMazeStore.getState().presetDragOverride).toEqual({
      kind: "verticalPassageEndpoint", id: 1, end: "from", point: [1, 0],
    });

    controller.onPointerUp(0);
    expect(move).toHaveBeenCalledTimes(1);
    expect(useMazeStore.getState().presetVerticalPassages[0].from.point).toEqual([1, 0]);
    expect(useMazeStore.getState().presetVerticalPassages[0].to.point).toEqual([1, 0]);
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });

  it("cycles a one-way passage on a click and does not create a second entry", () => {
    setTwoFloors();
    useMazeStore.setState({
      presetConnectionsTool: "vertical_passage_one_way",
      presetStart: null,
      presetVerticalPassages: [passage(1)],
    });
    const controller = makeController();

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerUp(0);
    expect(useMazeStore.getState().presetVerticalPassages).toHaveLength(1);
    expect(useMazeStore.getState().presetVerticalPassages[0].direction).toBe("backward");
  });

  it("cancels a vertical drag without committing its preview", () => {
    setTwoFloors();
    useMazeStore.setState({
      presetConnectionsTool: "vertical_passage_two_way",
      presetStart: null,
      presetVerticalPassages: [passage(1, "two_way")],
    });
    const controller = makeController();
    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    controller.cancelPointerGesture();

    expect(useMazeStore.getState().presetVerticalPassages[0].from.point).toEqual([0, 0]);
    expect(useMazeStore.getState().presetDragOverride).toBeNull();
  });

  it("reports an invalid cross-floor endpoint move and keeps the passage unchanged", () => {
    setTwoFloors();
    useMazeStore.setState({
      floorFields: {
        ...useMazeStore.getState().floorFields,
        floor_2: baseFloorFieldConfig({
          tessellationConfig: { type: "square", width: 3, height: 3 },
          fieldPoints: new Set([encodePoint(0, 0)]),
          isEditingField: true,
        }),
      },
      presetConnectionsTool: "vertical_passage_two_way",
      presetStart: null,
      presetVerticalPassages: [passage(1, "two_way")],
    });
    const controller = makeController();
    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    controller.onPointerUp(0);

    expect(useMazeStore.getState().presetVerticalPassages[0].from.point).toEqual([0, 0]);
    expect(useMazeStore.getState().presetDragFailureMessage).toEqual({
      entityKind: "vertical_passage", level: 1, point: [1, 0],
    });
  });
});

describe("PresetConnectionsController elevator interactions", () => {
  function elevator(id: number, point: [number, number] = [0, 0]): PresetElevatorEntry {
    return {
      id,
      floors: [presetEndpoint(point), presetEndpoint(point, undefined, 1)],
    };
  }

  it("reopens an existing elevator editor on a plain click", () => {
    setTwoFloors();
    useMazeStore.setState({ presetConnectionsTool: "elevator", presetStart: null, presetElevators: [elevator(1)] });
    const controller = makeController();
    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerUp(0);

    expect(useMazeStore.getState().presetElevatorPending).toEqual({
      origin: presetEndpoint([0, 0]), floors: new Set([0, 1]), editingId: 1,
    });
  });

  it("drags an elevator endpoint live and commits both floor endpoints on release", () => {
    setTwoFloors();
    useMazeStore.setState({ presetConnectionsTool: "elevator", presetStart: null, presetElevators: [elevator(1)] });
    const controller = makeController();
    const move = spyStoreAction("movePresetElevatorEndpoint");

    controller.onPointerDown(...cellCenter(0), 0);
    controller.onPointerMove(...cellCenter(1));
    expect(move).not.toHaveBeenCalled();
    controller.onPointerUp(0);

    expect(move).toHaveBeenCalledTimes(1);
    expect(useMazeStore.getState().presetElevators[0].floors.map((floor) => floor.point)).toEqual([[1, 0], [1, 0]]);
  });

  it("cancels a pending elevator placement on Escape", () => {
    setTwoFloors();
    useMazeStore.setState({ presetConnectionsTool: "elevator", presetStart: null });
    const controller = makeController();
    controller.onPointerDown(...cellCenter(0), 0);
    expect(useMazeStore.getState().presetElevatorPending).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(useMazeStore.getState().presetElevatorPending).toBeNull();
  });
});

describe("PresetConnectionsController edge, cell, and renderer interactions", () => {
  it("deduplicates an edge drag and updates edge hover", () => {
    const { controller, renderer } = makeHarness();
    useMazeStore.setState({ presetConnectionsTool: "passage" });

    controller.onPointerDown(40, -20, 0);
    controller.onPointerMove(80, -20);
    controller.onPointerMove(40, -20);
    controller.onPointerUp(0);

    expect(useMazeStore.getState().presetConnections.get("0,0-1,0")?.state).toBe("passage");
    expect(useMazeStore.getState().presetConnections.get("1,0-2,0")?.state).toBe("passage");
    expect(renderer.updateHover).toHaveBeenCalledWith(expect.objectContaining({ key: "0,0-1,0" }));
  });

  it("uses clear as an edge tool near an edge and as a point tool at a cell", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "clear",
      presetConnections: new Map<string, PresetConnectionEntry>([
        ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }],
      ]),
    });

    controller.onPointerDown(40, -20, 0);
    expect(useMazeStore.getState().presetConnections.has("0,0-1,0")).toBe(false);

    const deleteAction = spyStoreAction("requestPresetEntityDelete");
    controller.onPointerDown(...cellCenter(2), 0);
    expect(deleteAction).toHaveBeenCalledWith([2, 0], undefined, { kind: "point_all" }, false);
  });

  it("updates cell hover for vertex tools and cleans teleport preview on clearHover", () => {
    const { controller, renderer } = makeHarness();
    useMazeStore.setState({ presetConnectionsTool: "set_start" });
    controller.onPointerMove(...cellCenter(1));
    expect(renderer.updateCellHover).toHaveBeenLastCalledWith([1, 0]);
    expect(renderer.updateHover).toHaveBeenLastCalledWith(null);

    controller.clearHover();
    expect(renderer.updateHover).toHaveBeenLastCalledWith(null);
    expect(renderer.updateCellHover).toHaveBeenLastCalledWith(null);
    expect(renderer.updateTeleportPreview).toHaveBeenLastCalledWith(null, 0, 0);
  });

  it("supports lock, generation-source, and split-node tools through public pointer methods", () => {
    const controller = makeController();
    useMazeStore.setState({ presetConnectionsTool: "lock_in" });
    controller.onPointerDown(...cellCenter(1), 0);
    expect(useMazeStore.getState().lockedNodes.get("1,0")).toBe("in");
    controller.onPointerDown(...cellCenter(1), 2);
    expect(useMazeStore.getState().lockedNodes.has("1,0")).toBe(false);

    useMazeStore.setState({ presetConnectionsTool: "gen_source" });
    controller.onPointerDown(...cellCenter(2), 0);
    expect(useMazeStore.getState().presetGenSource).toEqual(presetEndpoint([2, 0]));

    useMazeStore.setState({ presetConnectionsTool: "manage_split_nodes" });
    controller.onPointerDown(...cellCenter(1), 0);
    expect(useMazeStore.getState().presetFocusedPoint).toEqual([1, 0]);
  });

  it("clears the generation source and lock with right-click", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "gen_source",
      presetGenSource: presetEndpoint([1, 0]),
    });
    controller.onPointerDown(...cellCenter(1), 2);
    expect(useMazeStore.getState().presetGenSource).toBeNull();

    useMazeStore.setState({
      presetConnectionsTool: "lock_out",
      lockedNodes: new Map([["1,0", "out"]]),
    });
    controller.onPointerDown(...cellCenter(1), 2);
    expect(useMazeStore.getState().lockedNodes).toEqual(new Map());
  });

  it("defers split-cell vertex placement to the public split-target prompt", () => {
    const controller = makeController();
    useMazeStore.setState({
      presetConnectionsTool: "set_start",
      presetStart: null,
      presetSplitPoints: { "1,0": [2] },
    });

    controller.onPointerDown(...cellCenter(1), 0);

    expect(useMazeStore.getState().presetSplitTargetPrompt).toEqual({
      point: [1, 0], level: undefined, slotIds: [2], action: { tool: "set_start" },
    });
    expect(useMazeStore.getState().presetStart).toBeNull();
  });

  it("captures Shift for bulk point deletion and bypasses the entity prompt", () => {
    const controller = makeController();
    const requestDelete = spyStoreAction("requestPresetEntityDelete");
    useMazeStore.setState({
      presetConnectionsTool: "clear",
      presetStart: presetEndpoint([0, 0]),
      presetFinish: presetEndpoint([0, 0]),
    });

    controller.onPointerDown(...cellCenter(0), 0, true);
    controller.onPointerMove(...cellCenter(1));

    expect(requestDelete).toHaveBeenCalledWith([0, 0], undefined, { kind: "point_all" }, true);
    expect(useMazeStore.getState().presetEntityDeletePrompt).toBeNull();
    expect(requestDelete).toHaveBeenCalledTimes(2);
    expect(requestDelete).toHaveBeenLastCalledWith([1, 0], undefined, { kind: "point_all" }, true);
  });
});
