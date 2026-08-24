import { describe, it, expect } from "vitest";
import { buildPresetCellInspection } from "../pixi/selectors/presetCellInspection";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../pixi/fieldEditUtils";
import type { NodeLockKind } from "../wasm/types";

function empty(x: number, y: number, floorLevel = 0) {
  return buildPresetCellInspection(
    x, y, floorLevel, {}, null, null, null, [], [], [],
    new Map<string, NodeLockKind>(), new Set<string>(),
  );
}

describe("buildPresetCellInspection", () => {
  it("no marker at all -> bare coordinates", () => {
    expect(empty(3, 5)).toBe("x:3, y:5");
  });

  it("start marker", () => {
    const result = buildPresetCellInspection(
      3, 5, 0, {}, presetEndpoint([3, 5]), null, null, [], [], [],
      new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Start");
  });

  it("finish marker", () => {
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, presetEndpoint([3, 5]), null, [], [], [],
      new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Finish");
  });

  it("gen source marker", () => {
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, presetEndpoint([3, 5]), [], [], [],
      new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Gen source");
  });

  it("manual lock", () => {
    const locked = new Map<string, NodeLockKind>([["3,5", "in"]]);
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, [], [], [], locked, new Set(),
    );
    expect(result).toBe("x:3, y:5 | Lock (in)");
  });

  it("auto-lock (no manual entry)", () => {
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, [], [], [], new Map(), new Set(["3,5"]),
    );
    expect(result).toBe("x:3, y:5 | Lock (both)");
  });

  it("same-floor two-way teleport", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([7, 2]), direction: "two_way" },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, teleports, [], [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Teleport <-> (7,2)");
  });

  it("one-way teleport, departure end", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([7, 2]), direction: "forward" },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, teleports, [], [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Teleport -> (7,2)");
  });

  it("one-way teleport, arrival end", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([7, 2]), direction: "forward" },
    ];
    const result = buildPresetCellInspection(
      7, 2, 0, {}, null, null, null, teleports, [], [], new Map(), new Set(),
    );
    expect(result).toBe("x:7, y:2 | Teleport <- (3,5)");
  });

  it("backward teleport direction flips departure/arrival reading", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([7, 2]), direction: "backward" },
    ];
    // actual passage runs to -> from, so (3,5) is the arrival end
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, teleports, [], [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Teleport <- (7,2)");
  });

  it("cross-floor teleport shows floor label", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([7, 2], undefined, 2), direction: "forward" },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, teleports, [], [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Teleport -> (L3)");
  });

  it("bidirectional vertical passage", () => {
    const verticals: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([3, 5], undefined, 1), direction: "two_way" },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, [], verticals, [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Vertical passage <-> (L2)");
  });

  it("one-way vertical passage, arrival end", () => {
    const verticals: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([3, 5], undefined, 1), direction: "forward" },
    ];
    const result = buildPresetCellInspection(
      3, 5, 1, {}, null, null, null, [], verticals, [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Vertical passage <- (L1)");
  });

  it("backward vertical passage, departure end reads as arrival", () => {
    const verticals: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([3, 5]), to: presetEndpoint([3, 5], undefined, 1), direction: "backward" },
    ];
    // actual passage runs to -> from, so (3,5) on floor 0 is the arrival end
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, [], verticals, [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Vertical passage <- (L2)");
  });

  it("elevator to several floors, no arrow, sorted/deduped", () => {
    const elevators: PresetElevatorEntry[] = [
      {
        id: 1,
        floors: [
          presetEndpoint([3, 5]),
          presetEndpoint([3, 5], undefined, 3),
          presetEndpoint([3, 5], undefined, 1),
        ],
      },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, [], [], elevators, new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | Elevator (L2, L4)");
  });

  it("elevator not touching this node is ignored", () => {
    const elevators: PresetElevatorEntry[] = [
      {
        id: 1,
        floors: [presetEndpoint([7, 2]), presetEndpoint([7, 2], undefined, 1)],
      },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, {}, null, null, null, [], [], elevators, new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5");
  });

  it("split point: original + declared slot, empty/populated, lock only on original", () => {
    const presetSplitPoints = { "3,5": [0] };
    const locked = new Map<string, NodeLockKind>([["3,5", "both"]]);
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([3, 5], 0), to: presetEndpoint([7, 2]), direction: "forward" },
    ];
    const result = buildPresetCellInspection(
      3, 5, 0, presetSplitPoints, presetEndpoint([3, 5], 0), null, null, teleports, [], [],
      locked, new Set(),
    );
    expect(result).toBe("x:3, y:5 | [Node 1: Lock (both)] | [Node 2: Start; Teleport -> (7,2)]");
  });

  it("split point: auto-lock (no manual entry) reported only on original node", () => {
    const presetSplitPoints = { "3,5": [0] };
    const result = buildPresetCellInspection(
      3, 5, 0, presetSplitPoints, null, null, null, [], [], [], new Map(), new Set(["3,5"]),
    );
    expect(result).toBe("x:3, y:5 | [Node 1: Lock (both)] | [Node 2: empty]");
  });

  it("split point ordering: original first, then ascending slotId", () => {
    const presetSplitPoints = { "3,5": [5, 1] };
    const result = buildPresetCellInspection(
      3, 5, 0, presetSplitPoints, null, null, null, [], [], [], new Map(), new Set(),
    );
    expect(result).toBe("x:3, y:5 | [Node 1: empty] | [Node 2: empty] | [Node 3: empty]");
  });

  it("non-floor-0 point key uses @level suffix consistently with lock storage", () => {
    const locked = new Map<string, NodeLockKind>([["3,5@2", "out"]]);
    const result = buildPresetCellInspection(
      3, 5, 2, {}, null, null, null, [], [], [], locked, new Set(),
    );
    expect(result).toBe("x:3, y:5 | Lock (out)");
  });
});
