import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { es, makeState, toJson } from "./projectExportKit";

describe("serializeProject / parseAndValidate round-trip: generation, history and post-edit", () => {
  it("round-trips a non-empty seed history and index", () => {
    const state = makeState({ seedHistory: [10, 20, 30], seedHistoryIndex: 1 });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.generation.seedHistory).toEqual([10, 20, 30]);
    expect(reparsed.generation.seedHistoryIndex).toBe(1);
  });

  it("defaults seedHistory/seedHistoryIndex for a project file saved before seed history existed", () => {
    const state = makeState();
    const raw = toJson(state);
    delete raw.generation.seedHistory;
    delete raw.generation.seedHistoryIndex;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.seedHistory).toEqual([]);
    expect(reparsed.generation.seedHistoryIndex).toBe(0);
  });

  it("drops non-integer garbage from seedHistory and clamps an out-of-range seedHistoryIndex", () => {
    const state = makeState({ seedHistory: [10, 20, 30], seedHistoryIndex: 2 });
    const raw = toJson(state);
    raw.generation.seedHistory = [10, NaN, "20", 1.5, 30];
    raw.generation.seedHistoryIndex = 99;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.seedHistory).toEqual([10, 30]);
    expect(reparsed.generation.seedHistoryIndex).toBe(1);
  });

  it("round-trips a non-empty splitGeneration config (GitHub issue #222)", () => {
    const state = makeState({
      splitPatternMode: true,
      splitMaxNodes: 3,
      splitPatterns: [
        {
          shape: "regular:4",
          node_count: 2,
          faces: [
            [
              { face_index: 0, requirement: { kind: "passage" } },
              { face_index: 1, requirement: { kind: "one_way", direction: "forward" }, sibling_target: 1 },
            ],
            [
              { face_index: 2, requirement: { kind: "wall" } },
            ],
          ],
          weight: 2.5,
        },
      ],
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.generation.splitGeneration).toEqual(serialized.generation.splitGeneration);
    expect(reparsed.generation.splitGeneration.patternMode).toBe(true);
    expect(reparsed.generation.splitGeneration.maxSplitNodes).toBe(3);
    expect(reparsed.generation.splitGeneration.patterns).toHaveLength(1);
  });

  it("defaults splitGeneration cleanly for a project file saved before this feature existed", () => {
    const state = makeState();
    const raw = toJson(state);
    delete raw.generation.splitGeneration;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.splitGeneration).toEqual({ patternMode: false, maxSplitNodes: 2, patterns: [] });
  });

  it("drops a malformed split pattern without failing the whole file", () => {
    const state = makeState({ splitPatternMode: true, splitMaxNodes: 2, splitPatterns: [] });
    const raw = toJson(state);
    raw.generation.splitGeneration.patterns = [{ shape: "regular:4", node_count: "not a number" }, { garbage: true }];
    const reparsed = parseAndValidate(raw);
    expect(reparsed.generation.splitGeneration.patterns).toEqual([]);
  });

  it("defaults repair limits for a project file saved before this setting existed", () => {
    const state = makeState();
    const serialized = serializeProject(state);
    const raw = JSON.parse(JSON.stringify(serialized));
    delete raw.quality.repairMaxIterations;
    delete raw.quality.repairTimeBudgetSecs;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.quality.repairMaxIterations).toBe(100);
    expect(reparsed.quality.repairTimeBudgetSecs).toBe(10);
  });

  it("round-trips dirty post-edit command log", () => {
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "basic") },
      { kind: "setEdge", edge: es(nodeEndpoint(1), nodeEndpoint(2), "one_way_forward") },
      { kind: "setMeta", slot: "start", endpoint: nodeEndpoint(0) },
      { kind: "setMeta", slot: "finish", endpoint: nodeEndpoint(2) },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toEqual(serialized.postEdit);
  });

  // GitHub issue #425: a split endpoint's `level` (non-zero floor) was silently dropped by
  // `validatePostEditEndpoint` on project load, collapsing every floor-1+ split reference onto
  // floor 0 after a save/load round-trip even though `level` was correctly serialized.
  it("round-trips a split post-edit endpoint's non-zero level (GitHub issue #425)", () => {
    const commands: PostEditCommand[] = [
      { kind: "setEdge", edge: es(splitEndpoint([0, 0], 0, 1), nodeEndpoint(12), "basic") },
      { kind: "setMeta", slot: "start", endpoint: splitEndpoint([0, 0], 0, 1) },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toEqual(serialized.postEdit);
    const reparsedFrom = reparsed.postEdit?.commands[0].kind === "setEdge" ? reparsed.postEdit.commands[0].edge.from : undefined;
    expect(reparsedFrom).toEqual(splitEndpoint([0, 0], 0, 1));
  });

  it("round-trips dirty post-edit teleports", () => {
    const commands: PostEditCommand[] = [
      { kind: "addTeleport", id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(2), direction: "forward" },
      { kind: "addTeleport", id: "t2", from: nodeEndpoint(1), to: nodeEndpoint(3), direction: "two_way" },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands, _nextPostEditTeleportId: 3 });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit?.commands).toEqual(serialized.postEdit?.commands);
  });

  it("round-trips split points", () => {
    const commands: PostEditCommand[] = [
      { kind: "addSplitNode", point: [3, 4], slotId: 0, pointId: "s1" },
      { kind: "addSplitNode", point: [3, 4], slotId: 1, pointId: "s1" },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands, _nextSplitSlotId: { "3,4": 2 } });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit?.commands).toEqual(commands);
    expect(reparsed.postEdit?.nextSplitSlotId).toEqual({ "3,4": 2 });
  });
});
