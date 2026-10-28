import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { buildPresetPointEntities } from "../pixi/pointEntities";
import { usePresetStateReset } from "./presetConnectionsSliceKit";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

usePresetStateReset();

describe("preset move and settings tools (GitHub issue #748)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      presetStart: null, presetFinish: null, presetGenSource: null,
      presetTeleports: [], presetVerticalPassages: [], presetElevators: [],
      presetSplitPoints: {}, presetSplitTargetPrompt: null, presetEntityDeletePrompt: null,
      presetEntityPickPrompt: null, presetMoveRequest: null,
      presetConnectionSettingsPrompt: null, presetLockSettingsPrompt: null,
      presetElevatorPending: null, presetDragOverride: null,
    });
  });

  it("requestPresetEntityPick ignores a cell with nothing relevant to the purpose", () => {
    useMazeStore.getState().requestPresetEntityPick([1, 1], undefined, "move");
    const s = useMazeStore.getState();
    expect(s.presetEntityPickPrompt).toBeNull();
    expect(s.presetMoveRequest).toBeNull();
  });

  it("requestPresetEntityPick hands a single movable element straight to the move request", () => {
    useMazeStore.setState({ presetStart: presetEndpoint([1, 1]) });
    useMazeStore.getState().requestPresetEntityPick([1, 1], undefined, "move");
    const s = useMazeStore.getState();
    expect(s.presetEntityPickPrompt).toBeNull();
    expect(s.presetMoveRequest).toMatchObject({ kind: "start" });
    expect(useMazeStore.getState().takePresetMoveRequest()).toMatchObject({ kind: "start" });
    expect(useMazeStore.getState().presetMoveRequest).toBeNull();
  });

  it("requestPresetEntityPick opens the picker for several elements, and the pick becomes the move request", () => {
    useMazeStore.setState({ presetStart: presetEndpoint([1, 1]), presetFinish: presetEndpoint([1, 1]) });
    useMazeStore.getState().requestPresetEntityPick([1, 1], undefined, "move");
    expect(useMazeStore.getState().presetEntityPickPrompt).toEqual({ point: [1, 1], level: undefined, purpose: "move" });
    const finish = buildPresetPointEntities([1, 1], undefined, 0, { kind: "point_all" }, {
      ...useMazeStore.getState(),
    }).find((e) => e.kind === "finish")!;
    useMazeStore.getState().choosePresetEntityPick(finish);
    const s = useMazeStore.getState();
    expect(s.presetEntityPickPrompt).toBeNull();
    expect(s.presetMoveRequest).toMatchObject({ kind: "finish" });
  });

  it("the settings purpose skips elements without settings", () => {
    useMazeStore.setState({
      presetStart: presetEndpoint([1, 1]),
      presetTeleports: [{ id: 3, from: presetEndpoint([1, 1]), to: presetEndpoint([2, 2]), direction: "forward" }],
    });
    useMazeStore.getState().requestPresetEntityPick([1, 1], undefined, "settings");
    const s = useMazeStore.getState();
    expect(s.presetEntityPickPrompt).toBeNull();
    expect(s.presetConnectionSettingsPrompt).toEqual({ kind: "teleport", id: 3 });
  });

  it("settings on a lock opens the lock dialog, and setPresetLockKind changes the kind", () => {
    useMazeStore.getState().setLockedNode(1, 1, "in");
    useMazeStore.getState().requestPresetEntityPick([1, 1], undefined, "settings");
    expect(useMazeStore.getState().presetLockSettingsPrompt).toEqual({ endpoint: presetEndpoint([1, 1]) });
    useMazeStore.getState().setPresetLockKind(presetEndpoint([1, 1]), "both");
    expect(useMazeStore.getState().lockedNodes.get("1,1")).toBe("both");
  });

  it("settings on a split tile opens the split-node panel for that point", () => {
    useMazeStore.setState({ presetSplitPoints: { "1,1": [0] } });
    useMazeStore.getState().requestPresetEntityPick([1, 1], undefined, "settings");
    const s = useMazeStore.getState();
    expect(s.presetConnectionsTool).toBe("manage_split_nodes");
    expect(s.presetFocusedPoint).toEqual([1, 1]);
  });

  it("setPresetTeleportDirection and setPresetVerticalPassageDirection switch type and direction", () => {
    useMazeStore.setState({
      presetTeleports: [{ id: 3, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "two_way" }],
      presetVerticalPassages: [{ id: 4, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" }],
    });
    useMazeStore.getState().setPresetTeleportDirection(3, "backward");
    useMazeStore.getState().setPresetVerticalPassageDirection(4, "two_way");
    const s = useMazeStore.getState();
    expect(s.presetTeleports[0].direction).toBe("backward");
    expect(s.presetVerticalPassages[0].direction).toBe("two_way");
  });

  it("startPresetElevatorPlacement starts a new elevator on a point that already has one", () => {
    useMazeStore.setState({
      presetElevators: [{ id: 5, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] }],
    });
    useMazeStore.getState().startPresetElevatorPlacement(presetEndpoint([0, 0]));
    expect(useMazeStore.getState().presetElevatorPending).toEqual({ origin: presetEndpoint([0, 0]), floors: new Set([0]) });
    useMazeStore.getState().editPresetElevator(5, presetEndpoint([0, 0]));
    expect(useMazeStore.getState().presetElevatorPending).toEqual({ origin: presetEndpoint([0, 0]), floors: new Set([0, 1]), editingId: 5 });
  });

  it("movePresetMarker places the marker directly on an unsplit point and asks for the node on a split one", () => {
    useMazeStore.getState().movePresetMarker("gen_source", [2, 2]);
    expect(useMazeStore.getState().presetGenSource).toEqual(presetEndpoint([2, 2]));

    useMazeStore.setState({ presetSplitPoints: { "1,1": [0] } });
    useMazeStore.getState().movePresetMarker("start", [1, 1]);
    expect(useMazeStore.getState().presetSplitTargetPrompt).toMatchObject({ point: [1, 1], slotIds: [0], action: { tool: "set_start" } });
    useMazeStore.getState().applyPresetSplitTargetPick(0);
    expect(useMazeStore.getState().presetStart).toEqual(presetEndpoint([1, 1], 0));
  });

  it("movePresetTeleportEndpointTo keeps the endpoint's floor and asks for the node on a split point", () => {
    useMazeStore.setState({
      presetTeleports: [{ id: 3, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "forward" }],
      presetSplitPoints: { "1,1": [0] },
    });
    useMazeStore.getState().movePresetTeleportEndpointTo(3, "to", [2, 1]);
    expect(useMazeStore.getState().presetTeleports[0].to).toEqual(presetEndpoint([2, 1]));
    useMazeStore.getState().movePresetTeleportEndpointTo(3, "to", [1, 1]);
    expect(useMazeStore.getState().presetSplitTargetPrompt?.action).toEqual({ tool: "move_teleport_endpoint", id: 3, end: "to" });
    useMazeStore.getState().applyPresetSplitTargetPick(0);
    expect(useMazeStore.getState().presetTeleports[0].to).toEqual(presetEndpoint([1, 1], 0));
  });

  it("movePresetLockTo keeps the kind, replaces a lock on the target, and asks for the node on a split point (GitHub issue #748)", () => {
    useMazeStore.setState({
      lockedNodes: new Map([["0,0", "in"], ["2,0", "out"]]),
      presetEntityOrder: ["lock:0,0", "lock:2,0"],
      presetSplitPoints: { "1,1": [0] },
    });
    useMazeStore.getState().movePresetLockTo(presetEndpoint([0, 0]), [2, 0]);
    expect(useMazeStore.getState().lockedNodes).toEqual(new Map([["2,0", "in"]]));
    expect(useMazeStore.getState().presetEntityOrder).toEqual(["lock:2,0"]);

    useMazeStore.getState().movePresetLockTo(presetEndpoint([2, 0]), [1, 1]);
    expect(useMazeStore.getState().presetSplitTargetPrompt?.action).toEqual({ tool: "move_lock", from: presetEndpoint([2, 0]) });
    useMazeStore.getState().applyPresetSplitTargetPick(0);
    expect(useMazeStore.getState().lockedNodes).toEqual(new Map([["1,1:0", "in"]]));
  });

  it("movePresetTeleportEndpointTo onto the other endpoint's split tile skips that endpoint's node (GitHub issue #748)", () => {
    useMazeStore.setState({
      presetTeleports: [{ id: 3, from: presetEndpoint([1, 1], 0), to: presetEndpoint([2, 2]), direction: "forward" }],
      presetSplitPoints: { "1,1": [0] },
    });
    // Two nodes, one taken by `from`: the original node is used without a prompt.
    useMazeStore.getState().movePresetTeleportEndpointTo(3, "to", [1, 1]);
    expect(useMazeStore.getState().presetSplitTargetPrompt).toBeNull();
    expect(useMazeStore.getState().presetTeleports[0].to).toEqual(presetEndpoint([1, 1]));

    // Three nodes: the prompt leaves out the other endpoint's node.
    useMazeStore.setState({
      presetTeleports: [{ id: 3, from: presetEndpoint([1, 1], 0), to: presetEndpoint([2, 2]), direction: "forward" }],
      presetSplitPoints: { "1,1": [0, 1] },
    });
    useMazeStore.getState().movePresetTeleportEndpointTo(3, "to", [1, 1]);
    expect(useMazeStore.getState().presetSplitTargetPrompt?.excluded).toEqual({ slotId: 0 });
    useMazeStore.getState().applyPresetSplitTargetPick(1);
    expect(useMazeStore.getState().presetTeleports[0].to).toEqual(presetEndpoint([1, 1], 1));
  });
});
