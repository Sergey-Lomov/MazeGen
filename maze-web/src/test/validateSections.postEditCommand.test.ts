import { describe, it, expect } from "vitest";
import { validatePostEditCommand } from "../store/projectExport/validateSections";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { nodeEndpoint } from "../pixi/postEditEndpoint";

const n = nodeEndpoint;

/** Round-trips every teleport/vertical-passage/elevator/setMeta `PostEditCommand` kind through
 *  `validatePostEditCommand(JSON.parse(JSON.stringify(command)))` — a project export/import cycle
 *  — asserting the result equals the original. Added after `moveVerticalPassageEndpoint`'s own
 *  `suppressPairs` field was found silently dropped by the validator (never read into the returned
 *  object at all), which this round-trip style would have caught immediately. */
describe("validatePostEditCommand — post-edit command round-trip (GitHub issue #564 follow-up)", () => {
  const cases: PostEditCommand[] = [
    { kind: "setEdge", edge: { kind: "one_way_forward", from: n(0), to: n(1) } },
    { kind: "setEdgePair", a: n(0), b: n(1), aToB: { kind: "one_way_forward", from: n(0), to: n(1) }, bToA: { kind: "wall", from: n(1), to: n(0) } },
    { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
    { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
    { kind: "setTeleportDirection", id: "t1", direction: "two_way", from: n(0), to: n(1) },
    { kind: "setTeleportDirection", id: "t1", direction: "forward", from: n(0), to: n(1), absolute: true },
    { kind: "moveTeleportEndpoint", id: "t1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "backward" },
    { kind: "removeTeleport", id: "t1", from: n(0), to: n(1), direction: "two_way" },
    { kind: "setMeta", slot: "start", endpoint: n(0) },
    { kind: "setMeta", slot: "finish", endpoint: null, previousEndpoint: n(1) },
    { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
    { kind: "setVerticalPassageDirection", id: "v1", direction: "two_way", from: n(0), to: n(1) },
    { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: n(0), to: n(1), absolute: true },
    {
      kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "two_way",
    },
    { kind: "removeVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
    { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
    { kind: "updateElevatorFloors", id: "e1", floors: [n(0), n(1), n(2)] },
    { kind: "removeElevator", id: "e1", floors: [n(0), n(1), n(2)] },
  ];

  for (const command of cases) {
    it(`round-trips ${command.kind}`, () => {
      const roundTripped = JSON.parse(JSON.stringify(command));
      expect(validatePostEditCommand(roundTripped, "commands[0]")).toEqual(command);
    });
  }
});
