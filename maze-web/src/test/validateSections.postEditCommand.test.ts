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
    { kind: "addTeleport", id: 1, from: n(0), to: n(1), direction: "forward" },
    { kind: "setTeleportDirection", id: 1, direction: "two_way", from: n(0), to: n(1) },
    { kind: "moveTeleportEndpoint", id: 1, end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "backward" },
    { kind: "removeTeleport", id: 1, from: n(0), to: n(1), direction: "two_way" },
    { kind: "setMeta", slot: "start", endpoint: n(0) },
    { kind: "setMeta", slot: "finish", endpoint: null, previousEndpoint: n(1) },
    { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
    { kind: "setVerticalPassageDirection", id: 1, direction: "two_way", from: n(0), to: n(1), suppressPair: [n(0), n(1)] },
    {
      kind: "moveVerticalPassageEndpoint", id: 1, end: "to", endpoint: n(2), from: n(0), to: n(2), direction: "two_way",
      suppressPairs: [[n(0), n(1)], [n(2), n(0)]],
    },
    { kind: "removeVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
    { kind: "addElevator", id: 1, floors: [n(0), n(1)], suppressPairs: [[n(0), n(1)]] },
    { kind: "updateElevatorFloors", id: 1, floors: [n(0), n(1), n(2)] },
    { kind: "removeElevator", id: 1, floors: [n(0), n(1), n(2)] },
  ];

  for (const command of cases) {
    it(`round-trips ${command.kind}`, () => {
      const roundTripped = JSON.parse(JSON.stringify(command));
      expect(validatePostEditCommand(roundTripped, "commands[0]")).toEqual(command);
    });
  }
});
