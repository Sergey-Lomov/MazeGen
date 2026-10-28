import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { makeState, toJson } from "./projectExportKit";

describe("serializeProject / parseAndValidate round-trip: validation and presets", () => {
  it("rejects a project file with an unregistered version", () => {
    const state = makeState({ postEditDirty: true, postEditCommands: [] });
    const data = toJson(state);
    data.version = 3;
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("rejects an invalid PostEditEndpoint kind", () => {
    const commands: PostEditCommand[] = [
      { kind: "setMeta", slot: "start", endpoint: { kind: "bogus" } as unknown as ReturnType<typeof nodeEndpoint> },
    ];
    const state = makeState({ postEditDirty: true, postEditCommands: commands });
    const data = toJson(state);
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("rejects an unknown PostEditCommand kind", () => {
    const state = makeState({ postEditDirty: true, postEditCommands: [] });
    const data = toJson(state);
    data.postEdit.commands = [{ kind: "bogus" }];
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("postEdit is null when not dirty", () => {
    const state = makeState({ postEditDirty: false });
    const serialized = serializeProject(state);
    expect(serialized.postEdit).toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.postEdit).toBeNull();
  });

  it("round-trips preset connections and locked nodes", () => {
    const state = makeState({
      presetConnections: new Map([
        ["0,0-1,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([1, 0]), state: "passage", source: "user" }],
      ]),
      lockedNodes: new Map([["2,3", "both"]]),
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.presets.connections).toEqual(serialized.presets.connections);
    expect(reparsed.presets.lockedNodes).toEqual(serialized.presets.lockedNodes);
  });

  it("round-trips preset teleports", () => {
    const state = makeState({
      presetTeleports: [
        { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "forward" },
        { id: 2, from: presetEndpoint([1, 1]), to: presetEndpoint([3, 3]), direction: "two_way" },
      ],
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.presets.teleports).toEqual(serialized.presets.teleports);
  });

  it("round-trips preset list identity and creation-order metadata", () => {
    const state = makeState({
      presetSplitPoints: { "2,2": [0] },
      presetSplitPointIds: { "2,2": "s4" },
      presetEntityOrder: ["teleport:2", "split:2,2"],
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));

    expect(reparsed.presets.splitPointIds).toEqual({ "2,2": "s4" });
    expect(reparsed.presets.entityOrder).toEqual(["teleport:2", "split:2,2"]);
  });

  it("defaults presets.teleports to empty array for a project file saved before teleports existed", () => {
    const data = toJson(makeState());
    delete data.presets.teleports;
    const result = parseAndValidate(data);
    expect(result.presets.teleports).toEqual([]);
  });
});
