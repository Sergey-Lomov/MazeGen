import { describe, expect, it, vi } from "vitest";

vi.mock("../domain/presetSplitResolve", async () => {
  const actual = await vi.importActual<typeof import("../domain/presetSplitResolve")>("../domain/presetSplitResolve");
  return {
    ...actual,
    presetSplitNodeFaceKinds: (endpoint: { slotId?: number }) => endpoint.slotId === undefined
      ? ["wall", "wall", "wall", "wall"]
      : ["undefined", "undefined", "undefined", "undefined"],
  };
});

import type { PresetSplitLabelContext } from "../domain/presetSplitLabels";
import { buildCellSet } from "../domain/selectors/sharedSelectors";
import { computePresetSplitProblems } from "../pixi/selectors/presetSplitProblems";
import { fieldOf } from "./fieldConfigFixtures";

const cells: [number, number][] = [];
for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) cells.push([x, y]);

function context(splitPoints: Record<string, number[]>): PresetSplitLabelContext {
  return {
    splitPoints,
    presetConnections: new Map(),
    activeSplitNode: {},
    cfgAt: () => fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
    inFieldCellsAt: () => buildCellSet(cells),
  };
}

describe("computePresetSplitProblems (GitHub issue #1107)", () => {
  it("reports a wall-only node under its point", () => {
    const [problem] = computePresetSplitProblems(context({ "5,5": [0] }));
    expect(problem.key).toBe("5,5");
    expect(problem.messages).toEqual(["Node 1 only has wall faces and no valid neighbor, it will be unreachable."]);
  });

  it("builds the in-field cell set once per floor and checks each point with its own floor's config", () => {
    const calls: number[] = [];
    const cfgLevels: number[] = [];
    const ctx: PresetSplitLabelContext = {
      ...context({ "5,5": [0], "6,6": [0], "5,5@1": [0] }),
      cfgAt: (level) => { cfgLevels.push(level); return fieldOf("square", { shape: "rect", cols: 10, rows: 10 }); },
      inFieldCellsAt: (level) => { calls.push(level); return buildCellSet(cells); },
    };

    const problems = computePresetSplitProblems(ctx);

    expect(problems.map((problem) => problem.key)).toEqual(["5,5", "6,6", "5,5@1"]);
    expect(calls.sort()).toEqual([0, 1]);
    expect(cfgLevels.sort()).toEqual([0, 0, 1]);
  });

  it("leaves out empty points", () => {
    expect(computePresetSplitProblems(context({ "5,5": [] }))).toEqual([]);
  });
});
