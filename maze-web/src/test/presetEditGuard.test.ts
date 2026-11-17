import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { GUARDED_PRESET_ACTIONS } from "../store/presetEditGuard";
import { hasGeneration } from "../store/storeHelpers";
import type { NodeDto } from "../wasm/types";

beforeEach(() => {
  useMazeStore.setState({
    presetStart: null,
    presetEntityOrder: [],
    presetEditConfirmation: null,
    mazeDirty: false,
    postEditDirty: false,
    nodes: [],
  });
});

function markGenerated() {
  useMazeStore.setState({ mazeDirty: true, nodes: [{ id: 1 } as unknown as NodeDto] });
}

describe("preset edit guard", () => {
  it("applies the edit immediately when nothing was generated", () => {
    useMazeStore.getState().setPresetStartEndpoint(presetEndpoint([1, 1], undefined, undefined));
    const s = useMazeStore.getState();
    expect(s.presetStart).not.toBeNull();
    expect(s.presetEditConfirmation).toBeNull();
  });

  it("parks the edit and keeps the generation until confirmed", () => {
    markGenerated();
    useMazeStore.getState().setPresetStartEndpoint(presetEndpoint([1, 1], undefined, undefined));
    const s = useMazeStore.getState();
    expect(s.presetEditConfirmation).not.toBeNull();
    expect(s.presetStart).toBeNull();
    expect(s.nodes).toHaveLength(1);
  });

  it("cancel drops the parked edit and keeps the generation", () => {
    markGenerated();
    useMazeStore.getState().setPresetStartEndpoint(presetEndpoint([1, 1], undefined, undefined));
    useMazeStore.getState().cancelPresetEdit();
    const s = useMazeStore.getState();
    expect(s.presetEditConfirmation).toBeNull();
    expect(s.presetStart).toBeNull();
    expect(s.nodes).toHaveLength(1);
  });

  it("confirm resets generation and post-edit, then applies the edit without re-prompting", () => {
    markGenerated();
    useMazeStore.setState({ postEditDirty: true });
    useMazeStore.getState().setPresetStartEndpoint(presetEndpoint([1, 1], undefined, undefined));
    useMazeStore.getState().confirmPresetEdit();
    const s = useMazeStore.getState();
    expect(s.presetEditConfirmation).toBeNull();
    expect(s.presetStart).not.toBeNull();
    expect(s.nodes).toHaveLength(0);
    expect(s.mazeDirty).toBe(false);
    expect(s.postEditDirty).toBe(false);
  });

  it("ignores further edits while a confirmation is open", () => {
    markGenerated();
    useMazeStore.getState().setPresetStartEndpoint(presetEndpoint([1, 1], undefined, undefined));
    useMazeStore.getState().setPresetFinishEndpoint(presetEndpoint([2, 2], undefined, undefined));
    useMazeStore.getState().confirmPresetEdit();
    const s = useMazeStore.getState();
    expect(s.presetStart).not.toBeNull();
    expect(s.presetFinish).toBeNull();
  });

  it("parks on post-edit state alone", () => {
    useMazeStore.setState({ postEditDirty: true });
    useMazeStore.getState().setPresetStartEndpoint(presetEndpoint([1, 1], undefined, undefined));
    expect(useMazeStore.getState().presetEditConfirmation).not.toBeNull();
  });

  it("replays the parked call with its original arguments", () => {
    markGenerated();
    useMazeStore.getState().setLockedNode(2, 3, "in");
    useMazeStore.getState().confirmPresetEdit();
    expect(useMazeStore.getState().lockedNodes.get("2,3")).toBe("in");
  });

  it("guards entity delete only in its bulk form", () => {
    markGenerated();
    useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" });
    expect(useMazeStore.getState().presetEditConfirmation).toBeNull();
    useMazeStore.getState().requestPresetEntityDelete([0, 0], undefined, { kind: "point_all" }, true);
    expect(useMazeStore.getState().presetEditConfirmation).not.toBeNull();
  });

  it("every guarded name is a store action", () => {
    const store = useMazeStore.getState() as unknown as Record<string, unknown>;
    for (const { name } of GUARDED_PRESET_ACTIONS) expect(typeof store[name], name).toBe("function");
  });

  it("leaves generation settings outside the guard", () => {
    markGenerated();
    useMazeStore.getState().setGenerationSourceMode("default");
    const s = useMazeStore.getState();
    expect(s.presetEditConfirmation).toBeNull();
    expect(s.generationSourceMode).toBe("default");
  });

  it("does not guard non-data actions", () => {
    markGenerated();
    useMazeStore.getState().setPresetConnectionsTool("passage");
    expect(useMazeStore.getState().presetEditConfirmation).toBeNull();
  });
});

describe("hasGeneration", () => {
  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])("mazeDirty=%s postEditDirty=%s -> %s", (mazeDirty, postEditDirty, expected) => {
    expect(hasGeneration({ mazeDirty, postEditDirty })).toBe(expected);
  });
});
