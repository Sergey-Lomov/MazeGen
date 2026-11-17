import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TOPOLOGY_WARNING_GROUPS, computeTopologyWarnings as computeWith, type TopologyWarningSettings, type TopologyWarningState } from "../pixi/selectors/topologyWarnings";
import { resetTrackedMemo, setTrackedMemoParanoid, trackedMemoMisses } from "../pixi/selectors/trackedMemo";
import { DEFAULT_EDGE_MARKER_STYLE, DEFAULT_GLUE_TAB_STYLE } from "../store/slices/imageExportDefaults";
import type { EdgeMarkerStyle, GlueTabStyle } from "../store/imageExportTypes";
import { fieldOf } from "./fieldConfigFixtures";

// GitHub issue #928 — the topology warnings are cached per group on the fields they read.

const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const creases = [{ id: 0, a: [0, 0] as const, b: [2, 0] as const }, { id: 1, a: [0, 2] as const, b: [2, 2] as const }];
const state = {
  activeFloorId: "f", activeFieldConfig: cfg, floorTopology: {}, floorCreases: { f: creases }, pngExportSettings: { cuts: { lines: {} } }, nodes: [], edges: [], floors: [],
} as unknown as TopologyWarningState;

const computeTopologyWarnings = (st: TopologyWarningState, settings: TopologyWarningSettings<string>) => computeWith(st, settings, { start: null, finish: null });

const markers = (patch: Partial<EdgeMarkerStyle> = {}): EdgeMarkerStyle => ({ ...DEFAULT_EDGE_MARKER_STYLE, mode: "all", color: 0x808080, ...patch });
const settingsOf = (patch: Partial<TopologyWarningSettings<string>> = {}): TopologyWarningSettings<string> => ({
  glueTabs: { ...DEFAULT_GLUE_TAB_STYLE, showTabs: true }, edgeMarkers: markers(), links: [], background: 0xffffff, ...patch,
});
const slot = (name: string) => `topology:${name}`;

beforeEach(() => {
  resetTrackedMemo();
  setTrackedMemoParanoid(false);
});
afterAll(() => setTrackedMemoParanoid(false));

describe("topology warning groups", () => {
  it("declare disjoint ids, in the order glue tabs, edge marks, seam ambiguity", () => {
    const ids = TOPOLOGY_WARNING_GROUPS.flatMap((group) => group.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOPOLOGY_WARNING_GROUPS.map((group) => group.name)).toEqual(["glueTabs", "edgeMarkers", "seamAmbiguity"]);
  });

  it("every emitted warning is declared by a group", () => {
    const declared = new Set<string>(TOPOLOGY_WARNING_GROUPS.flatMap((group) => group.ids));
    const warnings = computeTopologyWarnings(state, settingsOf());
    expect(warnings.map((warning) => warning.id)).toContain("edge_marker_colors_similar");
    expect(warnings.filter((warning) => !declared.has(warning.id))).toEqual([]);
  });
});

describe("computeTopologyWarnings cache", () => {
  const variants: Record<string, TopologyWarningSettings<string>> = {
    base: settingsOf(),
    sameColor: settingsOf({ edgeMarkers: markers({ color: 0xffffff }) }),
    black: settingsOf({ background: 0, edgeMarkers: markers({ color: 0 }) }),
    noMarkers: settingsOf({ edgeMarkers: markers({ mode: "hidden" }) }),
    glue: settingsOf({ glueTabs: { ...DEFAULT_GLUE_TAB_STYLE, width: 500, inset: 40 } as GlueTabStyle }),
  };

  it("a warm cache gives the answer of a cold run", () => {
    const names = Object.keys(variants);
    setTrackedMemoParanoid(true);
    const warm = names.map((name) => computeTopologyWarnings(state, variants[name]));
    setTrackedMemoParanoid(false);
    names.forEach((name, i) => {
      resetTrackedMemo();
      expect(warm[i], name).toEqual(computeTopologyWarnings(state, variants[name]));
    });
  });

  it("a repeated call with the same inputs recomputes nothing", () => {
    computeTopologyWarnings(state, settingsOf());
    const before = trackedMemoMisses(slot(""));
    computeTopologyWarnings(state, settingsOf());
    expect(trackedMemoMisses(slot("")) - before).toBe(0);
  });

  it("an edit to a field no topology group reads recomputes nothing", () => {
    const base = settingsOf();
    computeTopologyWarnings(state, base);
    const before = trackedMemoMisses(slot(""));
    computeTopologyWarnings(state, { ...base, unrelated: 5 } as TopologyWarningSettings<string>);
    expect(trackedMemoMisses(slot("")) - before).toBe(0);
  });

  it("a glue tab style edit recomputes the glue tab group only", () => {
    const base = settingsOf();
    computeTopologyWarnings(state, base);
    const edgeBefore = trackedMemoMisses(slot("edgeMarkers"));
    const seamBefore = trackedMemoMisses(slot("seamAmbiguity"));
    const glueBefore = trackedMemoMisses(slot("glueTabs"));
    computeTopologyWarnings(state, { ...base, glueTabs: { ...base.glueTabs, width: base.glueTabs.width + 1 } });
    expect(trackedMemoMisses(slot("glueTabs")) - glueBefore).toBe(1);
    expect(trackedMemoMisses(slot("edgeMarkers")) - edgeBefore).toBe(0);
    expect(trackedMemoMisses(slot("seamAmbiguity")) - seamBefore).toBe(0);
  });

  it("an edge mark style edit recomputes the edge mark group and not the glue tab group", () => {
    const base = settingsOf();
    computeTopologyWarnings(state, base);
    const glueBefore = trackedMemoMisses(slot("glueTabs"));
    const edgeBefore = trackedMemoMisses(slot("edgeMarkers"));
    const after = computeTopologyWarnings(state, { ...base, edgeMarkers: markers({ color: 0xffffff }) });
    expect(trackedMemoMisses(slot("edgeMarkers")) - edgeBefore).toBe(1);
    expect(trackedMemoMisses(slot("glueTabs")) - glueBefore).toBe(0);
    expect(after.map((warning) => warning.id)).toEqual(computeTopologyWarnings(state, { ...base, edgeMarkers: markers({ color: 0xffffff }) }).map((warning) => warning.id));
  });

  it("a background edit does not recompute the glue tab group", () => {
    const base = settingsOf();
    computeTopologyWarnings(state, base);
    const glueBefore = trackedMemoMisses(slot("glueTabs"));
    computeTopologyWarnings(state, { ...base, background: 0 });
    expect(trackedMemoMisses(slot("glueTabs")) - glueBefore).toBe(0);
  });

  it("a state change recomputes every group", () => {
    const base = settingsOf();
    computeTopologyWarnings(state, base);
    const before = trackedMemoMisses(slot(""));
    computeTopologyWarnings({ ...state, floorTopology: {} }, base);
    expect(trackedMemoMisses(slot("")) - before).toBe(TOPOLOGY_WARNING_GROUPS.length);
  });
});

describe("computeTopologyWarnings list identity", () => {
  it("returns the same list while every group hits and a new one when one recomputes", () => {
    const base = settingsOf();
    const first = computeTopologyWarnings(state, base);
    expect(computeTopologyWarnings(state, { ...base, unrelated: 1 } as TopologyWarningSettings<string>)).toBe(first);
    expect(computeTopologyWarnings(state, { ...base, edgeMarkers: markers({ color: 0xffffff }) })).not.toBe(first);
  });
});
