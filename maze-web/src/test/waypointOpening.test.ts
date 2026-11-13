import { describe, it, expect, vi } from "vitest";
import { buildMazeWalls, buildWaypointOpenings, endpointOuterFaces, floorCellSet, isOpeningWall, listOuterFaces, openingGapReach, resolveOpeningFace } from "../pixi/selectors/mazeSelectors";
import { validateWaypointOpening } from "../store/projectExport/validateImageExport";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import type { NodeDto } from "../wasm/types";
import type { WaypointOpeningMode } from "../store/imageExportTypes";
import { n, squareCfg } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));

// 4x4 square field: (0,0) is a corner touching two outer sides, (1,1) is interior.
const cells: [number, number][] = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells.push([x, y]);
const cellSet = new Set(cells.map(([x, y]) => `${x},${y}`));

describe("listOuterFaces (GitHub issue #330)", () => {
  it("lists both outer sides of a corner cell, with compass names", () => {
    const faces = listOuterFaces([0, 0], cellSet, squareCfg);
    expect(faces).toHaveLength(2);
    expect(faces.map((f) => f.compass).sort()).toEqual(["bottom", "left"]);
  });

  it("lists one side for an edge cell and none for an interior cell", () => {
    expect(listOuterFaces([2, 0], cellSet, squareCfg).map((f) => f.compass)).toEqual(["bottom"]);
    expect(listOuterFaces([1, 1], cellSet, squareCfg)).toEqual([]);
  });

  it("treats a side leading to a cell missing from the set as outer", () => {
    const hole = new Set(cellSet);
    hole.delete("2,1");
    expect(listOuterFaces([1, 1], hole, squareCfg)).toHaveLength(1);
  });
});

describe("OuterFace.outward (GitHub issue #330)", () => {
  it("gives each outer side a unit normal pointing out of the field", () => {
    const left = listOuterFaces([0, 0], cellSet, squareCfg).find((f) => f.compass === "left")!;
    const bottom = listOuterFaces([0, 0], cellSet, squareCfg).find((f) => f.compass === "bottom")!;
    expect(left.outward.x).toBeCloseTo(-1);
    expect(left.outward.y).toBeCloseTo(0);
    expect(bottom.outward.x).toBeCloseTo(0);
    expect(Math.abs(bottom.outward.y)).toBeCloseTo(1);
    // The opposite side of the same cell row lies the other way: left normal points away from the right outer side.
    const right = listOuterFaces([3, 0], cellSet, squareCfg).find((f) => f.compass === "right")!;
    expect(right.outward.x).toBeCloseTo(1);
  });
});

describe("OuterFace.polyline (GitHub issue #330)", () => {
  it("is the side's path, running through its contact point", () => {
    const left = listOuterFaces([0, 0], cellSet, squareCfg).find((f) => f.compass === "left")!;
    expect(left.polyline.length).toBeGreaterThanOrEqual(2);
    // A straight side: every point of the path lies on the line through the contact point along the side.
    for (const [x] of left.polyline) expect(x).toBeCloseTo(left.contact.x);
  });
});

describe("openingGapReach (GitHub issue #330)", () => {
  it("is half the wall where the wall stays and zero where it is cut", () => {
    expect(openingGapReach("pointer", 6)).toBe(3);
    expect(openingGapReach("opening", 6)).toBe(0);
    expect(openingGapReach("both", 6)).toBe(0);
  });
});

describe("resolveOpeningFace", () => {
  const faces = listOuterFaces([0, 0], cellSet, squareCfg);

  it("keeps the chosen outer face, else falls back to the first", () => {
    expect(resolveOpeningFace(faces, faces[1].face)).toBe(faces[1]);
    expect(resolveOpeningFace(faces, 99)).toBe(faces[0]);
    expect(resolveOpeningFace(faces, undefined)).toBe(faces[0]);
  });

  it("returns undefined without outer faces", () => {
    expect(resolveOpeningFace([], 0)).toBeUndefined();
  });
});

describe("isOpeningWall", () => {
  const nodes = cells.map(([x, y], i) => n(i, x, y));

  it("matches exactly the boundary wall of the chosen side", () => {
    const walls = buildMazeWalls(nodes, [], squareCfg);
    const [first, second] = listOuterFaces([0, 0], cellSet, squareCfg);
    const matchesFirst = walls.filter((w) => isOpeningWall(w, [0, 0], first));
    const matchesSecond = walls.filter((w) => isOpeningWall(w, [0, 0], second));
    expect(matchesFirst).toHaveLength(1);
    expect(matchesSecond).toHaveLength(1);
    expect(matchesFirst[0]).not.toBe(matchesSecond[0]);
  });

  it("does not match the cell's inner walls", () => {
    const walls = buildMazeWalls(nodes, [], squareCfg);
    const outer = listOuterFaces([0, 0], cellSet, squareCfg)[0];
    const inner = walls.filter((w) => w.a[0] === 0 && w.a[1] === 0 && !isOpeningWall(w, [0, 0], outer));
    expect(inner.length).toBeGreaterThan(0);
  });
});

describe("buildWaypointOpenings", () => {
  const nodes: NodeDto[] = cells.map(([x, y], i) => n(i, x, y));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const off = { mode: "none" as const };
  const on = { mode: "both" as const };
  const settings = (start: { mode: WaypointOpeningMode; face?: number }, finish: { mode: WaypointOpeningMode; face?: number }) => ({ startOpening: start, finishOpening: finish });

  it("builds nothing while both toggles are off", () => {
    expect(buildWaypointOpenings(settings(off, off), nodeById, 0, 15, cells, squareCfg)).toEqual([]);
  });

  it("start arrow points into the cell, finish arrow points out of it", () => {
    const [start] = buildWaypointOpenings(settings(on, off), nodeById, 2, 2, cells, squareCfg);
    const [finish] = buildWaypointOpenings(settings(off, on), nodeById, 2, 2, cells, squareCfg);
    expect(start.kind).toBe("start");
    expect(finish.kind).toBe("finish");
    // Cell (2,0) has its outer side below it (row 0 is the bottom row), so inward is up on screen: -y.
    expect(start.dy).toBeLessThan(-0.99);
    expect(finish.dy).toBeGreaterThan(0.99);
    expect(Math.hypot(start.dx, start.dy)).toBeCloseTo(1);
  });

  it("skips an interior cell, a missing node and a null endpoint", () => {
    expect(buildWaypointOpenings(settings(on, on), nodeById, 5, null, cells, squareCfg)).toEqual([]);
    expect(buildWaypointOpenings(settings(on, off), nodeById, 99, null, cells, squareCfg)).toEqual([]);
  });

  it("uses the chosen side of a corner cell", () => {
    const faces = listOuterFaces([0, 0], cellSet, squareCfg);
    const a = buildWaypointOpenings(settings({ ...on, face: faces[0].face }, off), nodeById, 0, null, cells, squareCfg)[0];
    const b = buildWaypointOpenings(settings({ ...on, face: faces[1].face }, off), nodeById, 0, null, cells, squareCfg)[0];
    expect(a.outer.face).toBe(faces[0].face);
    expect(b.outer.face).toBe(faces[1].face);
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
  });
});

describe("validateWaypointOpening", () => {
  const fallback = DEFAULT_VECTOR_BY_WALLS_SETTINGS.startOpening;

  it("round-trips a full value", () => {
    const value = { mode: "pointer", face: 2, pattern: "arrow", color: 0xabcdef, size: 9, thickness: 6, gapWidth: 5, join: "miter" };
    expect(validateWaypointOpening(value, "p", fallback)).toEqual(value);
  });

  it("falls back on junk and drops an invalid face", () => {
    const result = validateWaypointOpening({ mode: "x", enabled: "x", face: -1, pattern: "nope", color: "red", size: null, thickness: "x", gapWidth: "x", join: "bevel" }, "p", fallback);
    expect(result).toEqual(fallback);
    expect(validateWaypointOpening({ face: 1.5 }, "p", fallback).face).toBeUndefined();
  });

  it("reads a file saved while the passage was a plain toggle: on is both, off is none", () => {
    expect(validateWaypointOpening({ enabled: true }, "p", fallback).mode).toBe("both");
    expect(validateWaypointOpening({ enabled: false }, "p", fallback).mode).toBe("none");
    expect(validateWaypointOpening({ enabled: true, mode: "opening" }, "p", fallback).mode).toBe("opening");
  });

  it("returns the fallback for a missing value (a file saved before the feature)", () => {
    expect(validateWaypointOpening(undefined, "p", fallback)).toEqual(fallback);
  });
});

describe("defaults", () => {
  it("link the finish external passage's mode, pattern, color, size, thickness, gap width and corner style to the start's", () => {
    const links = DEFAULT_VECTOR_BY_WALLS_LINKS.filter((l) => l.target.startsWith("finishOpening."));
    expect(links.map((l) => [l.source, l.target, l.enabled]).sort()).toEqual([
      ["startOpening.color", "finishOpening.color", true],
      ["startOpening.gapWidth", "finishOpening.gapWidth", true],
      ["startOpening.join", "finishOpening.join", true],
      ["startOpening.mode", "finishOpening.mode", true],
      ["startOpening.pattern", "finishOpening.pattern", true],
      ["startOpening.size", "finishOpening.size", true],
      ["startOpening.thickness", "finishOpening.thickness", true],
    ]);
  });

  it("ship both external passages off", () => {
    expect(DEFAULT_VECTOR_BY_WALLS_SETTINGS.startOpening.mode).toBe("none");
    expect(DEFAULT_VECTOR_BY_WALLS_SETTINGS.finishOpening.mode).toBe("none");
  });
});

describe("endpointOuterFaces / floorCellSet (GitHub issue #330)", () => {
  it("has no outer sides for an endpoint that is not on the floor", () => {
    expect(endpointOuterFaces(undefined, new Set(), squareCfg)).toEqual([]);
  });

  it("lists the same sides as listOuterFaces and builds a floor's set once", () => {
    const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const set = floorCellSet(cells);
    expect(floorCellSet(cells)).toBe(set);
    cells.push({ x: 2, y: 0 });
    expect(floorCellSet(cells).has("2,0")).toBe(true);
    expect(endpointOuterFaces(cells[0], set, squareCfg)).toEqual(listOuterFaces([0, 0], set, squareCfg));
  });
});
