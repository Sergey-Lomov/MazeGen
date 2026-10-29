import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { buildCutPlan, clipSpans, cutLineOf, cutLineSides, lineInside, lineSpans, offsetForPoint, resolveGroupCuts, type CutLineSetting, type GroupCut } from "../pixi/imageExport/cutLines";
import { floorCutLines, resolveCutPlan, resolveExportContent } from "../pixi/imageExport/exportContent";
import { resolveFieldConfig } from "../pixi/tessellationCells";
import { cellBounds, getCellCenter, getCellVertices, getFaceEdgeSegment } from "../pixi/tessellationGeometry";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";
import { oneGlue, range } from "./seamFixtures";

// Cut lines (GitHub issue #859): availability and geometry of a glue's cut line, on the same 6x5
// square field as `seamExport.test.ts` (face 0 is east, 1 north, 2 west, 3 south). Expected values
// come from the display helpers, never from hand-written numbers.

const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });

const fold = (a: [number, number], aFace: number, b: [number, number], bFace: number, twist = false): WireFold => ({
  a: { cell: a, face_idx: aFace },
  b: { cell: b, face_idx: bFace },
  twist,
  group: 0,
});
const cylinder = (): WireTopology => oneGlue("square{}", range(ROWS).map((y) => fold([COLUMNS - 1, y], 0, [0, y], 2)));
const mobius = (): WireTopology => oneGlue("square{}", range(ROWS).map((y) => fold([COLUMNS - 1, y], 0, [0, ROWS - 1 - y], 2, true)));

const centerOf = (x: number, y: number): [number, number] => {
  const c = getCellCenter(x, y, field);
  return [c.x, c.y];
};
const cellWidth = Math.hypot(centerOf(1, 0)[0] - centerOf(0, 0)[0], centerOf(1, 0)[1] - centerOf(0, 0)[1]);
const fieldBox = () => cellBounds(cells, field);

function availableCut(topology: WireTopology): GroupCut {
  warmCartesianCache(field, topology);
  const [cut] = resolveGroupCuts(field, topology);
  if (!cut.ok) throw new Error(`unavailable: ${cut.reason}`);
  return cut;
}

describe("resolveGroupCuts", () => {
  it("offers no cuts without a topology", () => {
    warmCartesianCache(field, null);
    expect(resolveGroupCuts(field, null)).toEqual([]);
  });

  it("describes a cylinder glue: a period of the field's width, a line along the run", () => {
    const cut = availableCut(cylinder());
    expect(Math.hypot(...cut.period)).toBeCloseTo(COLUMNS * cellWidth, 6);
    // The run is vertical, so the line is perpendicular to the period.
    expect(Math.abs(cut.direction[0] * cut.period[0] + cut.direction[1] * cut.period[1])).toBeLessThan(1e-6);
    // A manual line moves within the cells the automatic one runs through: half a cell either way.
    expect(cut.maxOffset).toBeCloseTo(0.5 / COLUMNS, 6);
    expect(cut.minOffset).toBeCloseTo(-0.5 / COLUMNS, 6);
  });

  it("puts the automatic line through the centres of one run's cells", () => {
    const cut = availableCut(cylinder());
    const column = [centerOf(0, 0), centerOf(COLUMNS - 1, 0)];
    const onRun = column.some(([x, y]) => Math.hypot(x - cut.origin[0], y - centerOf(0, 0)[1] - (cut.origin[1] - centerOf(0, 0)[1]) * 0) < cellWidth * 10);
    expect(onRun).toBe(true);
    const distances = column.map(([x, y]) => Math.abs((x - cut.origin[0]) * -cut.direction[1] + (y - cut.origin[1]) * cut.direction[0]));
    expect(Math.min(...distances)).toBeLessThan(1e-6);
  });

  it("refuses a Möbius glue (the seam is not a translation)", () => {
    warmCartesianCache(field, mobius());
    expect(resolveGroupCuts(field, mobius())).toEqual([{ ok: false, group: 0, reason: "not_translation" }]);
  });
});

describe("cutLineOf", () => {
  it("has no line for none or an unavailable glue", () => {
    const cut = availableCut(cylinder());
    expect(cutLineOf({ ok: true, ...cut }, undefined)).toBeNull();
    expect(cutLineOf({ ok: true, ...cut }, { mode: "none", offset: 0.3 })).toBeNull();
    expect(cutLineOf({ ok: false, group: 0, reason: "parallel" }, { mode: "auto", offset: 0 })).toBeNull();
  });

  it("puts auto at the origin and clamps a manual offset to the glue's range", () => {
    const cut = availableCut(cylinder());
    expect(cutLineOf({ ok: true, ...cut }, { mode: "auto", offset: 0.4 })!.point).toEqual(cut.origin);
    const far = cutLineOf({ ok: true, ...cut }, { mode: "manual", offset: 5 })!.point;
    expect(offsetForPoint(cut, far)).toBeCloseTo(cut.maxOffset, 9);
    const back = cutLineOf({ ok: true, ...cut }, { mode: "manual", offset: -5 })!.point;
    expect(offsetForPoint(cut, back)).toBeCloseTo(cut.minOffset, 9);
    const half = cutLineOf({ ok: true, ...cut }, { mode: "manual", offset: cut.maxOffset / 2 })!.point;
    expect(offsetForPoint(cut, half)).toBeCloseTo(cut.maxOffset / 2, 9);
  });
});

describe("cutLineSides", () => {
  it("gives the cut line and its twin one period over, which are the two sides of the seam", () => {
    const cut = availableCut(cylinder());
    const line = cutLineOf({ ok: true, ...cut }, { mode: "manual", offset: 0.25 })!;
    const [near, twin] = cutLineSides(line);
    expect(near).toEqual(line.point);
    expect(twin[0] - near[0]).toBeCloseTo(cut.period[0], 9);
    expect(twin[1] - near[1]).toBeCloseTo(cut.period[1], 9);
  });
});

describe("lineInside", () => {
  it("cuts the infinite line to a convex polygon, and gives none for a line outside it", () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(lineInside(square, [5, 3], [0, 1])).toEqual([[5, 0], [5, 10]]);
    expect(lineInside(square, [50, 3], [0, 1])).toBeNull();
  });
});

describe("buildCutPlan", () => {
  it("returns null when nothing is cut", () => {
    expect(buildCutPlan(fieldBox(), [])).toBeNull();
  });

  it("limits the sheet to one period and draws the scene shifted by that period", () => {
    const cut = availableCut(cylinder());
    const plan = buildCutPlan(fieldBox(), [cutLineOf({ ok: true, ...cut }, { mode: "auto", offset: 0 })!])!;
    expect(plan.bounds.maxX - plan.bounds.minX).toBeCloseTo(COLUMNS * cellWidth, 6);
    expect(plan.bounds.maxY - plan.bounds.minY).toBeCloseTo(fieldBox().maxY - fieldBox().minY, 6);
    expect(plan.offsets).toContainEqual([0, 0]);
    expect(plan.offsets).toHaveLength(2);
    expect(plan.guides).toHaveLength(2);
  });

  it("keeps the mode's margin across the cut, so walls on the field's other edges are not clipped", () => {
    const cut = availableCut(cylinder());
    const line = cutLineOf({ ok: true, ...cut }, { mode: "auto", offset: 0 })!;
    const margin = { left: 3, right: 3, top: 2, bottom: 4 };
    const plain = buildCutPlan(fieldBox(), [line])!;
    const padded = buildCutPlan(fieldBox(), [line], margin)!;
    expect(padded.bounds.minY).toBeCloseTo(plain.bounds.minY - 2, 6);
    expect(padded.bounds.maxY).toBeCloseTo(plain.bounds.maxY + 4, 6);
    // Along the cut the strip alone ends the sheet.
    expect(padded.bounds.maxX - padded.bounds.minX).toBeCloseTo(plain.bounds.maxX - plain.bounds.minX, 6);
  });

  it("moves the sheet with a manual offset but keeps its width", () => {
    const cut = availableCut(cylinder());
    const auto = buildCutPlan(fieldBox(), [cutLineOf({ ok: true, ...cut }, { mode: "auto", offset: 0 })!])!;
    const moved = buildCutPlan(fieldBox(), [cutLineOf({ ok: true, ...cut }, { mode: "manual", offset: 0.5 })!])!;
    expect(moved.bounds.maxX - moved.bounds.minX).toBeCloseTo(auto.bounds.maxX - auto.bounds.minX, 6);
    expect(moved.bounds.minX).not.toBeCloseTo(auto.bounds.minX, 3);
  });
});

describe("floorCutLines and resolveExportContent", () => {
  const cuts = (setting: CutLineSetting) => ({ lines: { f: { 0: setting } } });

  it("lists only the glues that have a cut line", () => {
    const topology = cylinder();
    warmCartesianCache(field, topology);
    expect(floorCutLines({ cfg: field, floorId: "f", topology, cuts: { lines: {} } })).toEqual([]);
    const [handle] = floorCutLines({ cfg: field, floorId: "f", topology, cuts: cuts({ mode: "manual", offset: 0.5 }) });
    expect(handle.group).toBe(0);
    expect(handle.mode).toBe("manual");
  });

  it("uses the cut region with no margin, or the mode's own content without a cut", () => {
    const topology = cylinder();
    warmCartesianCache(field, topology);
    const floorNodes = cells.map(([x, y], id) => ({ x, y, id }));
    const modeMargin = { left: 1, right: 2, top: 3, bottom: 4 };
    const plan = resolveCutPlan({ cfg: field, floorId: "f", topology, cuts: cuts({ mode: "auto", offset: 0 }), floorNodes });
    expect(plan).not.toBeNull();
    expect(resolveExportContent(plan, modeMargin, "cell")).toEqual({ margin: { left: 0, right: 0, top: 0, bottom: 0 }, basis: { box: plan!.bounds } });
    const none = resolveCutPlan({ cfg: field, floorId: "f", topology, cuts: { lines: {} }, floorNodes });
    expect(none).toBeNull();
    expect(resolveExportContent(none, modeMargin, "cell")).toEqual({ margin: modeMargin, basis: "cell" });
  });
});

describe("hex cylinder", () => {
  // Pointy-top axial coordinates: a row is shifted by half a cell per step, so the glued east/west
  // boundary of the parallelogram is straight but slanted, and the period is still horizontal.
  const hexCells: [number, number][] = [];
  for (let q = 0; q < COLUMNS; q++) for (let r = 0; r < ROWS; r++) hexCells.push([q, r]);
  const hexField = fieldOf("hex", { shape: "custom", points: hexCells }, "pointy_top");
  const hexFold = (r: number): WireFold => ({ a: { cell: [COLUMNS - 1, r], face_idx: 0 }, b: { cell: [0, r], face_idx: 3 }, twist: false, group: 0 });
  const topology = oneGlue("hex{}", range(ROWS).map(hexFold));

  it("offers a cut along the slanted run, with the period one field width long", () => {
    warmCartesianCache(hexField, topology);
    const [cut] = resolveGroupCuts(hexField, topology);
    if (!cut.ok) throw new Error(`unavailable: ${cut.reason}`);
    const a = getCellCenter(0, 0, hexField);
    const b = getCellCenter(1, 0, hexField);
    const width = Math.hypot(b.x - a.x, b.y - a.y);
    expect(Math.hypot(cut.period[0], cut.period[1])).toBeCloseTo(COLUMNS * width, 6);
    expect(Math.abs(cut.direction[0] * cut.period[1] - cut.direction[1] * cut.period[0])).toBeGreaterThan(0.2);
    const plan = buildCutPlan(cellBounds(hexCells, hexField), [cutLineOf(cut, { mode: "auto", offset: 0 })!])!;
    expect(plan.offsets).toContainEqual([0, 0]);
    expect(plan.offsets.length).toBeGreaterThan(1);
    expect(plan.guides).toHaveLength(2);
  });
});

describe("lineSpans and clipSpans", () => {
  const square = (x: number, y: number): [number, number][] => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];

  it("runs unbroken from the first tile it enters to the last it leaves, over any gap", () => {
    const tiles = [square(0, 0), square(1, 0), square(3, 0)];
    const spans = lineSpans(tiles, [0, 0.5], [1, 0]);
    expect(spans).toEqual([[[0, 0.5], [4, 0.5]]]);
  });

  it("finds nothing where the line misses every tile", () => {
    expect(lineSpans([square(0, 0)], [0, 5], [1, 0])).toEqual([]);
  });

  it("keeps the dent of a tile the line enters twice inside the one line", () => {
    const u: [number, number][] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
    expect(lineSpans([u], [0, 2], [1, 0])).toEqual([[[0, 2], [3, 2]]]);
  });

  it("clips spans to a window of the same line", () => {
    const spans: [[number, number], [number, number]][] = [[[0, 0], [2, 0]], [[3, 0], [4, 0]]];
    expect(clipSpans(spans, [[1, 0], [3.5, 0]], [1, 0])).toEqual([[[1, 0], [2, 0]], [[3, 0], [3.5, 0]]]);
    expect(clipSpans(spans, null, [1, 0])).toEqual([]);
  });

  it("draws plan guides only over the tiles, the twin where the cut halves land", () => {
    const cut = availableCut(cylinder());
    const line = cutLineOf({ ok: true, ...cut }, { mode: "auto", offset: 0 })!;
    // Tiles: only the first two rows of the field.
    const tiles = cells.filter(([, y]) => y < 2).map(([x, y]): [number, number][] => getCellVertices(x, y, field).map((v): [number, number] => [v.x, v.y]));
    const plan = buildCutPlan(fieldBox(), [line], undefined, tiles)!;
    const all = buildCutPlan(fieldBox(), [line])!;
    const span = (guides: { from: number[]; to: number[] }[]) => Math.max(...guides.map((g) => Math.hypot(g.to[0] - g.from[0], g.to[1] - g.from[1])));
    expect(span(plan.guides)).toBeCloseTo(2 * cellWidth, 6);
    expect(span(all.guides)).toBeGreaterThan(span(plan.guides));
    expect(plan.guides).toHaveLength(2);
  });
});

describe("hex zigzag edge", () => {
  // Flat-top hexagons in a rectangle: the top and bottom edges are zigzags (neighbouring columns sit half a cell apart).
  // Top and bottom are glued by each column's own vertical faces, and the columns' lowest/highest cells are the run.
  const hexField = resolveFieldConfig(fieldOf("hex", { shape: "rect", cols: 4, rows: 4 }, "flat_top"));
  const hexCells = hexField.shape.points as [number, number][];
  const centre = (c: [number, number]) => getCellCenter(c[0], c[1], hexField);
  const columns = new Map<number, [number, number][]>();
  for (const c of hexCells) columns.set(Math.round(centre(c).x), [...(columns.get(Math.round(centre(c).x)) ?? []), c]);
  const topCells = [...columns.values()].map((v) => v.reduce((m, c) => (centre(c).y < centre(m).y ? c : m)));
  const bottomCells = [...columns.values()].map((v) => v.reduce((m, c) => (centre(c).y > centre(m).y ? c : m)));
  /** The face of `cell` whose edge is the vertical one on the `up` (or lower) side. */
  const verticalFace = (cell: [number, number], up: boolean): number => {
    for (let i = 0; i < 6; i++) {
      const edge = getFaceEdgeSegment(cell, i, hexField);
      if (!edge) continue;
      const mid = { x: (edge.v0.x + edge.v1.x) / 2, y: (edge.v0.y + edge.v1.y) / 2 };
      if (Math.abs(mid.x - centre(cell).x) < 1e-3 && (mid.y < centre(cell).y) === up) return i;
    }
    throw new Error("no vertical face");
  };
  // Alternate which end is listed as side `a`, as the seam model's cell ordering may do.
  const folds = topCells.map((top, i): WireFold => {
    const bottom = bottomCells[i];
    const [a, b]: [[number, number], number][] = i % 2 === 0
      ? [[top, verticalFace(top, true)], [bottom, verticalFace(bottom, false)]]
      : [[bottom, verticalFace(bottom, false)], [top, verticalFace(top, true)]];
    return { a: { cell: a[0], face_idx: a[1] }, b: { cell: b[0], face_idx: b[1] }, twist: false, group: 0 };
  });
  const topology = oneGlue("hex-zigzag", folds);
  const cutOf = (): GroupCut => {
    warmCartesianCache(hexField, topology);
    const [cut] = resolveGroupCuts(hexField, topology);
    if (!cut.ok) throw new Error(`unavailable: ${cut.reason}`);
    return cut;
  };

  it("runs the line horizontally through the centres of the highest cells, whichever side a seam lists first", () => {
    const cut = cutOf();
    expect(Math.abs(cut.direction[1])).toBeLessThan(1e-9);
    const highest = Math.min(...topCells.map((c) => centre(c).y));
    expect(cut.origin[1]).toBeCloseTo(highest, 6);
    // The period points from the top edge towards the bottom one, so the line is the top edge's, not the field's middle.
    expect(cut.period[1]).toBeGreaterThan(0);
  });

  it("lets a manual line move over the extent of those cells only", () => {
    const cut = cutOf();
    const highest = topCells.filter((c) => Math.abs(centre(c).y - cut.origin[1]) < 1e-4);
    const tops = highest.flatMap((c) => getCellVertices(c[0], c[1], hexField).map((v) => v.y));
    expect(cut.origin[1] + cut.minOffset * cut.period[1]).toBeCloseTo(Math.min(...tops), 6);
    expect(cut.origin[1] + cut.maxOffset * cut.period[1]).toBeCloseTo(Math.max(...tops), 6);
  });
});
