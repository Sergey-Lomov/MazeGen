import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeVectorByWallsWarningsAcrossFloors, computeVectorByCorridorsWarningsAcrossFloors,
  computeTextFitItemsAcrossFloors, type ExportWarning,
} from "../pixi/selectors/exportWarnings";
import { WALLS_WARNING_GROUPS, CORRIDORS_WARNING_GROUPS, type WarningGroup } from "../pixi/selectors/exportWarningGroups";
import { getTrackedMemoStats, resetTrackedMemo, setTrackedMemoParanoid, trackedMemoMisses } from "../pixi/selectors/trackedMemo";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../store/storeTypes";
import { corridorsSettings, squareCfg, twoFloorMaze, wallsSettings } from "./exportWarningFixtures";

// GitHub issue #928 — export warnings recompute only when their dependencies change.

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const maze = twoFloorMaze();
const NO_CUTS: ReadonlySet<string> = new Set();

const byKey = (warnings: ExportWarning[]) => [...warnings].sort((a, b) => a.key.localeCompare(b.key));

beforeEach(() => {
  resetTrackedMemo();
  setTrackedMemoParanoid(false);
});
afterAll(() => setTrackedMemoParanoid(false));

const wallsBase = wallsSettings();
const corridorsBase = corridorsSettings();
const withText = { ...wallsBase.startMarker, text: "A VERY LONG CAPTION", textEnabled: true, size: 6 };

/** `value` with every color field (and the background) set to one color — the strongest way to trip the contrast checks. */
function recolor<T>(value: T, color: number): T {
  if (Array.isArray(value)) return value.map((item) => recolor(item, color)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "links" ? item : typeof item === "number" && /(color|background)$/i.test(key) ? color : recolor(item, color),
  ])) as T;
}

/** Settings that make different warnings fire, each a single deviation from the defaults. */
const wallsVariants: Record<string, VectorByWallsSettings> = {
  default: wallsBase,
  invisibleTeleport: wallsSettings({ teleportMarker: { ...wallsBase.teleportMarker, borderWidth: 0 } }),
  noConnectors: wallsSettings({ teleportConnectorStyle: "none" }),
  noConnectorsUnmerged: wallsSettings({ teleportConnectorStyle: "none", teleportMergeMode: false }),
  noConnectorGap: wallsSettings({ teleportConnectorGapWidth: 0 }),
  groupCustomization: wallsSettings({
    teleportGroupCustomization: true, teleportConnectorStyle: "none",
    teleportGroupOverrides: { a: { fillColor: 0x00ff00, borderColor: 0x00ff00, shape: "circle" } },
  }),
  plainSplits: wallsSettings({ splitSpecialShapes: false }),
  captions: wallsSettings({ startMarker: withText, finishMarker: { ...withText, text: "END" } }),
  bigBadges: wallsSettings({ elevatorBadges: { ...wallsBase.elevatorBadges, enabled: true, size: 14, distance: 0, gap: 0 } }),
  noBadges: wallsSettings({ elevatorBadges: { ...wallsBase.elevatorBadges, enabled: false } }),
  markerIndex: wallsSettings({ markerIndex: { ...wallsBase.markerIndex, enabled: true, width: 6, height: 6, textSize: 30, offset: 0 } }),
  floorLabel: wallsSettings({ floorLabel: { ...wallsBase.floorLabel, enabled: true, width: 5, height: 5, textSize: 40 } }),
  sameColors: wallsSettings({ background: 0xffffff, floorColor: 0xffffff, wallColor: 0xffffff, gridColor: 0xffffff, oneWayColor: 0xffffff, teleportConnectorColor: 0xffffff }),
  glueTabs: wallsSettings({ glueTabs: { ...wallsBase.glueTabs, showTabs: true, lineColor: 0xffffff, fillColor: 0xffffff } }),
  innerGrid: wallsSettings({ showInnerGrid: true, innerGridColor: 0 }),
  allWhite: recolor(wallsBase, 0xffffff),
  allBlack: recolor(wallsBase, 0),
  similarSplitColors: { ...recolor(wallsBase, 0), splitNodeColors: [0, 0x010101] },
  decorativeVertical: { ...recolor(wallsBase, 0xffffff), verticalStyle: "decorative" },
};

const corridorsVariants: Record<string, VectorByCorridorsSettings> = {
  default: corridorsBase,
  invisibleTeleport: corridorsSettings({ teleportMarker: { ...corridorsBase.teleportMarker, borderWidth: 0 } }),
  noConnectors: corridorsSettings({ teleportConnectorStyle: "none" }),
  noConnectorGap: corridorsSettings({ teleportConnectorGapWidth: 0 }),
  plainSplits: corridorsSettings({ splitSpecialShapes: false }),
  widen: corridorsSettings({ markerWidenPadding: 20 }),
  overflowingArrows: corridorsSettings({ oneWayWidth: 2, oneWayCount: 4, oneWayLength: 3 }),
  thickSplits: corridorsSettings({ thickness: 30, splitGapWidth: 10 }),
  captions: corridorsSettings({ startMarker: withText, finishMarker: { ...withText, text: "END" } }),
  markerIndex: corridorsSettings({ markerIndex: { ...corridorsBase.markerIndex, enabled: true, width: 6, height: 6, textSize: 30, offset: 0 } }),
  floorLabel: corridorsSettings({ floorLabel: { ...corridorsBase.floorLabel, enabled: true, width: 5, height: 5, textSize: 40 } }),
  sameColors: corridorsSettings({ background: 0xffffff, color: 0xffffff, gridColor: 0xffffff, oneWayColor: 0xffffff, teleportConnectorColor: 0xffffff }),
  allWhite: recolor(corridorsBase, 0xffffff),
  allBlack: recolor(corridorsBase, 0),
  similarSplitColors: { ...recolor(corridorsBase, 0), splitNodeColors: [0, 0x010101] },
};

const idsOf = (groups: readonly Pick<WarningGroup, "ids">[]) => groups.flatMap((group) => group.ids);

describe("warning groups", () => {
  it.each([["walls", WALLS_WARNING_GROUPS], ["corridors", CORRIDORS_WARNING_GROUPS]] as const)("%s: names are unique and a warning id belongs to one group", (_mode, groups) => {
    const names = groups.map((group) => group.name);
    expect(new Set(names).size).toBe(names.length);
    const ids = idsOf(groups);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe("a warm cache gives the answer of a cold run", () => {
  const emitted = { walls: new Set<string>(), corridors: new Set<string>() };

  /** Runs `variants` in order against one warm cache (paranoid: every hit is recomputed and compared), each result checked against a cold run. */
  function checkSequence<S extends object>(
    variants: Record<string, S>, compute: (settings: S, cut: ReadonlySet<string>, hasGlues: boolean) => ExportWarning[], sink: Set<string>, hasGlues: boolean,
  ) {
    const runs = [NO_CUTS, new Set(["f0"])].flatMap((cut) => Object.entries(variants).map(([name, settings]) => ({ label: `${name} cut=${[...cut]}`, settings, cut })));
    setTrackedMemoParanoid(true);
    const warmResults = runs.map(({ settings, cut }) => compute(settings, cut, hasGlues));
    setTrackedMemoParanoid(false);
    runs.forEach(({ label, settings, cut }, i) => {
      resetTrackedMemo();
      expect(byKey(warmResults[i]), label).toEqual(byKey(compute(settings, cut, hasGlues)));
      for (const warning of warmResults[i]) sink.add(warning.id);
    });
  }

  it.each([[false], [true]])("walls, every variant, glues %s", (hasGlues) => {
    checkSequence(wallsVariants, (settings, cut, glues) => (
      computeVectorByWallsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, settings, maze.start, maze.finish, cut, glues)
    ), emitted.walls, hasGlues);
  });

  it.each([[false], [true]])("corridors, every variant, glues %s", (hasGlues) => {
    checkSequence(corridorsVariants, (settings, cut, glues) => (
      computeVectorByCorridorsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, settings, maze.start, maze.finish, cut, glues)
    ), emitted.corridors, hasGlues);
  });

  it("the fixtures exercise many warnings, each declared by a group of its mode", () => {
    expect(emitted.walls.size).toBeGreaterThan(25);
    expect(emitted.corridors.size).toBeGreaterThan(20);
    const wallsIds = new Set<string>(idsOf(WALLS_WARNING_GROUPS));
    const corridorsIds = new Set<string>(idsOf(CORRIDORS_WARNING_GROUPS));
    expect([...emitted.walls].filter((id) => !wallsIds.has(id))).toEqual([]);
    expect([...emitted.corridors].filter((id) => !corridorsIds.has(id))).toEqual([]);
  });

  it("lists warnings group by group, in the groups' order", () => {
    const order = new Map(WALLS_WARNING_GROUPS.flatMap((group, index) => group.ids.map((id) => [id, index] as const)));
    const settings = wallsVariants.allWhite;
    const warnings = computeVectorByWallsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, settings, maze.start, maze.finish);
    const groupIndexes = warnings.map((warning) => order.get(warning.id)!);
    expect(groupIndexes.length).toBeGreaterThan(3);
    expect(groupIndexes).toEqual([...groupIndexes].sort((a, b) => a - b));
    expect(computeVectorByWallsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, settings, maze.start, maze.finish)).toEqual(warnings);
  });
});

describe("recomputation", () => {
  const walls = (settings: VectorByWallsSettings, overrides: { nodes?: typeof maze.nodes; floors?: typeof maze.floors; cut?: ReadonlySet<string>; hasGlues?: boolean } = {}) =>
    computeVectorByWallsWarningsAcrossFloors(
      overrides.nodes ?? maze.nodes, maze.edges, overrides.floors ?? maze.floors, squareCfg, settings, maze.start, maze.finish, overrides.cut ?? NO_CUTS, overrides.hasGlues ?? true,
    );
  const misses = (slot: string) => getTrackedMemoStats().get(slot)?.misses ?? 0;
  const richWalls = wallsSettings({
    teleportConnectorStyle: "orthogonal", markerIndex: { ...wallsBase.markerIndex, enabled: true }, floorLabel: { ...wallsBase.floorLabel, enabled: true },
    startMarker: withText,
  });

  it("an unrelated settings edit (a connector control point drag) recomputes no group", () => {
    walls(richWalls);
    const before = trackedMemoMisses();
    for (let i = 0; i < 50; i++) {
      const dragged = { ...richWalls, manualTeleportConnectorPaths: { a: { nodes: [[i, 0]] } } } as unknown as VectorByWallsSettings;
      walls(dragged);
    }
    expect(trackedMemoMisses() - before).toBe(0);
  });

  it("a color edit recomputes the groups that read it but not text fit or geometry", () => {
    walls(richWalls);
    const before = new Map(getTrackedMemoStats());
    const snapshot = new Map([...before].map(([slot, entry]) => [slot, entry.misses]));
    walls({ ...richWalls, gridColor: 0x123456 });
    const missed = [...getTrackedMemoStats()].filter(([slot, entry]) => entry.misses > (snapshot.get(slot) ?? 0)).map(([slot]) => slot);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((slot) => slot.startsWith("walls:contrast.grid:"))).toBe(true);
  });

  it("a text size edit recomputes the text overflow group only", () => {
    walls(richWalls);
    const before = trackedMemoMisses();
    walls({ ...richWalls, startMarker: { ...richWalls.startMarker, textSize: 5 } });
    const missed = [...getTrackedMemoStats()].filter(([, entry]) => entry.lastMiss?.startsWith("startMarker")).map(([slot]) => slot);
    expect(trackedMemoMisses() - before).toBeGreaterThan(0);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((slot) => slot.startsWith("walls:textOverflow:") || slot.startsWith("walls:contrast.") || slot.includes("Overlap"))).toBe(true);
  });

  it("a floor title edit recomputes the text overflow group alone", () => {
    walls(richWalls);
    const before = trackedMemoMisses();
    walls(richWalls, { floors: [{ id: "f0", title: "Renamed" }, { id: "f1", title: "Upper" }] });
    expect(trackedMemoMisses() - before).toBe(1);
    expect(misses("walls:textOverflow:f0")).toBe(2);
  });

  it("equal-valued new cut sets and floor arrays hit the cache", () => {
    walls(richWalls, { cut: new Set(["f0"]) });
    const before = trackedMemoMisses();
    walls(richWalls, { cut: new Set(["f0"]), floors: maze.floors.map((floor) => ({ ...floor })) });
    expect(trackedMemoMisses() - before).toBe(0);
  });

  it("a cut line on a floor recomputes only the split color groups of that floor", () => {
    walls(richWalls);
    const before = trackedMemoMisses();
    walls(richWalls, { cut: new Set(["f0"]) });
    expect(trackedMemoMisses() - before).toBe(1);
    expect(misses("walls:splitContrast:f0")).toBe(2);
  });

  it("a new maze or glue state recomputes every group", () => {
    walls(richWalls);
    const slots = getTrackedMemoStats().size;
    const before = trackedMemoMisses();
    walls(richWalls, { nodes: [...maze.nodes] });
    expect(trackedMemoMisses() - before).toBe(slots);
    const afterMaze = trackedMemoMisses();
    walls(richWalls, { nodes: [...maze.nodes], hasGlues: false });
    expect(trackedMemoMisses() - afterMaze).toBe(slots);
  });

  it("the two modes do not evict each other", () => {
    walls(richWalls);
    computeVectorByCorridorsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, corridorsBase, maze.start, maze.finish);
    const before = trackedMemoMisses();
    walls(richWalls);
    computeVectorByCorridorsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, corridorsBase, maze.start, maze.finish);
    expect(trackedMemoMisses() - before).toBe(0);
  });

  it("text fit items are reused until a field they read changes", () => {
    const items = () => computeTextFitItemsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, richWalls, maze.start, maze.finish);
    const first = items();
    const dragged = { ...richWalls, manualTeleportConnectorPaths: { a: { nodes: [[1, 0]] } }, gridColor: 5 } as unknown as VectorByWallsSettings;
    expect(computeTextFitItemsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, dragged, maze.start, maze.finish)).toBe(first);
    const edited = { ...richWalls, startMarker: { ...richWalls.startMarker, text: "X" } };
    const next = computeTextFitItemsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, edited, maze.start, maze.finish);
    expect(next).not.toBe(first);
    expect(next.start.map((item) => item.text)).toEqual(["X"]);
  });
});

describe("merged list identity", () => {
  it("is the same list while every group hits and a new one when a group recomputes", () => {
    const run = (settings: VectorByWallsSettings) => computeVectorByWallsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, settings, maze.start, maze.finish);
    const first = run(wallsBase);
    expect(run({ ...wallsBase, manualTeleportConnectorPaths: { a: { nodes: [[1, 0]] } } } as unknown as VectorByWallsSettings)).toBe(first);
    expect(run({ ...wallsBase, gridColor: 0x123456 })).not.toBe(first);
  });

  it("keeps each mode's list apart", () => {
    const walls = computeVectorByWallsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, wallsBase, maze.start, maze.finish);
    const corridors = computeVectorByCorridorsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, corridorsBase, maze.start, maze.finish);
    expect(computeVectorByWallsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, wallsBase, maze.start, maze.finish)).toBe(walls);
    expect(computeVectorByCorridorsWarningsAcrossFloors(maze.nodes, maze.edges, maze.floors, squareCfg, corridorsBase, maze.start, maze.finish)).toBe(corridors);
  });
});
