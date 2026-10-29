import { describe, it, expect } from "vitest";
import { parseAndValidate } from "../store/projectExport";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { makeState, toJson } from "./projectExportKit";

describe("parseAndValidate — malformed input", () => {
  const valid = () => toJson(makeState());

  it("throws on missing version", () => {
    const data = valid();
    delete data.version;
    expect(() => parseAndValidate(data)).toThrow();
  });

  it("throws on version newer than supported", () => {
    const data = valid();
    data.version = 999;
    expect(() => parseAndValidate(data)).toThrow(/newer than supported/);
  });

  it("throws on unknown field shape", () => {
    const data = valid();
    data.floorFields.floor_1.shape.shape = "not_a_real_shape";
    expect(() => parseAndValidate(data)).toThrow(/Unknown field shape/);
  });

  it("throws on a field shape or saved shape the kind does not offer", () => {
    const data = valid();
    data.floorFields.floor_1.shape = { shape: "parallelogram", cols: 3, rows: 3 };
    expect(() => parseAndValidate(data)).toThrow(/floorFields\.floor_1\.shape: kind "square" does not offer shape "parallelogram"/);

    const saved = valid();
    saved.floorFields.floor_1.savedShapes = [{ shape: "hexagon", radius: 2 }];
    expect(() => parseAndValidate(saved)).toThrow(/savedShapes\[0\]: kind "square" does not offer shape "hexagon"/);
  });

  it("throws on tessellation params the kind does not accept", () => {
    const data = valid();
    data.tessellation.params = { rings: 3 };
    expect(() => parseAndValidate(data)).toThrow(/does not accept param "rings"/);
  });

  it("throws on invalid postEditEdge kind", () => {
    const data = valid();
    data.postEdit = {
      commands: [{ kind: "setEdge", edge: { kind: "bogus", from: nodeEndpoint(0), to: nodeEndpoint(1) } }],
      nextTeleportId: 1, nextVerticalPassageId: 1, nextElevatorId: 1, nextSplitSlotId: {},
      nextSplitPointId: 1,
    };
    expect(() => parseAndValidate(data)).toThrow(/Invalid PostEditEdge kind/);
  });

  it("throws on invalid defaultEdgeState", () => {
    const data = valid();
    data.presets.defaultEdgeState = "bogus";
    expect(() => parseAndValidate(data)).toThrow(/Invalid defaultEdgeState/);
  });

  it("throws on duplicate teleport id", () => {
    const data = valid();
    data.presets.teleports = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "forward" },
      { id: 1, from: presetEndpoint([1, 1]), to: presetEndpoint([3, 3]), direction: "two_way" },
    ];
    expect(() => parseAndValidate(data)).toThrow(/Duplicate teleport id/);
  });

  it("throws on invalid post-edit teleport direction", () => {
    const data = valid();
    data.postEdit = {
      commands: [{ kind: "addTeleport", id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(2), direction: "bogus" }],
      nextTeleportId: 2, nextVerticalPassageId: 1, nextElevatorId: 1, nextSplitSlotId: {},
      nextSplitPointId: 1,
    };
    expect(() => parseAndValidate(data)).toThrow(/Invalid.*[Dd]irection/);
  });

  it("throws when root is not an object", () => {
    expect(() => parseAndValidate("not an object")).toThrow(/Expected object/);
  });

  it("throws when a required field has the wrong type", () => {
    const data = valid();
    data.generation.seed = "42";
    expect(() => parseAndValidate(data)).toThrow(/Expected number/);
  });
});