import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { VectorByWallsSettingsPanel } from "../components/features/VectorByWallsSettingsPanel";
import { VectorByCorridorsSettingsPanel } from "../components/features/VectorByCorridorsSettingsPanel";
import { schemaEntriesFor, type LinkMode } from "../store/parameterLinkSchema";
import type { ParamActivityContext, ParamActivitySettings } from "../store/parameterLinksActivity";
import { DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportDefaults";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";

// GitHub issue #927 — the settings panels are rendered whole, with every section opened, and what
// they actually show is compared to the link schema. This is the check that keeps a panel and the
// schema from drifting apart in either direction: a field the schema declares but the panel lacks,
// a control the panel shows that the schema does not know, and a control whose visibility differs
// from the schema's activity rule. A control is identified by the target of its link-status icon.
//
// Nothing here has to be extended by hand for a new field: the scenarios are generated from the
// `ParamActivityContext` flags (each on its own, all together, all but one) and from the toggle/enum
// settings the activity rules read. A new flag or settings key that is not covered below fails to
// compile (`MAZE_FOR_FLAG`, `SETTING_VALUES`), so the compiler, not memory, asks for the missing case.

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

const spied = vi.hoisted(() => ({
  areaSpread: false,
  model: null as null | { activePaths: Set<string> },
}));

// The cell area statistics come from wasm; the test sets the "cells differ in area" flag directly.
vi.mock("../pixi/markerScale", async (importActual) => ({
  ...(await importActual<typeof import("../pixi/markerScale")>()),
  hasCellAreaSpread: () => spied.areaSpread,
}));

// Every field row renders its link-status icon through this component, so a stub that exposes the
// icon's target reports exactly which fields the panel shows.
vi.mock("../components/LinkStatusIcon", async () => {
  const { createElement: h } = await import("react");
  return {
    // An icon with `onToggleLink` is a derived read-only one (one per edge marker, GitHub issue #729) whose
    // target is a per-instance virtual path, not a schema field.
    LinkStatusIcon: ({ target, onToggleLink }: { target: string | null; onToggleLink?: () => void }) =>
      h("span", { "data-link-icon": "", "data-link-target": target ?? "", "data-link-derived": onToggleLink ? "" : undefined }),
  };
});

// The panels' model hook, wrapped to expose the paths it reports as active.
vi.mock("../components/features/useExportPanelModel", async (importActual) => {
  const actual = await importActual<typeof import("../components/features/useExportPanelModel")>();
  return {
    ...actual,
    useExportPanelModel: (...args: Parameters<typeof actual.useExportPanelModel>) => {
      const model = actual.useExportPanelModel(...args);
      spied.model = model as unknown as { activePaths: Set<string> };
      return model;
    },
  };
});

const MODES: LinkMode[] = ["walls", "corridors"];

/** Opens every collapsed section header (store-driven and local-state ones alike) until none is left. */
function expandEverything(container: HTMLElement) {
  for (let round = 0; round < 40; round++) {
    const collapsed = [...container.querySelectorAll<HTMLElement>('[data-side-panel-clickable="true"]')]
      .filter((header) => header.querySelector("svg.lucide-chevron-right") !== null);
    if (collapsed.length === 0) return;
    act(() => { for (const header of collapsed) fireEvent.click(header); });
  }
  throw new Error("expandEverything: sections keep collapsing");
}

const SECOND_FLOOR = "floor_2";

/** A maze under construction: what a flag's fragment adds to it. */
class MazeBuilder {
  nodes: { id: number; x: number; y: number; i: number; level?: number }[] = [];
  edges: { from: number; to: number; kind: string }[] = [];
  floors = [{ id: TEST_FLOOR_ID, title: "Floor 1" }];
  floorTopology: Record<string, unknown> = {};
  floorCreases: Record<string, unknown> = {};
  areaSpread = false;

  node(level = 0, at?: [number, number]): number {
    const id = this.nodes.length;
    const [x, y] = at ?? [id % 10, Math.floor(id / 10) % 10];
    this.nodes.push({ id, x, y, i: 0, level });
    return id;
  }

  edge(from: number, to: number, kind: string, both = false) {
    this.edges.push({ from, to, kind });
    if (both) this.edges.push({ from: to, to: from, kind });
  }

  secondFloor() {
    if (this.floors.length === 1) this.floors.push({ id: SECOND_FLOOR, title: "Floor 2" });
  }

  /** A pair of nodes on the two floors, for the vertical and cross-floor elements. */
  stackedPair(): [number, number] {
    this.secondFloor();
    return [this.node(0), this.node(1)];
  }

  state() {
    const floorFields = Object.fromEntries(this.floors.map((floor) => [floor.id, baseFloorFieldConfig()]));
    return {
      nodes: this.nodes, edges: this.edges, floors: this.floors, floorFields, activeFloorId: TEST_FLOOR_ID,
      floorTopology: this.floorTopology, floorCreases: this.floorCreases,
    };
  }
}

/** For every maze-derived flag the panels gate on, the part of a maze that makes it true. A flag added to
 *  `ParamActivityContext` must be given one here (the type forces it). */
const MAZE_FOR_FLAG: Record<keyof ParamActivityContext, (maze: MazeBuilder) => void> = {
  hasOneWays: (maze) => maze.edge(maze.node(), maze.node(), "basic"),
  hasTeleports: (maze) => maze.edge(maze.node(), maze.node(), "teleport", true),
  hasCrossFloorTeleports: (maze) => { const [a, b] = maze.stackedPair(); maze.edge(a, b, "teleport", true); },
  hasTwoWayPassages: (maze) => { const [a, b] = maze.stackedPair(); maze.edge(a, b, "vertical_passage", true); },
  hasOneWayPassages: (maze) => { const [a, b] = maze.stackedPair(); maze.edge(a, b, "vertical_passage"); },
  hasElevators: (maze) => { const [a, b] = maze.stackedPair(); maze.edge(a, b, "elevator"); },
  hasVerticalSection: (maze) => { const [a, b] = maze.stackedPair(); maze.edge(a, b, "elevator"); },
  hasMarkerIndexSource: (maze) => maze.edge(maze.node(), maze.node(), "teleport", true),
  hasMultipleFloors: (maze) => maze.secondFloor(),
  hasAreaSpread: (maze) => { maze.areaSpread = true; },
  hasSeams: (maze) => { maze.floorTopology[TEST_FLOOR_ID] = { folds: [{}], groups: [] }; },
  hasSplits: (maze) => { const at: [number, number] = [9, 9]; maze.node(0, at); maze.node(0, at); },
  hasGlues: (maze) => { maze.floorTopology[TEST_FLOOR_ID] = { folds: [], groups: [{ id: 0, folds: [] }] }; },
  hasCreases: (maze) => { maze.floorCreases[TEST_FLOOR_ID] = [{ id: 0, a: [0, 0], b: [2, 0] }]; },
};
const FLAG_NAMES = Object.keys(MAZE_FOR_FLAG) as (keyof ParamActivityContext)[];

const FLAG_COMBOS: { name: string; flags: (keyof ParamActivityContext)[] }[] = [
  { name: "no flag", flags: [] },
  { name: "every flag", flags: FLAG_NAMES },
  ...FLAG_NAMES.map((only) => ({ name: `only ${only}`, flags: [only] })),
  ...FLAG_NAMES.map((except) => ({ name: `every flag but ${except}`, flags: FLAG_NAMES.filter((flag) => flag !== except) })),
];

/** The alternatives of every toggle/enum setting an activity rule reads. A key added to `ParamActivitySettings` must be listed here. */
const SETTING_VALUES: { [K in keyof ParamActivitySettings]-?: NonNullable<ParamActivitySettings[K]>[] } = {
  verticalStyle: ["abstract", "decorative"],
  teleportConnectorStyle: ["none", "straight", "orthogonal", "curved"],
  join: ["round", "miter"],
  renderStyle: ["contour", "legacy_line"],
  teleportGroupCustomization: [true, false],
  showGrid: [true, false],
  showInnerGrid: [true, false],
  showCutLines: [true, false],
  cutLinesGlueColor: [true, false],
  glueTabs: [{ showTabs: true, lineWidth: 2 }, { showTabs: false, lineWidth: 2 }, { showTabs: true, lineWidth: 0 }],
  creases: [{ showCreases: true, mode: "lines" }, { showCreases: true, mode: "marks" }, { showCreases: false, mode: "lines" }],
  edgeMarkers: [{ mode: "all" }, { mode: "hidden" }],
  elevatorBadges: [{ enabled: true }, { enabled: false }, { enabled: true, placement: "full_circle", evenDistribution: true }, { enabled: true, placement: "full_circle", evenDistribution: false }],
  markerIndex: [{ enabled: true }, { enabled: false }, { enabled: true, borderWidthFromMarker: true, borderColorFromMarker: true }, { enabled: true, borderWidthFromMarker: false, borderColorFromMarker: false }],
  teleportArrowMode: ["none", "center", "periodic"],
  splitSpecialShapes: [true, false],
  startMarker: [{ markerEnabled: true, textEnabled: true }, { markerEnabled: true, textEnabled: false }, { markerEnabled: false, textEnabled: true }],
  finishMarker: [{ markerEnabled: true, textEnabled: true }, { markerEnabled: true, textEnabled: false }, { markerEnabled: false, textEnabled: true }],
  floorLabel: [
    { enabled: true, labelMode: "index", backgroundShape: "rectangle" },
    { enabled: true, labelMode: "title", backgroundShape: "none" },
    { enabled: false, labelMode: "index", backgroundShape: "parallelogram" },
  ],
};

interface Scenario {
  name: string;
  flags: (keyof ParamActivityContext)[];
  settings: Partial<ParamActivitySettings>;
}

/** Each flag combination with the default settings, and each settings alternative with every flag and with none. */
const SCENARIOS: Scenario[] = [
  ...FLAG_COMBOS.map((combo) => ({ name: combo.name, flags: combo.flags, settings: {} })),
  ...(Object.entries(SETTING_VALUES) as [keyof ParamActivitySettings, unknown[]][]).flatMap(([key, values]) =>
    values.flatMap((value, index) => FLAG_COMBOS.slice(0, 2).map((combo) => ({
      name: `${key} #${index} with ${combo.name}`, flags: combo.flags, settings: { [key]: value },
    }))),
  ),
];

interface Observation {
  /** Link targets of every rendered icon. */
  rendered: Set<string>;
  /** Paths the panel's own model reports as active. */
  active: Set<string>;
}

function observe(mode: LinkMode, scenario: Scenario): Observation {
  const maze = new MazeBuilder();
  for (const flag of scenario.flags) MAZE_FOR_FLAG[flag](maze);
  spied.areaSpread = maze.areaSpread;
  spied.model = null;
  const defaults = mode === "walls" ? DEFAULT_VECTOR_BY_WALLS_SETTINGS : DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS;
  const settings: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(scenario.settings)) {
    if (!(key in defaults)) continue;
    const current = (defaults as unknown as Record<string, unknown>)[key];
    settings[key] = typeof value === "object" && value !== null && typeof current === "object" ? { ...current, ...value } : value;
  }
  useMazeStore.setState({
    ...baseStoreState(),
    linkIconVisibility: "always",
    ...maze.state(),
    ...(mode === "walls" ? { vectorByWallsSettings: settings } : { vectorByCorridorsSettings: settings }),
  } as never);
  const view = render(createElement(mode === "walls" ? VectorByWallsSettingsPanel : VectorByCorridorsSettingsPanel));
  expandEverything(view.container);
  const rendered = new Set<string>(
    [...view.container.querySelectorAll<HTMLElement>("[data-link-icon]:not([data-link-derived])")]
      .map((icon) => icon.dataset.linkTarget ?? "")
      .filter((target) => target !== ""),
  );
  const model = spied.model as { activePaths: Set<string> } | null;
  const active = new Set<string>(model?.activePaths ?? []);
  view.unmount();
  return { rendered, active };
}

beforeEach(() => {
  useMazeStore.setState({ ...baseStoreState(), linkIconVisibility: "always" } as never);
});

describe.each(MODES)("%s settings panel against the link schema", (mode) => {
  const declared = new Set(schemaEntriesFor(mode).map(([path]) => path as string));

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "shows exactly the fields the schema marks active: %s",
    (_name, scenario) => {
      const { rendered, active } = observe(mode, scenario);
      expect(rendered.size, "the panel rendered no link icon at all").toBeGreaterThan(0);

      const undeclared = [...rendered].filter((path) => !declared.has(path));
      const hiddenButActive = [...declared].filter((path) => active.has(path) && !rendered.has(path));
      const shownButInactive = [...rendered].filter((path) => declared.has(path) && !active.has(path));
      expect({ undeclared, hiddenButActive, shownButInactive }).toEqual({ undeclared: [], hiddenButActive: [], shownButInactive: [] });
    },
  );

  it("every declared field is rendered by the panel in at least one scenario", () => {
    const seen = new Set<string>();
    for (const scenario of SCENARIOS) for (const path of observe(mode, scenario).rendered) seen.add(path);
    expect([...declared].filter((path) => !seen.has(path))).toEqual([]);
  }, 120_000);
});
