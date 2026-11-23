import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { zonesInitialState } from "../store/slices/zonesSlice";
import { autoZoneIdOf } from "../domain/autoZones";
import { AUTO_ZONES_DEBOUNCE_MS, refreshAutoZones } from "../store/autoZoneSync";
import { computeAutoZones, getTessellationCellTypes } from "../wasm/mazeService";

vi.mock("../store/autoZoneSync", (importOriginal) => importOriginal());
vi.mock("../wasm/mazeService", async (importOriginal) => ({ ...(await importOriginal<object>()), computeAutoZones: vi.fn(), getTessellationCellTypes: vi.fn() }));
vi.mock("../store/autoZones", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAutoZonesRequest: () => ({ tessellation: {}, floors: [] }),
}));

const mazeId = autoZoneIdOf("maze")!;
const edgeId = autoZoneIdOf("edge:0")!;

describe("refreshAutoZones", () => {
  beforeEach(() => {
    useMazeStore.setState({ ...zonesInitialState, zones: [] });
    vi.mocked(computeAutoZones).mockReset();
  });

  it("starts every new auto zone hidden, once", () => {
    vi.mocked(computeAutoZones).mockReturnValue([{ key: "maze", cells: [[0, 0, 0]] }]);
    refreshAutoZones(useMazeStore);
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([mazeId]);

    // The user shows it: a recomputation that keeps the zone does not hide it again.
    useMazeStore.getState().toggleZoneVisibility(mazeId);
    vi.mocked(computeAutoZones).mockReturnValue([{ key: "maze", cells: [[0, 0, 0], [0, 1, 0]] }]);
    refreshAutoZones(useMazeStore);
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([]);
  });

  it("names a cell type zone by the tessellation's type keys, asked only when such a zone exists", () => {
    vi.mocked(getTessellationCellTypes).mockReset().mockReturnValue({ keys: ["octagon", "square"], point_types: [], cells_vary_in_size: false });
    vi.mocked(computeAutoZones).mockReturnValue([{ key: "maze", cells: [[0, 0, 0]] }]);
    refreshAutoZones(useMazeStore);
    expect(getTessellationCellTypes).not.toHaveBeenCalled();

    vi.mocked(computeAutoZones).mockReturnValue([{ key: "maze", cells: [[0, 0, 0]] }, { key: "type:0:1", cells: [[0, 1, 1]] }]);
    refreshAutoZones(useMazeStore);
    expect(useMazeStore.getState().zones.find((zone) => zone.id === autoZoneIdOf("type:0:1"))?.name).toBe("square");
  });

  it("hides a zone that appears later and forgets a zone that vanished", () => {
    vi.mocked(computeAutoZones).mockReturnValue([{ key: "maze", cells: [[0, 0, 0]] }, { key: "edge:0", cells: [[0, 0, 0]] }]);
    refreshAutoZones(useMazeStore);
    expect(useMazeStore.getState().hiddenZoneIds.sort()).toEqual([mazeId, edgeId].sort());
    vi.mocked(computeAutoZones).mockReturnValue([{ key: "maze", cells: [[0, 0, 0]] }]);
    refreshAutoZones(useMazeStore);
    expect(useMazeStore.getState().hiddenZoneIds).toEqual([mazeId]);
  });
});

describe("the installed auto zone sync", () => {
  it("recomputes when the field changes, not when only the tool state of a floor changes", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(computeAutoZones).mockReset().mockReturnValue([]);
      // `mazeStore` installs the sync itself, so only the calls made from here on are counted.
      const calls = () => vi.mocked(computeAutoZones).mock.calls.length;
      const afterStart = calls();

      const state = useMazeStore.getState();
      const id = state.activeFloorId;
      useMazeStore.setState({ floorFields: { ...state.floorFields, [id]: { ...state.floorFields[id], fieldPrimitive: "circle", fieldDirty: true } } });
      vi.advanceTimersByTime(AUTO_ZONES_DEBOUNCE_MS);
      expect(calls()).toBe(afterStart);

      const next = useMazeStore.getState();
      useMazeStore.setState({ floorFields: { ...next.floorFields, [id]: { ...next.floorFields[id], fieldPoints: new Set([1]) } } });
      vi.advanceTimersByTime(AUTO_ZONES_DEBOUNCE_MS);
      expect(calls()).toBe(afterStart + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes at once on the first change of a burst and once more when the burst ends", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(computeAutoZones).mockReset().mockReturnValue([]);
      const calls = () => vi.mocked(computeAutoZones).mock.calls.length;
      const afterStart = calls();
      const addPoint = (point: number) => {
        const s = useMazeStore.getState();
        const id = s.activeFloorId;
        useMazeStore.setState({ floorFields: { ...s.floorFields, [id]: { ...s.floorFields[id], fieldPoints: new Set([point]) } } });
      };
      vi.advanceTimersByTime(AUTO_ZONES_DEBOUNCE_MS);

      addPoint(10);
      expect(calls()).toBe(afterStart + 1);
      addPoint(11);
      addPoint(12);
      expect(calls()).toBe(afterStart + 1);
      vi.advanceTimersByTime(AUTO_ZONES_DEBOUNCE_MS);
      expect(calls()).toBe(afterStart + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
