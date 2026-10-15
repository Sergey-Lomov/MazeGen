import { describe, it, expect } from "vitest";
import { presetEntitiesForPurpose, postEditEntitiesForPurpose } from "../pixi/entityToolKinds";
import type { PresetPointEntityDescriptor, PresetPointEntityKind } from "../pixi/pointEntities";
import type { PostEditPointEntityDescriptor, PostEditPointEntityKind } from "../pixi/postEditPointEntities";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { nodeEndpoint } from "../pixi/postEditEndpoint";

const preset = (kind: PresetPointEntityKind): PresetPointEntityDescriptor =>
  ({ kind, id: kind, endpoint: presetEndpoint([0, 0]), nodeIndex: 0, title: kind });
const postEdit = (kind: PostEditPointEntityKind): PostEditPointEntityDescriptor =>
  ({ kind, id: kind, endpoint: nodeEndpoint(0), title: kind, entityId: undefined, bubbles: [], showArrow: false, arrow: "->" });

describe("entity tool purposes (GitHub issue #748)", () => {
  const presetKinds: PresetPointEntityKind[] = ["start", "finish", "gen_source", "edge", "teleport", "vertical_passage", "elevator", "lock", "split_node"];
  const postEditKinds: PostEditPointEntityKind[] = ["start", "finish", "teleport", "vertical_passage", "elevator", "split_point"];

  it("the move tool moves point markers, connection endpoints and locks, never edges or split tiles", () => {
    expect(presetEntitiesForPurpose("move", presetKinds.map(preset)).map((e) => e.kind))
      .toEqual(["start", "finish", "gen_source", "teleport", "vertical_passage", "elevator", "lock"]);
    expect(postEditEntitiesForPurpose("move", postEditKinds.map(postEdit)).map((e) => e.kind))
      .toEqual(["start", "finish", "teleport", "vertical_passage", "elevator"]);
  });

  it("the settings tool configures connections, elevators, locks and split tiles, never plain markers", () => {
    expect(presetEntitiesForPurpose("settings", presetKinds.map(preset)).map((e) => e.kind))
      .toEqual(["teleport", "vertical_passage", "elevator", "lock", "split_node"]);
    expect(postEditEntitiesForPurpose("settings", postEditKinds.map(postEdit)).map((e) => e.kind))
      .toEqual(["teleport", "vertical_passage", "elevator", "split_point"]);
  });
});
