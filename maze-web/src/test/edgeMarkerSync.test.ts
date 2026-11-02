import { beforeEach, describe, expect, it } from "vitest";
import { fieldOf } from "./fieldConfigFixtures";
import { DEFAULT_EDGE_MARKER_STYLE } from "../store/slices/imageExportDefaults";
import { pruneEdgeMarkerOverrides, syncEdgeMarkers } from "../store/edgeMarkerSync";
import { selectActiveProfileColors } from "../pixi/selectors/projectColorsSelector";

const { useMazeStore } = await import("../store/mazeStore");
const { baseStoreState, TEST_FLOOR_ID } = await import("./storeTestHelpers");

// Edge alignment markers' bookkeeping (GitHub issue #902): per-floor override cleanup, marker order, project colour rows.

const field = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const creases = [{ id: 0, a: [0, 0] as const, b: [2, 0] as const }, { id: 1, a: [0, 2] as const, b: [2, 2] as const }];
const style = (overrides: Record<string, Record<string, { color?: number }>>) => ({ ...DEFAULT_EDGE_MARKER_STYLE, mode: "all" as const, overrides });

function setState(overrides: Record<string, Record<string, { color?: number }>>) {
  const base = baseStoreState();
  const { vectorByWallsSettings, vectorByCorridorsSettings } = useMazeStore.getState();
  useMazeStore.setState({
    ...base,
    floors: [{ id: TEST_FLOOR_ID, title: "F1" }, { id: "up", title: "F2" }],
    floorFields: { [TEST_FLOOR_ID]: { ...base.floorFields[TEST_FLOOR_ID], fieldConfig: field } },
    floorCreases: { [TEST_FLOOR_ID]: creases },
    edgeMarkerOrder: {},
    vectorByWallsSettings: { ...vectorByWallsSettings, edgeMarkers: style(overrides) },
    vectorByCorridorsSettings: { ...vectorByCorridorsSettings, edgeMarkers: style(overrides) },
  } as never);
}

describe("pruneEdgeMarkerOverrides", () => {
  const input = style({ f: { a: { color: 1 }, b: { color: 2 } }, g: { a: { color: 3 } } });

  it("returns the style itself when nothing is stale", () => {
    expect(pruneEdgeMarkerOverrides(input, new Set(["f", "g"]), { floorId: "f", keys: new Set(["a", "b"]) })).toBe(input);
    expect(pruneEdgeMarkerOverrides(input, new Set(["f", "g"]), null)).toBe(input);
  });

  it("drops the vanished keys of the active floor only, and a floor left empty", () => {
    const keysOfA = pruneEdgeMarkerOverrides(input, new Set(["f", "g"]), { floorId: "f", keys: new Set(["a"]) });
    expect(keysOfA.overrides).toEqual({ f: { a: { color: 1 } }, g: { a: { color: 3 } } });
    expect(pruneEdgeMarkerOverrides(input, new Set(["f", "g"]), { floorId: "g", keys: new Set() }).overrides).toEqual({ f: input.overrides.f });
  });

  it("drops the floors that no longer exist", () => {
    expect(pruneEdgeMarkerOverrides(input, new Set(["f"]), null).overrides).toEqual({ f: input.overrides.f });
  });
});

describe("syncEdgeMarkers", () => {
  beforeEach(() => setState({ [TEST_FLOOR_ID]: { c0: { color: 1 }, c9: { color: 2 } }, gone: { c0: { color: 3 } } }));

  it("records the active floor's order and prunes stale overrides of both modes", () => {
    syncEdgeMarkers(useMazeStore);
    const state = useMazeStore.getState();
    expect(state.edgeMarkerOrder).toEqual({ [TEST_FLOOR_ID]: ["c0", "c1"] });
    for (const settings of [state.vectorByWallsSettings, state.vectorByCorridorsSettings]) {
      expect(settings.edgeMarkers.overrides).toEqual({ [TEST_FLOOR_ID]: { c0: { color: 1 } } });
    }
  });

  it("is idempotent", () => {
    syncEdgeMarkers(useMazeStore);
    const before = useMazeStore.getState();
    syncEdgeMarkers(useMazeStore);
    expect(useMazeStore.getState()).toBe(before);
  });

  it("keeps the overrides of a floor whose geometry is not known (inactive floor)", () => {
    setState({ up: { c5: { color: 4 } } });
    syncEdgeMarkers(useMazeStore);
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.overrides).toEqual({ up: { c5: { color: 4 } } });
  });
});

describe("project colour rows of edge markers", () => {
  it("lists every floor's own colours, bottom floor first, numbered by the floor's marker order and labelled with the level", () => {
    setState({ up: { c0: { color: 0x222222 } }, [TEST_FLOOR_ID]: { c1: { color: 0x111111 } } });
    useMazeStore.setState({ openRenderModeSettings: "vector_by_walls", edgeMarkerOrder: { [TEST_FLOOR_ID]: ["c0", "c1"] } } as never);
    const rows = selectActiveProfileColors(useMazeStore.getState()).filter((row) => row.key.startsWith("edgeMarker:"));
    expect(rows.map((row) => row.key)).toEqual([`edgeMarker:${TEST_FLOOR_ID}|c1`, "edgeMarker:up|c0"]);
    expect(rows[0].name).toMatch(/ 2 \(L1\)$/);
    expect(rows[1].name).toMatch(/ 1 \(L2\)$/);
  });
});
