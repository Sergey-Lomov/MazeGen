import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, resetGenerationMocks } from "./storeTestHelpers";

vi.mock("../wasm/mazeService", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/mazeService")>()),
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getAvailableRuleParams: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { generateMaze, computeAnalytics } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import { serializeProject } from "../store/projectExport";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  resetGenerationMocks(vi.mocked(generateMaze), vi.mocked(computeAnalytics), vi.mocked(initWasm));
});

describe("mazeStore.loadProject zones (GitHub issue #1048)", () => {
  const savedZones = {
    zones: [{ id: 3, name: "A", kind: "manual" as const, cells: [[0, 1, 1]] as [number, number, number][] }],
    nextZoneId: 8,
    groups: [{ id: 2, name: "G", zoneIds: [3] }, { id: 5, name: "", zoneIds: [] }],
    nextGroupId: 9,
    colorOverrides: { "3": 0x123456 },
  };

  it("restores zones, groups, counters and colours with numeric override keys", async () => {
    useMazeStore.setState({ mazeDirty: false, postEditDirty: false });
    const file = serializeProject(useMazeStore.getState());
    file.zones = savedZones;
    await useMazeStore.getState().loadProject(file);
    const s = useMazeStore.getState();
    expect(s.zones).toEqual(savedZones.zones);
    expect(s.zoneGroups).toEqual(savedZones.groups);
    expect([s.nextZoneId, s.nextZoneGroupId]).toEqual([8, 9]);
    expect(s.zoneColorOverrides).toEqual({ 3: 0x123456 });
  });

  it("replaces the previous session's zones and ends open zone editing; a file without zones leaves none", async () => {
    useMazeStore.setState({
      mazeDirty: false, postEditDirty: false,
      zones: savedZones.zones, zoneGroups: savedZones.groups, nextZoneId: 8, zoneColorOverrides: { 3: 1 },
      zoneEditDraft: savedZones.zones[0], zoneGroupsPanelOpen: true, hiddenZoneIds: [3],
    });
    const file = serializeProject(useMazeStore.getState());
    delete file.zones;
    await useMazeStore.getState().loadProject(file);
    const s = useMazeStore.getState();
    expect(s.zones).toEqual([]);
    expect(s.zoneGroups).toEqual([]);
    expect(s.nextZoneId).toBe(1);
    expect(s.zoneColorOverrides).toEqual({});
    expect(s.zoneEditDraft).toBeNull();
    expect(s.zoneGroupsPanelOpen).toBe(false);
    expect(s.hiddenZoneIds).toEqual([]);
  });
});
