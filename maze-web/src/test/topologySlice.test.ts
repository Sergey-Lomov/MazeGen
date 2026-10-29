import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { initialTopologyState } from "../store/slices/topologySlice";
import { resetNotifications, useNotificationStore } from "../notifications/notificationStore";
import { TOPOLOGY_FOLDS_INACTIVE } from "../store/topologySync";
import { mergedFacePolylines } from "../pixi/topologyGeometry";
import { faceSideArrow } from "../pixi/topologyLabels";
import { problemSides } from "../store/topologyProblem";
import { clearTopologyInfoMemo, dragRun, floorTopologyInfo, glueDraftProblem, inactiveFoldCount, selectionRun } from "../store/topologyInfo";
import { fieldOf } from "./fieldConfigFixtures";
import { baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fakeTessellationShapes } from "./tessellationShapesFake";

vi.mock("../wasm/mazeService", async (importActual) => {
  const actual = await importActual<typeof import("../wasm/mazeService")>();
  return {
    getFieldPreset: actual.getFieldPreset,
    getFieldCapabilities: actual.getFieldCapabilities,
    translateFieldCells: actual.translateFieldCells,
    reflectFieldCells: actual.reflectFieldCells,
    getTopologyInfo: actual.getTopologyInfo,
    editTopology: actual.editTopology,
    TopologyError: actual.TopologyError,
    getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)),
    generateMaze: vi.fn(),
    computeAnalytics: vi.fn(),
    getAvailableChecks: vi.fn(() => []),
    getAvailableStrategies: vi.fn(() => []),
    getGeometrySnapshot: actual.getGeometrySnapshot,
    getCellAt: actual.getCellAt,
    getCellsInRegion: actual.getCellsInRegion,
  };
});
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  resetNotifications();
  clearTopologyInfoMemo();
  useMazeStore.setState({ ...baseStoreState(), ...initialTopologyState, floorTopology: {} });
});

const get = () => useMazeStore.getState();
const topologyOf = () => get().floorTopology[TEST_FLOOR_ID];

/** Pretends a maze was generated, so an edit has something to discard. */
function markGenerated() {
  useMazeStore.setState({ generationStatus: "done", nodes: [{ id: 0, x: 0, y: 0, i: 0 }] });
}

/** Glues the left side of the 10x10 square to its right side (a cylinder). */
function glueCylinder() {
  const info = floorTopologyInfo(get(), TEST_FLOOR_ID);
  if (!info.ok) throw new Error(info.error);
  // The contour runs counter-clockwise: the right side upwards, the left side downwards.
  const side = (faceIdx: number, dir: number) =>
    info.info.contours[0].filter((f) => f.face_idx === faceIdx).sort((p, q) => dir * (p.cell[1] - q.cell[1]));
  get().applyTopologyOp({ kind: "glue", a: side(2, -1), b: side(0, 1), twist: false });
}

describe("topology editor store (GitHub issue #839)", () => {
  it("glues a cylinder, then removes its group", () => {
    glueCylinder();
    const topology = topologyOf();
    expect(topology.folds.length).toBeGreaterThan(0);
    expect(topology.groups).toHaveLength(1);
    expect(get().topologyPanelError).toBeNull();

    get().removeTopologyGroup(topology.groups[0].id);
    expect(topologyOf()).toBeUndefined();
  });

  it("drops the export cut line of a removed glue with the same update, and keeps the others", () => {
    glueCylinder();
    const id = topologyOf().groups[0].id;
    const auto = { mode: "auto" as const, offset: 0 };
    const cuts = { lines: { [TEST_FLOOR_ID]: { [id]: auto, 7: auto }, other: { 0: auto } } };
    useMazeStore.setState({ pngExportSettings: { ...get().pngExportSettings, cuts } });
    const topologies: unknown[] = [];
    const unsubscribe = useMazeStore.subscribe((state) => topologies.push(state.floorTopology[TEST_FLOOR_ID]));
    get().removeTopologyGroup(id);
    unsubscribe();
    expect(topologyOf()).toBeUndefined();
    // The removed glue's line is gone, the other floor's stays; a floor left with no lines has no entry.
    expect(get().pngExportSettings.cuts.lines).toEqual({ other: { 0: auto } });
    // One store update, not a second one from a subscriber.
    expect(topologies).toEqual([undefined]);
  });

  it("glues two picked boundary runs as a new group", () => {
    const info = floorTopologyInfo(get(), TEST_FLOOR_ID);
    if (!info.ok) throw new Error(info.error);
    // Left and right edges of the 10x10 square are two runs of one contour; find a single-face
    // pair that core accepts by trying every pair of distinct faces.
    const faces = info.info.contours[0];
    let glued = false;
    for (let a = 0; a < faces.length && !glued; a++) {
      for (let b = 0; b < faces.length && !glued; b++) {
        if (a === b) continue;
        useMazeStore.setState({
          topologyRunA: { contour: 0, start: a, end: a },
          topologyRunB: { contour: 0, start: b, end: b },
          topologyGlueError: null,
        });
        get().confirmTopologyGlue();
        glued = topologyOf() !== undefined;
      }
    }
    expect(glued).toBe(true);
    expect(topologyOf().folds).toHaveLength(1);
    // The picks are consumed by the edit.
    expect(get().topologyRunA).toBeNull();
    expect(get().topologyPick).toBeNull();
  });

  it("draws a run by dragging: the shortest way between the anchor and the pointer face", () => {
    // 10 faces: dragging from 2 to 4 goes forward, from 2 to 9 goes backward across the seam.
    expect(dragRun(0, 10, 2, 4)).toEqual({ contour: 0, start: 2, end: 4 });
    expect(dragRun(0, 10, 2, 9)).toEqual({ contour: 0, start: 9, end: 2 });
    expect(dragRun(0, 10, 2, 2)).toEqual({ contour: 0, start: 2, end: 2 });

    get().startTopologyPick("a");
    get().setTopologyRun("a", dragRun(0, 10, 2, 4));
    expect(get().topologyRunA).toEqual({ contour: 0, start: 2, end: 4 });
    expect(get().topologyRunB).toBeNull();
  });

  it("names what blocks a draft glue, with the problem sides", () => {
    const face = (x: number, f = 0) => ({ cell: [x, 0] as [number, number], face_idx: f });
    expect(glueDraftProblem([face(0)], null, undefined)).toBeNull();
    expect(glueDraftProblem([face(0), face(1)], [face(1), face(2)], undefined)).toEqual({ code: "overlap", sides: [face(1)] });
    expect(glueDraftProblem([face(0), face(1)], [face(5)], undefined)).toEqual({ code: "run_length_mismatch", a: 2, b: 1 });
    expect(glueDraftProblem([face(0)], [face(5)], undefined)).toBeNull();
    glueCylinder();
    const used = topologyOf().folds[0].a;
    expect(glueDraftProblem([used, face(7, 3)], null, topologyOf())).toEqual({ code: "used", sides: [used] });
  });

  it("reports a core refusal as a structured problem naming the sides", () => {
    glueCylinder();
    const fold = topologyOf().folds[0];
    // The cylinder already glues both sides of its first fold: core points at a used side.
    get().applyTopologyOp({ kind: "glue", a: [fold.a], b: [fold.b], twist: false });
    expect(get().topologyGlueError).toMatchObject({ code: "face_in_use" });
    get().applyTopologyOp({ kind: "remove_group", id: 99 });
    expect(get().topologyPanelError).toEqual({ code: "unknown_group", group: 99 });
  });

  it("selectionRun wraps around the contour end", () => {
    const contour = [0, 1, 2, 3, 4].map((i) => ({ cell: [i, 0] as [number, number], face_idx: 0 }));
    expect(selectionRun({ contour: 0, start: 3, end: 1 }, [contour])?.map((end) => end.cell[0])).toEqual([3, 4, 0, 1]);
    expect(selectionRun(null, [contour])).toBeNull();
  });

  it("discards the generated maze when the active folds change", () => {
    markGenerated();
    glueCylinder();
    expect(get().generationStatus).toBe("idle");
    expect(get().nodes).toEqual([]);
  });

  it("asks for confirmation instead of discarding a dirty maze, and applies on confirm", () => {
    markGenerated();
    useMazeStore.setState({ mazeDirty: true });
    glueCylinder();
    expect(topologyOf()).toBeUndefined();
    expect(get().fieldEditConfirmation).not.toBeNull();

    get().confirmFieldEdit();
    expect(topologyOf()?.folds.length).toBeGreaterThan(0);
    expect(get().fieldEditConfirmation).toBeNull();
  });

  it("keeps the topology but flags folds inactive when a field edit removes their cells", () => {
    glueCylinder();
    expect(inactiveFoldCount(floorTopologyInfo(get(), TEST_FLOOR_ID))).toBe(0);

    // Shrinking the field to a free-form single cell leaves the seam faces without cells.
    const field = get().floorFields[TEST_FLOOR_ID];
    useMazeStore.setState({
      floorFields: {
        ...get().floorFields,
        [TEST_FLOOR_ID]: {
          ...field,
          fieldEditMode: "custom",
          fieldConfig: fieldOf("square", { shape: "custom", points: [[0, 0]] }),
        },
      },
    });

    expect(topologyOf()).toBeDefined();
    const result = floorTopologyInfo(get(), TEST_FLOOR_ID);
    expect(result.ok).toBe(true);
    expect(inactiveFoldCount(result)).toBeGreaterThan(0);
  });

  it("lists the reason of an inactive fold", () => {
    glueCylinder();
    const field = get().floorFields[TEST_FLOOR_ID];
    useMazeStore.setState({
      floorFields: {
        ...get().floorFields,
        [TEST_FLOOR_ID]: { ...field, fieldEditMode: "custom", fieldConfig: fieldOf("square", { shape: "custom", points: [[0, 0]] }) },
      },
    });
    const result = floorTopologyInfo(get(), TEST_FLOOR_ID);
    if (!result.ok) throw new Error(result.error);
    const reasons = result.info.activity.flatMap((activity) => (activity.state === "inactive" ? [activity.reason] : []));
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => ["missing_cell", "interior_neighbor", "duplicate_neighbor"].includes(reason))).toBe(true);
  });

  it("announces a field edit that deactivates folds", () => {
    glueCylinder();
    resetNotifications();
    const field = get().floorFields[TEST_FLOOR_ID];
    const edit = (points: [number, number][]) => useMazeStore.setState({
      floorFields: {
        ...get().floorFields,
        [TEST_FLOOR_ID]: { ...field, fieldEditMode: "custom", fieldConfig: fieldOf("square", { shape: "custom", points }) },
      },
    });

    edit([[0, 0]]);
    expect(useNotificationStore.getState().notices.map((n) => n.code)).toEqual([TOPOLOGY_FOLDS_INACTIVE]);
  });

  it("names the four sides of a square cell by distinct arrows", () => {
    const cfg = get().floorFields[TEST_FLOOR_ID].fieldConfig;
    const arrows = [0, 1, 2, 3].map((face) => faceSideArrow({ cell: [5, 5], face_idx: face }, cfg));
    expect(new Set(arrows).size).toBe(4);
  });

  it("clears the hovered glue when an edit replaces the glues or the panel closes", () => {
    glueCylinder();
    get().setTopologyHover({ glue: topologyOf().groups[0].id, fold: null });
    expect(get().topologyHover).not.toBeNull();
    get().removeTopologyGroup(topologyOf().groups[0].id);
    expect(get().topologyHover).toBeNull();

    get().setTopologyPanelOpen(true);
    get().setTopologyHover({ glue: 0, fold: null });
    get().setTopologyPanelOpen(false);
    expect(get().topologyHover).toBeNull();
  });

  it("merges the faces of a cylinder's two sides into one polyline per side", () => {
    glueCylinder();
    const topology = topologyOf();
    const info = floorTopologyInfo(get(), TEST_FLOOR_ID);
    if (!info.ok) throw new Error(info.error);
    const cfg = get().floorFields[TEST_FLOOR_ID].fieldConfig;
    const ends = topology.folds.flatMap((fold) => [fold.a, fold.b]);
    const merged = mergedFacePolylines(ends, info.info.contours, cfg);
    expect(merged).toHaveLength(2);
    // One pair alone is two separate faces, hence two polylines.
    expect(mergedFacePolylines([topology.folds[0].a, topology.folds[0].b], info.info.contours, cfg)).toHaveLength(2);
    // A side of a 10-cell column is as long as 10 faces.
    const length = (polyline: [number, number][]) => polyline.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - polyline[i][0], p[1] - polyline[i][1]), 0);
    const single = length(mergedFacePolylines([topology.folds[0].a], info.info.contours, cfg)[0]);
    expect(length(merged[0])).toBeCloseTo(single * topology.folds.length, 3);
  });

  it("drops the picks when the glue editor panel is closed, and closes it after a successful glue", () => {
    get().setTopologyPanelOpen(true);
    get().openTopologyGlueEditor();
    get().startTopologyPick("a");
    get().setTopologyRun("a", { contour: 0, start: 1, end: 1 });
    expect(get().topologyRunA).not.toBeNull();
    get().closeTopologyGlueEditor();
    expect(get().topologyRunA).toBeNull();
    expect(get().topologyPick).toBeNull();

    get().openTopologyGlueEditor();
    glueCylinder();
    expect(get().topologyGlueEditor).toBeNull();

    get().openTopologyGlueEditor();
    get().setTopologyPanelOpen(false);
    expect(get().topologyGlueEditor).toBeNull();
  });

  it("loads an existing glue into the editor and replaces it on confirm", () => {
    glueCylinder();
    const before = topologyOf();
    expect(before.groups.length).toBeGreaterThan(0);
    const glueId = before.groups[0].id;
    const foldCount = before.folds.length;

    get().openTopologyGlueEditor(glueId);
    expect(get().topologyGlueEditor).toEqual({ mode: "edit", glueId });
    expect(get().topologyRunA).not.toBeNull();
    expect(get().topologyRunB).not.toBeNull();
    expect(get().topologyTwist).toBe(false);

    // Confirming the loaded runs reproduces the glue in place: same group count and id.
    get().confirmTopologyGlue();
    expect(get().topologyGlueError).toBeNull();
    expect(get().topologyGlueEditor).toBeNull();
    const after = topologyOf();
    expect(after.groups).toHaveLength(before.groups.length);
    expect(after.groups[0].id).toBe(glueId);
    expect(after.folds).toHaveLength(foldCount);
    expect(after.folds.map((f) => [f.a, f.b])).toEqual(before.folds.map((f) => [f.a, f.b]));
  });

  it("selectionRun returns explicit faces as they are and rejects an empty list", () => {
    const faces = [{ cell: [2, 0] as [number, number], face_idx: 1 }, { cell: [0, 0] as [number, number], face_idx: 3 }];
    expect(selectionRun({ faces }, [])).toEqual(faces);
    expect(selectionRun({ faces: [] }, [])).toBeNull();
  });

  it("ignores the glue being edited when it looks for used sides", () => {
    glueCylinder();
    const fold = topologyOf().folds[0];
    expect(glueDraftProblem([fold.a], null, topologyOf())).toMatchObject({ code: "used" });
    expect(glueDraftProblem([fold.a], [fold.b], topologyOf(), topologyOf().groups[0].id)).toBeNull();
  });

  it("names the sides a problem points at, including every other connection of a duplicate neighbour", () => {
    const end = (x: number, f = 0) => ({ cell: [x, 0] as [number, number], face_idx: f });
    expect(problemSides({ code: "empty_run" })).toEqual([]);
    expect(problemSides({ code: "face_in_use", face: end(1) })).toEqual([end(1)]);
    expect(problemSides({ code: "self_glued", a: end(1), b: end(2) })).toEqual([end(1), end(2)]);
    expect(problemSides({ code: "overlap", sides: [end(3)] })).toEqual([end(3)]);
    expect(problemSides({ code: "inactive_fold", reason: "duplicate_neighbor", a: end(1), b: end(2), existing: false, connections: [[end(3), end(4)]] }))
      .toEqual([end(1), end(2), end(3), end(4)]);
    expect(problemSides({ code: "inactive_fold", reason: "missing_cell", a: end(1), b: end(2), existing: true })).toEqual([end(1), end(2)]);
  });

  it("refuses to load a glue that mixes twisted and untwisted pairs", () => {
    glueCylinder();
    const topology = topologyOf();
    useMazeStore.setState({
      floorTopology: { [TEST_FLOOR_ID]: { ...topology, folds: topology.folds.map((fold, i) => (i === 0 ? { ...fold, twist: true } : fold)) } },
    });
    get().openTopologyGlueEditor(topology.groups[0].id);
    expect(get().topologyGlueEditor).toBeNull();
    expect(get().topologyPanelError).toMatchObject({ code: "inconsistent" });
  });

  it("closes the editor instead of replacing a glue that was removed meanwhile", () => {
    glueCylinder();
    const glueId = topologyOf().groups[0].id;
    get().openTopologyGlueEditor(glueId);
    useMazeStore.setState({ floorTopology: {} });
    get().confirmTopologyGlue();
    expect(get().topologyGlueEditor).toBeNull();
    expect(topologyOf()).toBeUndefined();
    expect(get().topologyGlueError).toBeNull();
  });

  it("flags problem sides and clears them", () => {
    const side = { cell: [0, 0] as [number, number], face_idx: 2 };
    get().setTopologyFlagged([side]);
    expect(get().topologyFlagged).toEqual([side]);
    get().setTopologyFlagged([]);
    expect(get().topologyFlagged).toEqual([]);
  });
});
