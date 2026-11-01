import { describe, it, expect, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { initialTopologyState } from "../store/slices/topologySlice";
import { nextCreaseId, validateCreases, withCrease, type Crease } from "../store/creases";
import { selectCreaseLines } from "../pixi/selectors/creaseLines";
import { creaseDisplayPoint, creaseLabelPoint, faceMidpoint, nearestCreaseAnchor } from "../pixi/creaseGeometry";
import { getCellGeometry } from "../pixi/cartesianCache";
import { baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";

beforeEach(() => {
  useMazeStore.setState({ ...baseStoreState(), ...initialTopologyState, floorCreases: {} });
});

const get = () => useMazeStore.getState();
const creasesOf = () => get().floorCreases[TEST_FLOOR_ID] ?? [];

describe("crease list helpers", () => {
  it("numbers a new crease max + 1 and replaces in place", () => {
    const list: Crease[] = [{ id: 0, a: [0, 0], b: [1, 0] }, { id: 4, a: [0, 1], b: [1, 1] }];
    expect(nextCreaseId(list)).toBe(5);
    expect(withCrease(list, [2, 2], [3, 3], null)?.map((c) => c.id)).toEqual([0, 4, 5]);
    expect(withCrease(list, [2, 2], [3, 3], 4)).toEqual([list[0], { id: 4, a: [2, 2], b: [3, 3] }]);
  });

  it("refuses a crease with equal ends", () => {
    expect(withCrease([], [1, 1], [1, 1], null)).toBeNull();
  });

  it("validates a project-file list", () => {
    expect(validateCreases([{ id: 0, a: [0, 0], b: [1, 1] }], "creases")).toHaveLength(1);
    expect(() => validateCreases({}, "creases")).toThrow(/array/);
    expect(() => validateCreases([{ id: 0, a: [0, 0], b: [0, 0] }], "creases")).toThrow(/equal ends/);
    expect(() => validateCreases([{ id: 1, a: [0, 0], b: [1, 1] }, { id: 1, a: [0, 0], b: [2, 2] }], "creases")).toThrow(/unique/);
    expect(() => validateCreases([{ id: 0, a: [0, "x"], b: [1, 1] }], "creases")).toThrow(/\[x, y\]/);
    expect(() => validateCreases([null], "creases")).toThrow(/object/);
    expect(() => validateCreases([{ id: -1, a: [0, 0], b: [1, 1] }], "creases")).toThrow(/id/);
    expect(() => validateCreases([{ id: 0, a: [0, 0], b: [Infinity, 1] }], "creases")).toThrow(/\[x, y\]/);
  });
});

describe("crease drawing", () => {
  it("stores a crease after two clicks and leaves the maze alone", () => {
    useMazeStore.setState({ mazeDirty: true });
    get().startCreaseDraft();
    get().placeCreasePoint([0, 0]);
    expect(creasesOf()).toHaveLength(0);
    expect(get().creaseDraft?.a).toEqual([0, 0]);
    get().placeCreasePoint([2, 1]);
    expect(creasesOf()).toEqual([{ id: 0, a: [0, 0], b: [2, 1] }]);
    expect(get().creaseDraft).toBeNull();
    expect(get().mazeDirty).toBe(true);
  });

  it("waits for a distinct second point", () => {
    get().startCreaseDraft();
    get().placeCreasePoint([1, 1]);
    get().placeCreasePoint([1, 1]);
    expect(creasesOf()).toHaveLength(0);
    expect(get().creaseDraft).not.toBeNull();
  });

  it("redraws an existing crease keeping its id", () => {
    useMazeStore.setState({ floorCreases: { [TEST_FLOOR_ID]: [{ id: 3, a: [0, 0], b: [1, 0] }] } });
    get().startCreaseDraft(3);
    get().placeCreasePoint([5, 5]);
    get().placeCreasePoint([6, 6]);
    expect(creasesOf()).toEqual([{ id: 3, a: [5, 5], b: [6, 6] }]);
  });

  it("cancels the draft and switching mode drops it", () => {
    get().startCreaseDraft();
    get().cancelCreaseDraft();
    expect(get().creaseDraft).toBeNull();
    get().setTopologyMode("creases");
    get().startCreaseDraft();
    get().setTopologyMode("gluings");
    expect(get().creaseDraft).toBeNull();
  });

  it("removes one crease and all of them, dropping an empty entry", () => {
    useMazeStore.setState({ floorCreases: { [TEST_FLOOR_ID]: [{ id: 0, a: [0, 0], b: [1, 0] }, { id: 1, a: [0, 0], b: [0, 1] }] } });
    get().removeCrease(0);
    expect(creasesOf().map((c) => c.id)).toEqual([1]);
    get().removeCrease(1);
    expect(get().floorCreases[TEST_FLOOR_ID]).toBeUndefined();
    useMazeStore.setState({ floorCreases: { [TEST_FLOOR_ID]: [{ id: 0, a: [0, 0], b: [1, 0] }] } });
    get().clearCreases();
    expect(get().floorCreases).toEqual({});
  });
});

describe("crease lines on the canvas", () => {
  it("hides the crease being redrawn and shows the preview segment", () => {
    useMazeStore.setState({ floorCreases: { [TEST_FLOOR_ID]: [{ id: 0, a: [0, 0], b: [1, 0] }, { id: 1, a: [0, 1], b: [1, 1] }] } });
    expect(selectCreaseLines(get())).toHaveLength(2);
    get().startCreaseDraft(0);
    get().placeCreasePoint([2, 2]);
    get().setCreaseCursor([3, 3]);
    const lines = selectCreaseLines(get());
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.preview)).toHaveLength(1);
  });
});

describe("crease hover emphasis", () => {
  it("emphasizes only the crease hovered in the panel", () => {
    useMazeStore.setState({ floorCreases: { [TEST_FLOOR_ID]: [{ id: 0, a: [0, 0], b: [1, 0] }, { id: 1, a: [0, 1], b: [1, 1] }] } });
    get().setCreaseHover(1);
    expect(selectCreaseLines(get()).map((line) => line.emphasized)).toEqual([false, true]);
    get().setCreaseHover(null);
    expect(selectCreaseLines(get()).some((line) => line.emphasized)).toBe(false);
  });
});

describe("crease snapping and labels", () => {
  const cfg = () => get().floorFields[TEST_FLOOR_ID].fieldConfig;

  it("snaps to the cell center, a corner and a face midpoint, and not to empty space inside a cell", () => {
    const geometry = getCellGeometry(0, 0, cfg());
    const face = geometry.faces[0];
    const corner = face.segments[0].from;
    const midpoint = faceMidpoint(face.segments)!;
    for (const target of [[geometry.center[0], geometry.center[1]], [corner[0], corner[1]], midpoint]) {
      const near = creaseDisplayPoint([target[0], target[1]], cfg());
      expect(nearestCreaseAnchor([near[0] + 0.5, near[1] - 0.5], cfg(), 2)).toEqual(target);
    }
    expect(nearestCreaseAnchor([1e6 + 7, 1e6 + 7], cfg(), 2)).toBeNull();
  });

  it("labels the origin cell center as 0; 0 and a point one pitch away as 1 unit", () => {
    const center = getCellGeometry(0, 0, cfg()).center;
    const [x, y] = creaseLabelPoint([center[0], center[1]], cfg());
    expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(Math.abs(y)).toBeLessThan(1e-9);
    const [dx, dy] = creaseLabelPoint([center[0] + 1, center[1]], cfg());
    expect(Math.hypot(dx, dy)).toBeCloseTo(1);
  });
});

describe("face midpoint", () => {
  it("is halfway along a line and on the curve for an arc", () => {
    expect(faceMidpoint([{ kind: "line", from: [0, 0], to: [4, 0] }])).toEqual([2, 0]);
    const arc = faceMidpoint([{ kind: "arc", from: [1, 0], to: [-1, 0], center: [0, 0], radius: 1, start_angle: 0, sweep: Math.PI }])!;
    expect(arc[0]).toBeCloseTo(0);
    expect(arc[1]).toBeCloseTo(1);
    expect(faceMidpoint([])).toBeNull();
  });

  it("walks across segments by path length", () => {
    const mid = faceMidpoint([
      { kind: "line", from: [0, 0], to: [1, 0] },
      { kind: "line", from: [1, 0], to: [1, 3] },
    ])!;
    expect(mid[0]).toBeCloseTo(1);
    expect(mid[1]).toBeCloseTo(1);
  });
});

describe("crease draft and floors", () => {
  it("drops the draft and hover when the active floor changes", () => {
    useMazeStore.setState({ topologyMode: "creases" });
    get().startCreaseDraft();
    get().placeCreasePoint([0, 0]);
    get().setCreaseHover(0);
    get().setActiveFloorId(TEST_FLOOR_ID);
    expect(get().creaseDraft).toBeNull();
    expect(get().creaseHover).toBeNull();
  });
});

describe("copying floors", () => {
  const second = "floor_2";
  const seed = (extra: Record<string, unknown> = {}) => {
    const field = get().floorFields[TEST_FLOOR_ID];
    useMazeStore.setState({
      floors: [...get().floors, { id: second, title: "Second" }],
      floorFields: { ...get().floorFields, [second]: structuredClone(field) },
      floorCreases: { [TEST_FLOOR_ID]: [{ id: 0, a: [0, 0], b: [1, 0] }] },
      mazeDirty: false,
      postEditDirty: false,
      ...extra,
    });
  };

  it("copies creases along with the topology and clears them for a source without", () => {
    seed({ activeFloorId: second });
    get().copyFloorField(TEST_FLOOR_ID);
    expect(get().floorCreases[second]).toEqual(get().floorCreases[TEST_FLOOR_ID]);
    useMazeStore.setState({ activeFloorId: TEST_FLOOR_ID });
    get().copyFloorField(second, true);
    expect(get().floorCreases[TEST_FLOOR_ID]).toEqual(get().floorCreases[second]);
    useMazeStore.setState({ floorCreases: { [second]: [{ id: 3, a: [0, 0], b: [2, 2] }] }, activeFloorId: second });
    get().copyFloorField(TEST_FLOOR_ID);
    expect(get().floorCreases[second]).toBeUndefined();
  });

  it("leaves creases alone when the topology option is off", () => {
    seed({ activeFloorId: second });
    get().copyFloorField(TEST_FLOOR_ID, false);
    expect(get().floorCreases[second]).toBeUndefined();
  });

  it("synchronizes the active floor's creases to every floor", () => {
    seed();
    get().copyCurrentFloorFieldToAll();
    expect(get().floorCreases[second]).toEqual(get().floorCreases[TEST_FLOOR_ID]);
  });
});
