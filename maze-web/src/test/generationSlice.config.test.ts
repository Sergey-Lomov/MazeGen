import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { buildExactGenerateCallPayload } from "../store/slices/generationSlice";
import { serializeProject } from "../store/projectExport";
import { DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";
import { baseStoreState, mockSnapshot, mockGenerateMazeResult, resetGenerationMocks, encodeEdgeAddedTape, TEST_FLOOR_ID, baseFloorFieldConfig } from "./storeTestHelpers";
import { parseTape } from "../debug/eventTape";
import type { DebugArenaHandle } from "../store/storeTypes";

function emptyDebugArena(): DebugArenaHandle {
  return {
    tape: parseTape(new Uint8Array(0), new Uint8Array(0)), algorithmKind: "recursive_backtracker",
    sources: [{ scopeName: "generation", kind: "recursive_backtracker", nodeIndex: 0, startStep: 0, endStep: 0, checkpointFroms: [] }],
    nodes: [], allNodes: [], totalSteps: 0, debugValueNames: [],
  };
}

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getCartesianCoords: vi.fn((cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y])),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

describe("buildGenerateConfig — preset_start/preset_finish", () => {
  it("includes preset_start and preset_finish when set inside the field", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }) },
      presetStart: presetEndpoint([0, 0]),
      presetFinish: presetEndpoint([1, 1]),
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toEqual({ point: [0, 0] });
    expect(call[1].preset_finish).toEqual({ point: [1, 1] });
  });

  it("omits preset_start and preset_finish when unset", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }) },
      presetStart: null,
      presetFinish: null,
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toBeUndefined();
    expect(call[1].preset_finish).toBeUndefined();
  });

  it("omits preset_start and preset_finish when they fall outside the field", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } }) },
      presetStart: presetEndpoint([5, 5]),
      presetFinish: presetEndpoint([9, 9]),
    });
    useMazeStore.getState().generate();
    const call = vi.mocked(generateMaze).mock.calls[0];
    expect(call[1].preset_start).toBeUndefined();
    expect(call[1].preset_finish).toBeUndefined();
  });
});

describe("buildGenerateConfig — preset_gen_source", () => {
  it("omits preset_gen_source when it falls outside the field", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 1, height: 1 } }) },
      presetGenSource: presetEndpoint([5, 5]),
    });
    useMazeStore.getState().generate();
    expect(vi.mocked(generateMaze).mock.calls[0][1].preset_gen_source).toBeUndefined();
  });
});

describe("mazeStore generation misc actions", () => {

  it("setRandomSeed toggles flag", () => {
    useMazeStore.getState().setRandomSeed(true);
    expect(useMazeStore.getState().randomSeed).toBe(true);
  });

  it("setOpenCard switches card and clears preset highlights when leaving preset_connections", () => {
    useMazeStore.setState({ openCard: "preset_connections", highlightInvalidPresets: true, highlightIsolatedNodes: true, highlightOrphanSplitNodes: true });
    useMazeStore.getState().setOpenCard("generation");
    const s = useMazeStore.getState();
    expect(s.openCard).toBe("generation");
    expect(s.highlightInvalidPresets).toBe(false);
    expect(s.highlightIsolatedNodes).toBe(false);
    expect(s.highlightOrphanSplitNodes).toBe(false);
  });

  it("setOpenCard keeps highlights when not leaving preset_connections", () => {
    useMazeStore.setState({ openCard: "generation", highlightInvalidPresets: true });
    useMazeStore.getState().setOpenCard("quality");
    expect(useMazeStore.getState().highlightInvalidPresets).toBe(true);
  });

  it("setDebugMode(false) clears debugStale", () => {
    useMazeStore.setState({ debugMode: true, debugStale: true });
    useMazeStore.getState().setDebugMode(false);
    const s = useMazeStore.getState();
    expect(s.debugMode).toBe(false);
    expect(s.debugStale).toBe(false);
  });

  it("setDebugMode(true) does not touch debugStale", () => {
    useMazeStore.setState({ debugMode: false, debugStale: true });
    useMazeStore.getState().setDebugMode(true);
    expect(useMazeStore.getState().debugStale).toBe(true);
  });

  it("setDebugMode(false) clears the debug search query and pending focus target (GitHub issue #482)", () => {
    useMazeStore.setState({ debugMode: true, debugSearchQuery: "passage", debugFocusNodeIndex: 7 });
    useMazeStore.getState().setDebugMode(false);
    const s = useMazeStore.getState();
    expect(s.debugSearchQuery).toBe("");
    expect(s.debugFocusNodeIndex).toBeNull();
  });

  it("setDebugSearchQuery stores the raw query verbatim (GitHub issue #482)", () => {
    useMazeStore.getState().setDebugSearchQuery("  Edge Added  ");
    expect(useMazeStore.getState().debugSearchQuery).toBe("  Edge Added  ");
  });

  it("focusDebugStep bumps the focus token and clears the node target (GitHub issue #482)", () => {
    useMazeStore.setState({ debugFocusToken: 4, debugFocusNodeIndex: 7 });
    useMazeStore.getState().focusDebugStep();
    const s = useMazeStore.getState();
    expect(s.debugFocusToken).toBe(5);
    expect(s.debugFocusNodeIndex).toBeNull();
  });

  it("focusDebugNode bumps the focus token and sets the node target (GitHub issue #482)", () => {
    useMazeStore.setState({ debugFocusToken: 4, debugFocusNodeIndex: null });
    useMazeStore.getState().focusDebugNode(11);
    const s = useMazeStore.getState();
    expect(s.debugFocusToken).toBe(5);
    expect(s.debugFocusNodeIndex).toBe(11);
  });

  it("setDebugStep / setDebugAutoPlayDelay update their fields", () => {
    useMazeStore.getState().setDebugStep(3);
    useMazeStore.getState().setDebugAutoPlayDelay(500);
    const s = useMazeStore.getState();
    expect(s.debugStep).toBe(3);
    expect(s.debugAutoPlayDelay).toBe(500);
  });

  it("setDebugStep(step, false) skips the floor auto-switch, but a later plain setDebugStep(step) applies it (GitHub issue #350 flicker fix)", () => {
    const debugTape = encodeEdgeAddedTape([[0n, 1n]]); // matches mockSnapshot.nodes' ids (0, 1)
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({
      seed: 7, randomSeed: false, rules: [], debugMode: true,
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      floorFields: { floor_0: baseFloorFieldConfig(), floor_1: baseFloorFieldConfig() },
      activeFloorId: "floor_0",
    });
    useMazeStore.getState().generate();
    // Both edge endpoints on floor 1 (index 1) — nodes come from `mockSnapshot`, which carries no
    // `level`, so patched in directly (mirrors `debugSelectors.test.ts`'s own fixture pattern).
    useMazeStore.setState((s) => ({
      debugArena: s.debugArena && {
        ...s.debugArena,
        nodes: s.debugArena.nodes.map((n) => ({ ...n, level: 1 })),
      },
    }));

    useMazeStore.getState().setDebugStep(0, false);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");

    useMazeStore.getState().setDebugStep(0);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("setDebugStep respects debugAutoSwitchFloor — off disables every trigger, not just the scrubber drag", () => {
    const debugTape = encodeEdgeAddedTape([[0n, 1n]]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({
      seed: 7, randomSeed: false, rules: [], debugMode: true,
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      floorFields: { floor_0: baseFloorFieldConfig(), floor_1: baseFloorFieldConfig() },
      activeFloorId: "floor_0",
      debugAutoSwitchFloor: false,
    });
    useMazeStore.getState().generate();
    useMazeStore.setState((s) => ({
      debugArena: s.debugArena && {
        ...s.debugArena,
        nodes: s.debugArena.nodes.map((n) => ({ ...n, level: 1 })),
      },
    }));

    // A plain (non-scrubber) setDebugStep call, `switchFloor` left at its default `true` — still
    // no switch, since the user-facing toggle overrides it.
    useMazeStore.getState().setDebugStep(0);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_0");

    useMazeStore.getState().toggleDebugAutoSwitchFloor();
    useMazeStore.getState().setDebugStep(0);
    expect(useMazeStore.getState().activeFloorId).toBe("floor_1");
  });

  it("generate() with debugMode on and a debug tape builds a debugArena and sets debugStep to the last step", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n], [3n, 4n]]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.objectContaining({ debug_events: true }));
    const s = useMazeStore.getState();
    expect(s.debugArena).not.toBeNull();
    expect(s.debugArena?.totalSteps).toBe(3);
    expect(s.debugStep).toBe(2);
  });

  it("generate() clears a stale debug search query and pending focus target (GitHub issue #482)", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n]]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true, debugSearchQuery: "passage", debugFocusNodeIndex: 5 });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugSearchQuery).toBe("");
    expect(s.debugFocusNodeIndex).toBeNull();
  });

  it("generate() with debugMode on and a long-enough tape resolves a web-computed snapshot into debugArena.checkpointFroms (GitHub issue #128)", () => {
    // Snapshots are now computed entirely on the web side (`resolveDebugArenaMetadata`) every
    // CHECKPOINT_INTERVAL (500) mutating events — a 1000-edge chain crosses that threshold once.
    const edges: [bigint, bigint][] = Array.from({ length: 1000 }, (_, i) => [BigInt(i + 1), BigInt(i + 2)]);
    const debugTape = encodeEdgeAddedTape(edges);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugArena?.sources[0].checkpointFroms.map((f) => f.step)).toEqual([499, 999]);
  });

  it("generate() with debugMode on but a tape with zero mutating events still builds a (zero-step) debugArena (GitHub issue #173)", () => {
    // A source scope always exists even with zero mutating events (the tape's own root scope
    // node) — the debug panel should render a single static frame rather than not appear at all.
    const debugTape = encodeEdgeAddedTape([]);
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugArena).not.toBeNull();
    expect(s.debugArena?.totalSteps).toBe(0);
    expect(s.debugStep).toBe(0);
  });

  it("generate() with debugMode on but no debug tape (algorithm not instrumented) leaves debugArena null", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    useMazeStore.getState().generate();
    const s = useMazeStore.getState();
    expect(s.debugArena).toBeNull();
    expect(s.debugStep).toBe(0);
  });

  it("generate() with debugMode off does not set debug_events on the config, even with a tape available", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: false });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.not.objectContaining({ debug_events: true }));
    expect(useMazeStore.getState().debugArena).toBeNull();
  });

  it("loadProject clamps the restored debugStep to the freshly regenerated arena's last step", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n]]); // totalSteps = 2, lastStep = 1
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    const file = serializeProject(useMazeStore.getState());
    file.debug = { ...file.debug, debugMode: true, debugStep: 99 }; // saved step beyond this run's range
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().debugStep).toBe(1);
  });

  it("loadProject restores the saved debugStep as-is when it's within the regenerated arena's range", () => {
    const debugTape = encodeEdgeAddedTape([[1n, 2n], [2n, 3n], [3n, 4n]]); // totalSteps = 3, lastStep = 2
    vi.mocked(generateMaze).mockReturnValue({ snapshot: mockSnapshot, debugTape });
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], debugMode: true });
    const file = serializeProject(useMazeStore.getState());
    file.debug = { ...file.debug, debugMode: true, debugStep: 1 };
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().debugStep).toBe(1);
  });

  it("loadProject restores vectorByCorridorsSettings/vectorByCorridorsSectionsExpanded from the saved file", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    const file = serializeProject(useMazeStore.getState());
    file.imageExport = {
      ...file.imageExport,
      vectorByCorridorsSettings: { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, color: 0x123456, thickness: 12, join: "miter" },
      vectorByCorridorsSectionsExpanded: { cells: true },
    };
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().vectorByCorridorsSettings).toEqual({
      ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      color: 0x123456,
      thickness: 12,
      join: "miter",
    });
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded).toEqual({ cells: true });
  });

  it("loadProject restores the saved activeFloorId (GitHub issue #354)", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    useMazeStore.getState().addFloor();
    const secondFloorId = useMazeStore.getState().floors[1].id;
    useMazeStore.getState().setActiveFloorId(secondFloorId);
    const file = serializeProject(useMazeStore.getState());
    expect(file.floors.activeFloorId).toBe(secondFloorId);

    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().activeFloorId).toBe(secondFloorId);
  });

  it("loadProject normalizes a stale/too-low saved id counter up to the replayed log's own high-water mark (GitHub issue #564 second follow-up)", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    useMazeStore.getState().generate();
    useMazeStore.getState().addPostEditTeleport(
      { kind: "node", id: 0 }, { kind: "node", id: 1 }, "forward",
    );
    const mintedId = useMazeStore.getState().postEditDraftTeleports[0].id;
    expect(mintedId).toBe("t1");

    const file = serializeProject(useMazeStore.getState());
    expect(file.postEdit).not.toBeNull();
    // Corrupt the saved counter to a value lower than what the command log actually already used —
    // simulates a hand-edited or stale file (the file's own counter is not the log's source of
    // truth, the log's own minted ids are).
    file.postEdit = { ...file.postEdit!, nextTeleportId: 1 };

    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.getState().loadProject(file);
    expect(useMazeStore.getState().postEditDraftTeleports.map((t) => t.id)).toEqual(["t1"]);
    // Normalized past the log's own high-water mark (id 1 already minted), not left at the file's
    // stale value of 1 — the next teleport must not collide with the one the log already created.
    expect(useMazeStore.getState()._nextPostEditTeleportId).toBe(2);
  });

  it("setError sets and clears the error message", () => {
    useMazeStore.getState().setError("boom");
    expect(useMazeStore.getState().error).toBe("boom");
    useMazeStore.getState().setError(null);
    expect(useMazeStore.getState().error).toBeNull();
  });
});

describe("mazeStore.qcExperiment toggle", () => {
  it("generate() calls generateMaze with qc_experiment true and locked_nodes cleared when qcExperiment is on", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({
      seed: 7,
      randomSeed: false,
      rules: [],
      qcExperiment: true,
      lockedNodes: new Map([["0,0", "both"]]),
    });
    useMazeStore.getState().generate();
    expect(generateMaze).toHaveBeenCalledWith(7, expect.objectContaining({
      qc_experiment: true,
      locked_nodes: [],
      split_points: [],
      split_generation: { pattern_mode: false, max_split_nodes: 2, patterns: [] },
    }));
  });

  it("setQcExperiment persists the toggle across generate() calls", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [] });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().qcExperiment).toBe(true);
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().qcExperiment).toBe(true);
  });

  it("generate() records lastUsedQcExperiment from the toggle at call time", () => {
    vi.mocked(generateMaze).mockReturnValue(mockGenerateMazeResult);
    useMazeStore.setState({ seed: 7, randomSeed: false, rules: [], qcExperiment: true });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().lastUsedQcExperiment).toBe(true);

    useMazeStore.setState({ qcExperiment: false });
    useMazeStore.getState().generate();
    expect(useMazeStore.getState().lastUsedQcExperiment).toBe(false);
  });

  it("setQcExperiment marks debugStale when a debug arena exists", () => {
    useMazeStore.setState({ debugArena: emptyDebugArena() });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().debugStale).toBe(true);
  });

  it("setQcExperiment does not mark debugStale when there is no debug arena", () => {
    useMazeStore.setState({ debugArena: null, debugStale: false });
    useMazeStore.getState().setQcExperiment(true);
    expect(useMazeStore.getState().debugStale).toBe(false);
  });
});

describe("buildExactGenerateCallPayload", () => {
  it("includes qc_experiment/locked_nodes overrides when lastUsedQcExperiment is true", () => {
    useMazeStore.setState({
      seed: 7,
      lastUsedSeed: 7,
      lastUsedQcExperiment: true,
      rules: [],
      lockedNodes: new Map([["0,0", "both"]]),
    });
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    expect(payload?.config.qc_experiment).toBe(true);
    expect(payload?.config.locked_nodes).toEqual([]);
  });

  it("omits qc_experiment override when lastUsedQcExperiment is false", () => {
    useMazeStore.setState({
      seed: 7,
      lastUsedSeed: 7,
      lastUsedQcExperiment: false,
      rules: [],
    });
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    expect(payload?.config.qc_experiment).toBeUndefined();
  });

  it("ignores a live qcExperiment toggle flipped after the last actual run", () => {
    useMazeStore.setState({
      seed: 7,
      lastUsedSeed: 7,
      lastUsedQcExperiment: false,
      qcExperiment: true,
      rules: [],
    });
    const payload = buildExactGenerateCallPayload(useMazeStore.getState);
    expect(payload?.config.qc_experiment).toBeUndefined();
  });
});
