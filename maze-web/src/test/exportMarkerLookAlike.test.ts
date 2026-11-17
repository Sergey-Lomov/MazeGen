import { describe, it, expect } from "vitest";
import { collectMarkerLooks, markersLookAlikeWarningOf, markerLooksAlike, stateMarkerLooks } from "../pixi/selectors/exportMarkerLookAlike";
import type { VerticalConnectionStyle, VerticalMarkerStyle } from "../pixi/renderers/types";
import { computeVectorByWallsWarningsAcrossFloors } from "../pixi/selectors/exportWarnings";
import type { VectorByWallsSettings } from "../store/storeTypes";
import { squareCfg, twoFloorMaze, wallsSettings } from "./exportWarningFixtures";

const waypoint = (over: Record<string, unknown> = {}) => ({ shape: "circle" as const, fillColor: 0xff0000, borderColor: 0x000000, borderWidth: 0, size: 20, sizeAdaptation: 0, ...over });
const teleportSettings = {
  teleportMergeMode: false,
  teleportGroupOverrides: {},
  teleportMarker: { shape: "circle", fillColor: 0x0000ff, borderColor: 0x000000, borderWidth: 0, size: 20, sizeAdaptation: 0 },
} as never;

const verticalMarker = (over: Partial<VerticalMarkerStyle> = {}): VerticalMarkerStyle => ({
  shape: "square", cornerStyle: "miter", fillColor: 0x00ff00, borderColor: 0, borderWidth: 0, gapWidth: 0, gapColor: 0, size: 10, sizeAdaptation: 0, ...over,
});
const verticalStyle = (over: Partial<VerticalConnectionStyle> = {}): VerticalConnectionStyle => ({
  style: "abstract",
  twoWayPassageMarker: verticalMarker(), oneWayPassageMarker: verticalMarker({ shape: "star" }), elevatorMarker: verticalMarker({ shape: "diamond" }),
  twoWayArrowColor: 1, twoWayArrowSize: 1, twoWayArrowStyle: "chevron", twoWayArrowCornerStyle: "miter",
  oneWayArrowColor: 1, oneWayArrowSize: 1, oneWayArrowStyle: "chevron", oneWayArrowCornerStyle: "miter",
  elevatorArrowColor: 1, elevatorArrowSize: 1, elevatorArrowStyle: "chevron", elevatorArrowCornerStyle: "miter",
  ...over,
} as VerticalConnectionStyle);

function run(over: { start?: object; finish?: object; vertical?: { kind: "vertical_passage" | "elevator"; filled: boolean; fromNode: number }[]; style?: VerticalConnectionStyle } = {}) {
  return markersLookAlikeWarningOf(collectMarkerLooks({
    start: { id: 1, style: waypoint({ text: "S", ...over.start }) },
    finish: { id: 2, style: waypoint({ text: "F", ...over.finish }) },
    teleportEdges: [], teleportSettings, vertical: over.vertical ?? [], verticalStyle: over.style ?? verticalStyle(), surface: 0x111111,
  }));
}

describe("markers_look_alike", () => {
  it("is silent when captions tell start and finish apart", () => {
    expect(run()).toBeNull();
  });

  it("flags start and finish with the same look and no caption", () => {
    const warning = run({ start: { text: "" }, finish: { text: "" } });
    expect(warning?.markerPairs).toEqual([["start", "finish"]]);
    expect(warning?.nodes.sort()).toEqual([1, 2]);
  });

  it("treats close colors as the same and different shapes as different", () => {
    expect(run({ start: { text: "" }, finish: { text: "", fillColor: 0xff0101 } })).not.toBeNull();
    expect(run({ start: { text: "" }, finish: { text: "", shape: "star" } })).toBeNull();
  });

  it("compares border presence and border colors", () => {
    expect(run({ start: { text: "" }, finish: { text: "", borderWidth: 2 } })).toBeNull();
    expect(run({ start: { text: "", borderWidth: 2 }, finish: { text: "", borderWidth: 2, borderColor: 0xffffff } })).toBeNull();
  });

  it("flags a two-way passage and an elevator that draw the same marker and arrow", () => {
    const style = verticalStyle({ elevatorMarker: verticalMarker() });
    const warning = run({
      vertical: [{ kind: "vertical_passage", filled: true, fromNode: 5 }, { kind: "elevator", filled: true, fromNode: 6 }], style,
    });
    expect(warning?.markerPairs).toEqual([["two_way_passage", "elevator"]]);
  });

  it("ignores the decorative vertical style and kinds that are not drawn", () => {
    const style = verticalStyle({ style: "decorative", elevatorMarker: verticalMarker() });
    expect(run({ vertical: [{ kind: "vertical_passage", filled: true, fromNode: 5 }, { kind: "elevator", filled: true, fromNode: 6 }], style })).toBeNull();
    expect(run({ vertical: [{ kind: "elevator", filled: true, fromNode: 6 }], style: verticalStyle({ elevatorMarker: verticalMarker() }) })).toBeNull();
  });

  it("markerLooksAlike needs the same inner elements", () => {
    const base = { kind: "start" as const, shape: "circle" as const, fill: 1, border: null, borderWidth: 0, size: 20, sizeAdaptation: 0, nodes: [] };
    expect(markerLooksAlike({ ...base, inner: "a" }, { ...base, kind: "finish", inner: "b" })).toBe(false);
  });

  it("markerLooksAlike tells markers of another size or size adaptation apart", () => {
    const base = { kind: "start" as const, shape: "circle" as const, fill: 1, border: null, borderWidth: 0, size: 20, sizeAdaptation: 0, inner: "", nodes: [] };
    expect(markerLooksAlike(base, { ...base, kind: "finish" })).toBe(true);
    expect(markerLooksAlike(base, { ...base, kind: "finish", size: 22 })).toBe(true);
    expect(markerLooksAlike(base, { ...base, kind: "finish", size: 30 })).toBe(false);
    expect(markerLooksAlike(base, { ...base, kind: "finish", sizeAdaptation: 0.5 })).toBe(false);
  });

  it("markerLooksAlike counts a border of the fill's own color as size", () => {
    const base = { kind: "start" as const, shape: "circle" as const, fill: 1, border: null, borderWidth: 0, size: 30, sizeAdaptation: 0, inner: "", nodes: [] };
    const sameColor = { ...base, kind: "finish" as const, border: 1, borderWidth: 1, size: 28 };
    expect(markerLooksAlike(base, sameColor)).toBe(true);
    expect(markerLooksAlike(base, { ...sameColor, border: 0xffffff })).toBe(false);
    expect(markerLooksAlike(base, { ...sameColor, size: 18 })).toBe(false);
  });
});

describe("markers_look_alike across the project", () => {
  const maze = twoFloorMaze();
  const run = (settings: VectorByWallsSettings, m = maze) =>
    computeVectorByWallsWarningsAcrossFloors(m.nodes, m.edges, m.floors, squareCfg, settings, m.start, m.finish).find((w) => w.id === "markers_look_alike");

  it("compares a start and a finish that sit on different floors", () => {
    const warning = run(wallsSettings());
    expect(warning?.markerPairs).toContainEqual(["start", "finish"]);
    expect(warning?.nodes).toEqual(expect.arrayContaining([maze.start!, maze.finish!]));
  });

  it("is silent when the start and the finish differ by shape", () => {
    const settings = wallsSettings({ finishMarker: { ...wallsSettings().finishMarker, shape: "star" } });
    expect(run(settings)?.markerPairs?.some(([a, b]) => a === "start" && b === "finish") ?? false).toBe(false);
  });

  it("highlights only the end of a one-way teleport that looks like the other marker", () => {
    const teleportMarker = { ...wallsSettings().teleportMarker, shape: "diamond" as const, fillColor: 0xaa0000, borderColor: 0x00aa00, borderWidth: 3, size: 20, sizeAdaptation: 0 };
    const startMarker = { ...wallsSettings().startMarker, shape: "diamond" as const, fillColor: 0xaa0000, borderColor: 0x00aa00, borderWidth: 3, size: 20, sizeAdaptation: 0 };
    const finishMarker = { ...startMarker, shape: "star" as const };
    const m = {
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 4, y: 4, i: 0, level: 0 }, { id: 2, x: 2, y: 2, i: 0, level: 0 }],
      edges: [{ from: 0, to: 1, kind: "teleport" as const }], floors: [{ id: "f0" }], start: 2, finish: null,
    };
    const warning = run(wallsSettings({ teleportMarker, startMarker, finishMarker }), m as never);
    expect(warning?.markerPairs).toEqual([["start", "teleport"]]);
    expect(warning?.nodes.sort()).toEqual([0, 2]);
  });

  it("stateMarkerLooks puts start and finish on the given endpoints and draws none without them", () => {
    const state = { nodes: maze.nodes, edges: maze.edges, floors: maze.floors, activeFieldConfig: squareCfg };
    const kinds = (endpoints: { start: number | null; finish: number | null }) => stateMarkerLooks(state, wallsSettings(), endpoints)
      .filter((look) => look.kind === "start" || look.kind === "finish").map((look) => [look.kind, look.nodes]);
    expect(kinds({ start: maze.start, finish: maze.finish })).toEqual([["start", [maze.start]], ["finish", [maze.finish]]]);
    expect(kinds({ start: null, finish: null })).toEqual([]);
  });
});
