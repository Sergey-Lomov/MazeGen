import { describe, expect, it, vi } from "vitest";

vi.mock("../pixi/fieldEditUtils", async () => {
  const actual = await vi.importActual<typeof import("../pixi/fieldEditUtils")>("../pixi/fieldEditUtils");
  return {
    ...actual,
    allNodesAt: (point: [number, number], splitPoints: Record<string, number[]>, level?: number) => {
      const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
      return [
        { point, ...(level === undefined ? {} : { level }) },
        ...(splitPoints[key] ?? []).map((slotId) => ({ point, slotId, ...(level === undefined ? {} : { level }) })),
      ];
    },
    presetSplitNodeFaceKinds: (endpoint: { slotId?: number }) => endpoint.slotId === undefined
      ? ["passage", "wall", "passage", "wall"]
      : ["wall", "passage", "wall", "passage"],
  };
});

import { buildPresetListCells, filterPresetListCells, PRESET_LIST_TYPES, PRESET_LIST_TYPES_OFF_BY_DEFAULT, type PresetListInput, type PresetListType } from "../components/features/PresetList";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { PresetSplitLabelContext } from "../pixi/presetSplitLabels";

const emptyInput = (): PresetListInput => ({
  presetConnections: new Map(),
  presetStart: null,
  presetFinish: null,
  presetGenSource: null,
  presetTeleports: [],
  presetVerticalPassages: [],
  presetElevators: [],
  lockedNodes: new Map(),
  presetSplitPoints: {},
  multiFloor: false,
});

describe("buildPresetListCells", () => {
  it("exposes fifteen filters with twelve enabled by default", () => {
    expect(PRESET_LIST_TYPES).toHaveLength(15);
    expect(PRESET_LIST_TYPES.filter((type) => !PRESET_LIST_TYPES_OFF_BY_DEFAULT.includes(type as typeof PRESET_LIST_TYPES_OFF_BY_DEFAULT[number]))).toHaveLength(12);
  });

  it("builds complete cells and excludes derived default edges", () => {
    const from = presetEndpoint([0, 0]);
    const to = presetEndpoint([1, 0]);
    const input = emptyInput();
    input.presetConnections = new Map([
      ["default", { from, to, state: "wall", source: "default" }],
      ["user", { from, to: presetEndpoint([0, 1]), state: "one_way_backward", source: "user" }],
    ]);
    input.presetStart = presetEndpoint([2, 2]);
    input.presetTeleports = [{ id: 4, from, to: presetEndpoint([3, 3]), direction: "forward" }];
    input.presetVerticalPassages = [{ id: 5, from, to: presetEndpoint([0, 0], undefined, 1), direction: "backward" }];
    input.presetElevators = [{ id: 6, floors: [from, presetEndpoint([0, 0], undefined, 1)] }];
    input.lockedNodes = new Map([["4,4", "both"]]);
    input.presetSplitPoints = { "5,5": [0] };

    const cells = buildPresetListCells(input);

    expect(cells.map((cell) => cell.key)).toEqual([
      "edge:0,0-0,1",
      "start",
      "teleport:4",
      "vertical_passage:5",
      "elevator:6",
      "lock:4,4",
      "split:5,5",
    ]);
    expect(cells.find((cell) => cell.key === "edge:0,0-0,1")?.control).toEqual({ kind: "direction", id: "user" });
    expect(cells.find((cell) => cell.key === "teleport:4")?.control).toEqual({ kind: "direction", id: "4" });
    expect(cells.find((cell) => cell.key === "vertical_passage:5")?.control).toEqual({ kind: "direction", id: "5" });
    expect(cells.find((cell) => cell.key === "elevator:6")?.control).toEqual({ kind: "elevator", id: 6, endpoint: from });
    expect(cells.find((cell) => cell.key === "teleport:4")?.arrow).toBe("->");
    expect(cells.find((cell) => cell.key === "edge:0,0-0,1")?.id).toBeUndefined();
    expect(cells.find((cell) => cell.key === "edge:0,0-0,1")?.linkHighlightStyle).toBe("one_way");
    expect(cells.find((cell) => cell.key === "teleport:4")?.id).toBe("t4");
    expect(cells.find((cell) => cell.key === "teleport:4")?.link).toBeUndefined();
    expect(cells.find((cell) => cell.key === "vertical_passage:5")?.id).toBe("v5");
    expect(cells.find((cell) => cell.key === "vertical_passage:5")?.link).toBeUndefined();
    expect(cells.find((cell) => cell.key === "elevator:6")?.id).toBe("e6");
    expect(cells.find((cell) => cell.key === "start")?.id).toBe("s");
    expect(cells.find((cell) => cell.key === "lock:4,4")?.id).toBe("l1");
    expect(cells.find((cell) => cell.key === "split:5,5")?.id).toBe("s1");
    expect(cells.find((cell) => cell.key === "split:5,5")?.title).toBe("Split tile");
    expect(cells.find((cell) => cell.key === "split:5,5")?.entityHighlightMode).toBe("outset");
  });

  it("assigns cell-entity ids and uses boundary highlighting for undefined edges", () => {
    const from = presetEndpoint([0, 0]);
    const to = presetEndpoint([1, 0]);
    const input = emptyInput();
    input.presetConnections = new Map([["undefined", { from, to, state: "undefined", source: "user" }]]);
    input.presetStart = from;
    input.presetFinish = to;
    input.presetGenSource = presetEndpoint([2, 0]);
    input.lockedNodes = new Map([["3,0", "both"]]);

    const cells = buildPresetListCells(input);

    expect(cells.find((cell) => cell.key === "start")?.id).toBe("s");
    expect(cells.find((cell) => cell.key === "finish")?.id).toBe("f");
    expect(cells.find((cell) => cell.key === "gen_source")?.id).toBe("gs");
    expect(cells.find((cell) => cell.key === "lock:3,0")?.id).toBe("l1");
    expect(cells.find((cell) => cell.key === "edge:0,0-1,0")?.linkHighlightStyle).toBe("boundary");
    expect(cells.find((cell) => cell.key === "edge:0,0-1,0")?.link).toEqual({ from, to });
  });

  it("includes floor labels in every coordinate bubble for a multi-floor maze", () => {
    const input = emptyInput();
    input.multiFloor = true;
    input.presetStart = presetEndpoint([2, 3], undefined, 1);
    input.presetTeleports = [{
      id: 1,
      from: presetEndpoint([0, 0]),
      to: presetEndpoint([2, 3], undefined, 1),
      direction: "two_way",
    }];

    const cells = buildPresetListCells(input);

    expect(cells.find((cell) => cell.key === "start")?.bubbles[0].text).toBe("L2 2:3");
    expect(cells.find((cell) => cell.key === "teleport:1")?.bubbles.map((item) => item.text)).toEqual(["L1 0:0", "L2 2:3"]);
  });

  it("uses shared split-node labels for original and extra-node bubbles", () => {
    const splitCtx: PresetSplitLabelContext = {
      splitPoints: { "2,2": [7] },
      presetConnections: new Map(),
      activeSplitNode: {},
      cfgAt: () => ({ type: "square", width: 10, height: 10 }),
      inFieldCellsAt: () => new Set(),
    };
    const input = emptyInput();
    input.splitCtx = splitCtx;
    input.presetSplitPoints = splitCtx.splitPoints;
    input.presetStart = presetEndpoint([2, 2]);
    input.presetTeleports = [{
      id: 1,
      from: presetEndpoint([2, 2]),
      to: presetEndpoint([2, 2], 7),
      direction: "two_way",
    }];

    const cells = buildPresetListCells(input);

    expect(cells.find((cell) => cell.key === "start")?.bubbles[0].text).toBe("2:2 (Cor)");
    expect(cells.find((cell) => cell.key === "teleport:1")?.bubbles.map((item) => item.text)).toEqual([
      "2:2 (Cor)",
      "2:2 (Brg)",
    ]);
  });

  it("groups split connections into one split entity and follows creation order", () => {
    const input = emptyInput();
    const split = presetEndpoint([2, 2]);
    input.presetSplitPoints = { "2,2": [0] };
    input.presetSplitPointIds = { "2,2": "s3" };
    input.presetSplitShapeLabels = { "2,2": "Bridge" };
    input.presetConnections = new Map([
      ["split-face", { from: split, to: presetEndpoint([3, 2]), state: "passage", source: "user" }],
      ["plain", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }],
    ]);
    input.presetEntityOrder = ["edge:0,0-1,0", "split:2,2"];

    const cells = buildPresetListCells(input);

    expect(cells.map((cell) => cell.key)).toEqual(["split:2,2", "edge:0,0-1,0"]);
    expect(cells.find((cell) => cell.key === "split:2,2")?.id).toBe("s3");
    expect(cells.find((cell) => cell.key === "split:2,2")?.title).toBe("Bridge (Split)");
    expect(cells.find((cell) => cell.key === "split:2,2")?.control).toEqual({ kind: "split", endpoint: split });
  });

  it("classifies edge states so wall and passage rows can be hidden independently", () => {
    const input = emptyInput();
    input.presetConnections = new Map([
      ["wall", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "wall", source: "user" }],
      ["passage", { from: presetEndpoint([0, 1]), to: presetEndpoint([1, 1]), state: "passage", source: "user" }],
      ["one-way", { from: presetEndpoint([0, 2]), to: presetEndpoint([1, 2]), state: "one_way_forward", source: "user" }],
    ]);

    const cells = buildPresetListCells(input);
    const types = new Set<PresetListType>(["wall", "one_way"]);

    expect(cells.map((cell) => [cell.key, cell.type])).toEqual([
      ["edge:0,0-1,0", "wall"],
      ["edge:0,1-1,1", "passage"],
      ["edge:0,2-1,2", "one_way"],
    ]);
    expect(filterPresetListCells(cells, { types, floor: "all" }).map((cell) => cell.key)).toEqual([
      "edge:0,0-1,0",
      "edge:0,2-1,2",
    ]);
  });

  it("shows an entity on every floor touched by its endpoints", () => {
    const input = emptyInput();
    input.presetTeleports = [{
      id: 1,
      from: presetEndpoint([0, 0], undefined, 0),
      to: presetEndpoint([0, 0], undefined, 2),
      direction: "two_way",
    }];
    input.presetStart = presetEndpoint([1, 1], undefined, 1);
    input.presetElevators = [{
      id: 2,
      floors: [presetEndpoint([2, 2], undefined, 1), presetEndpoint([2, 2], undefined, 2)],
    }];

    const cells = buildPresetListCells(input);
    const allTypes = new Set<PresetListType>(["teleport", "start", "elevator"]);

    expect(filterPresetListCells(cells, { types: allTypes, floor: 0 }).map((cell) => cell.key)).toEqual(["teleport:1"]);
    expect(filterPresetListCells(cells, { types: allTypes, floor: 1 }).map((cell) => cell.key)).toEqual(["start", "elevator:2"]);
    expect(filterPresetListCells(cells, { types: allTypes, floor: 2 }).map((cell) => cell.key)).toEqual(["teleport:1", "elevator:2"]);
  });
});
