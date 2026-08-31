import { describe, it, expect } from "vitest";
import { buildPresetCellInspection } from "../pixi/selectors/presetCellInspection";
import { presetEndpoint, type PresetEndpoint } from "../pixi/presetEndpoint";
import { presetEdgeKey, type PresetConnectionEntry, type PresetTeleportEntry, type PresetVerticalPassageEntry, type PresetElevatorEntry } from "../pixi/fieldEditUtils";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
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

  // GitHub issue #487 — a preset split point whose face configuration matches a recognized
  // special-split topology titles each block with the semantic node name instead of "Node N".
  describe("semantic split-node names (GitHub issue #487)", () => {
    const cfg: TessellationConfig = { type: "square", width: 3, height: 3 };
    // Square neighbor offsets are [+x, +y, -x, -y]. Point (1,1): the original node owns the
    // +x/-x opposite pair (the through "Corridor"), slot 0 owns the +y/-y pair (the "Bridge").
    const inFieldCells = new Set(["0,1", "1,0", "1,1", "1,2", "2,1"]);
    const presetSplitPoints = { "1,1": [0] };

    const entry = (state: "passage" | "wall") => (a: PresetEndpoint, b: PresetEndpoint): [string, PresetConnectionEntry] => {
      // presetEdgeKey canonicalizes from/to itself; the state is direction-agnostic here.
      return [presetEdgeKey(a, b), { from: a, to: b, state, source: "user" }];
    };
    const passage = entry("passage");
    const wall = entry("wall");
    const original = presetEndpoint([1, 1]);
    const slot0 = presetEndpoint([1, 1], 0);
    // Each node needs an explicit `wall` on the faces it doesn't own — an absent entry reads as
    // `"undefined"` (optional), which `detectSplitSpecialShapeKind` still counts as connected.
    const presetConnections = new Map<string, PresetConnectionEntry>([
      passage(original, presetEndpoint([2, 1])),
      passage(original, presetEndpoint([0, 1])),
      wall(original, presetEndpoint([1, 2])),
      wall(original, presetEndpoint([1, 0])),
      passage(slot0, presetEndpoint([1, 2])),
      passage(slot0, presetEndpoint([1, 0])),
      wall(slot0, presetEndpoint([2, 1])),
      wall(slot0, presetEndpoint([0, 1])),
    ]);

    it("bridge split cell: blocks titled 'Corridor' / 'Bridge' when cfg recognizes the topology", () => {
      const result = buildPresetCellInspection(
        1, 1, 0, presetSplitPoints, presetEndpoint([1, 1]), null, null, [], [], [],
        new Map(), new Set(),
        cfg, inFieldCells, presetConnections,
      );
      expect(result).toBe("x:1, y:1 | [Corridor: Start] | [Bridge: empty]");
    });

    it("without cfg the same bridge cell still falls back to 'Node N'", () => {
      const result = buildPresetCellInspection(
        1, 1, 0, presetSplitPoints, presetEndpoint([1, 1]), null, null, [], [], [],
        new Map(), new Set(),
      );
      expect(result).toBe("x:1, y:1 | [Node 1: Start] | [Node 2: empty]");
    });
  });
});
