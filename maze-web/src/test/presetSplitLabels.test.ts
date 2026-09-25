import { describe, expect, it, vi } from "vitest";

vi.mock("../pixi/fieldEditUtils", async () => {
  const actual = await vi.importActual<typeof import("../pixi/fieldEditUtils")>("../pixi/fieldEditUtils");
  return {
    ...actual,
    allNodesAt: (point: [number, number], _splitPoints: Record<string, number[]>, level?: number) => [
      { point, ...(level === undefined ? {} : { level }) },
      { point, slotId: 0, ...(level === undefined ? {} : { level }) },
    ],
    presetSplitNodeFaceKinds: (endpoint: { slotId?: number }) => endpoint.slotId === undefined
      ? ["passage", "wall", "passage", "wall"]
      : ["wall", "passage", "wall", "passage"],
  };
});

import { presetEndpoint } from "../pixi/presetEndpoint";
import { presetTargetLabel, resolvePresetSplitNodeShortLabel, type PresetSplitLabelContext } from "../pixi/presetSplitLabels";

describe("resolvePresetSplitNodeShortLabel", () => {
  it("uses semantic names for a recognized bridge instead of N labels", () => {
    const original = presetEndpoint([5, 5]);
    const slot = presetEndpoint([5, 5], 0);
    const context: PresetSplitLabelContext = {
      splitPoints: { "5,5": [0] },
      presetConnections: new Map(),
      activeSplitNode: {},
      cfgAt: () => ({ type: "square", width: 10, height: 10 }),
      inFieldCellsAt: () => new Set(),
    };

    expect(resolvePresetSplitNodeShortLabel(context, original)).toBe("Cor");
    expect(resolvePresetSplitNodeShortLabel(context, slot)).toBe("Brg");
  });
});

describe("presetTargetLabel floorOnly", () => {
  it("drops coordinates and the split-node suffix for a target landing on a split tile (GitHub issue #595 follow-up)", () => {
    const slot = presetEndpoint([5, 5], 0, 1);
    const context: PresetSplitLabelContext = {
      splitPoints: { "5,5@1": [0] },
      presetConnections: new Map(),
      activeSplitNode: {},
      cfgAt: () => ({ type: "square", width: 10, height: 10 }),
      inFieldCellsAt: () => new Set(),
    };

    // Without floorOnly this would resolve a split suffix ("Brg") alongside the coordinates —
    // floorOnly must drop both, leaving just the floor.
    expect(presetTargetLabel(context, slot, true, true)).toBe("L2");
  });
});
