import { describe, expect, it } from "vitest";
import type { NodeDto } from "../wasm/types";
import type { PostEditElevatorEntry, PostEditTeleportEntry, PostEditVerticalPassageEntry } from "../store/postEditTypes";
import { pickPostEditTeleportEndpointAt } from "../pixi/postEditTeleportUtils";
import { pickPostEditElevatorEndpointAt, pickPostEditVerticalPassageEndpointAt } from "../pixi/postEditVerticalUtils";

const cfg = { type: "square", width: 4, height: 4 } as const;
const node = (id: number, x: number, y: number, level = 0): NodeDto => ({ id, x, y, i: 0, level });
const nodeEndpoint = (id: number) => ({ kind: "node" as const, id });
const resolveSplit = () => undefined;
const resolveLevel = (id: number) => id === 1 ? 0 : 1;

describe("post-edit endpoint hit-testing", () => {
  it("picks a teleport endpoint from anywhere in its cell", () => {
    const nodes = new Map([[1, node(1, 1, 2)], [2, node(2, 3, 2)]]);
    const teleports: PostEditTeleportEntry[] = [{ id: "t1", from: nodeEndpoint(1), to: nodeEndpoint(2), direction: "two_way" }];

    expect(pickPostEditTeleportEndpointAt(70, -90, cfg, teleports, nodes, resolveSplit)).toEqual({ id: "t1", end: "from" });
  });

  it("picks vertical-passage and elevator endpoints from anywhere in their cells", () => {
    const nodes = new Map([[1, node(1, 1, 2, 0)], [2, node(2, 1, 2, 1)]]);
    const passages: PostEditVerticalPassageEntry[] = [{ id: "v1", from: nodeEndpoint(1), to: nodeEndpoint(2), direction: "two_way" }];
    const elevators: PostEditElevatorEntry[] = [{ id: "e1", floors: [nodeEndpoint(1), nodeEndpoint(2)] }];

    expect(pickPostEditVerticalPassageEndpointAt(70, -90, cfg, passages, nodes, resolveLevel, 0)).toEqual({ id: "v1", end: "from" });
    expect(pickPostEditElevatorEndpointAt(70, -90, cfg, elevators, nodes, resolveLevel, 0)).toEqual({ id: "e1", level: 0 });
  });
});
