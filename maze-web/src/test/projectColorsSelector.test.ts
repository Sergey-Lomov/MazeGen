import { describe, it, expect } from "vitest";
import type { MazeState } from "../store/mazeStore";
import type { NodeDto, EdgeDto } from "../wasm/types";
import { overrideActiveProfileColor, selectActiveProfileColors, resolveColorField, buildColorVisibility, PC } from "../pixi/selectors/projectColorsSelector";
import { STATIC_COLOR_FIELD_KEYS } from "../pixi/colorFieldKeys";
import {
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
} from "../store/slices/imageExportSlice";

/** Minimal `MazeState` fixture — only the fields `selectActiveProfileColors` and its helpers
 *  (`sectionVisibility`, `teleportColors`, etc.) actually read. Mirrors `projectExportKit.ts`'s
 *  `makeState` cast convention rather than filling in the whole store shape. */
function makeState(overrides: Partial<MazeState> = {}): MazeState {
  const base = {
    nodes: [] as NodeDto[],
    edges: [] as EdgeDto[],
    floors: [{ id: "floor_1", title: "Floor 1" }],
    openRenderModeSettings: null,
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
  };
  return { ...base, ...overrides } as unknown as MazeState;
}

function node(id: number, x: number, y: number, level = 0): NodeDto {
  return { id, x, y, i: id, level };
}

function edge(from: number, to: number, kind: EdgeDto["kind"] = "basic"): EdgeDto {
  return { from, to, kind };
}

describe("selectActiveProfileColors", () => {
  it("returns [] when no export settings panel is open", () => {
    const state = makeState({ openRenderModeSettings: null });
    expect(selectActiveProfileColors(state)).toEqual([]);
  });

  it("includes the always-on background/floor colors for vector-by-walls", () => {
    const state = makeState({ openRenderModeSettings: "vector_by_walls" });
    const colors = selectActiveProfileColors(state);
    const names = colors.map((c) => c.name);
    expect(names).toContain(PC.bgFill.name());
    expect(names).toContain(PC.tilesFloor.name());
    expect(colors.find((c) => c.name === PC.bgFill.name())?.color).toBe(
      DEFAULT_VECTOR_BY_WALLS_SETTINGS.background,
    );
  });

  it("includes the always-on background/fill colors for vector-by-corridors", () => {
    const state = makeState({ openRenderModeSettings: "vector_by_corridors" });
    const colors = selectActiveProfileColors(state);
    const names = colors.map((c) => c.name);
    expect(names).toContain(PC.bgFill.name());
    expect(names).toContain(PC.corridorFill.name());
  });

  it("hides the grid color when showGrid is off, shows it when on", () => {
    const withoutGrid = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showGrid: false },
    });
    expect(selectActiveProfileColors(withoutGrid).map((c) => c.name)).not.toContain(PC.bgGrid.name());

    const withGrid = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showGrid: true },
    });
    expect(selectActiveProfileColors(withGrid).map((c) => c.name)).toContain(PC.bgGrid.name());
  });

  it("hides the inner-grid color until its independent toggle is on", () => {
    const withoutInnerGrid = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showInnerGrid: false },
    });
    expect(selectActiveProfileColors(withoutInnerGrid).map((c) => c.name)).not.toContain(PC.innerGrid.name());

    const withInnerGrid = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showInnerGrid: true },
    });
    expect(selectActiveProfileColors(withInnerGrid).map((c) => c.name)).toContain(PC.innerGrid.name());
  });

  it("hides teleport colors entirely when the maze has no teleport edges", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "basic")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).not.toContain(PC.teleportEdge.name());
  });

  it("shows base teleport colors but hides cross-floor badge colors for a same-floor teleport", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.teleportEdge.name());
    expect(names).toContain(PC.teleportEdgeBorder.name());
    expect(names).not.toContain(PC.teleportBadgeFill.name());
  });

  it("shows cross-floor badge colors for a teleport spanning two floors", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0, 0), node(2, 1, 0, 1)],
      edges: [edge(1, 2, "teleport")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.teleportBadgeFill.name());
    expect(names).toContain(PC.teleportBadgeBorder.name());
    expect(names).toContain(PC.teleportBadgeText.name());
  });

  it("hides the connector color when the connector style is none", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, teleportConnectorStyle: "none" },
    });
    expect(selectActiveProfileColors(state).map((c) => c.name)).not.toContain(PC.teleportConnector.name());
  });

  it("orders per-group teleport overrides by 1-based key.localeCompare order, not insertion order", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        teleportGroupCustomization: true,
        // Inserted out of sort order on purpose — the selector must sort keys itself.
        teleportGroupOverrides: {
          "9-9": { fillColor: 0x222222 },
          "1-1": { fillColor: 0x111111 },
        },
      },
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    // "1-1" sorts before "9-9" -> becomes group 1, "9-9" becomes group 2.
    expect(names).toContain(PC.teleportGroup(0, "fill").name());
    expect(names).toContain(PC.teleportGroup(1, "fill").name());
    const group1 = selectActiveProfileColors(state).find((c) => c.name === PC.teleportGroup(0, "fill").name());
    const group2 = selectActiveProfileColors(state).find((c) => c.name === PC.teleportGroup(1, "fill").name());
    expect(group1?.color).toBe(0x111111);
    expect(group2?.color).toBe(0x222222);
  });

  it("omits per-group override colors when group customization is off", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        teleportGroupCustomization: false,
        teleportGroupOverrides: { "1-1": { fillColor: 0x111111 } },
      },
    });
    expect(selectActiveProfileColors(state).map((c) => c.name)).not.toContain(PC.teleportGroup(0, "fill").name());
  });

  it("only emits the override roles actually set (fill without border, and vice versa)", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        teleportGroupCustomization: true,
        teleportGroupOverrides: { "1-1": { fillColor: 0x111111 } },
      },
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.teleportGroup(0, "fill").name());
    expect(names).not.toContain(PC.teleportGroup(0, "border").name());
  });

  it("hides the whole vertical section when the maze has a single floor and no vertical edges", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      floors: [{ id: "floor_1", title: "Floor 1" }],
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "basic")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).not.toContain(PC.twoWayFill.name());
    expect(names).not.toContain(PC.elevatorFill.name());
  });

  it("shows two-way passage colors for a bidirectional vertical_passage edge", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      nodes: [node(1, 0, 0, 0), node(2, 0, 0, 1)],
      edges: [edge(1, 2, "vertical_passage"), edge(2, 1, "vertical_passage")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.twoWayFill.name());
    expect(names).toContain(PC.twoWayArrow.name());
    expect(names).not.toContain(PC.oneWayFill.name());
  });

  it("shows one-way passage colors for a directional vertical_passage edge", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      nodes: [node(1, 0, 0, 0), node(2, 0, 0, 1)],
      edges: [edge(1, 2, "vertical_passage")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.oneWayFill.name());
    expect(names).not.toContain(PC.twoWayFill.name());
  });

  it("switches vertical colors between abstract and decorative styles for vector-by-walls", () => {
    const stateAbstract = makeState({
      openRenderModeSettings: "vector_by_walls",
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      nodes: [node(1, 0, 0, 0), node(2, 0, 0, 1)],
      edges: [edge(1, 2, "elevator")],
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, verticalStyle: "abstract" },
    });
    const abstractNames = selectActiveProfileColors(stateAbstract).map((c) => c.name);
    expect(abstractNames).toContain(PC.elevatorFill.name());
    expect(abstractNames).not.toContain(PC.decorLineElevator.name());
    expect(abstractNames).toContain(PC.verticalFill.name());
    expect(abstractNames).toContain(PC.verticalArrow.name());
    expect(abstractNames).not.toContain(PC.verticalDecorLine.name());

    const stateDecorative = makeState({
      openRenderModeSettings: "vector_by_walls",
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      nodes: [node(1, 0, 0, 0), node(2, 0, 0, 1)],
      edges: [edge(1, 2, "elevator")],
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, verticalStyle: "decorative" },
    });
    const decorativeNames = selectActiveProfileColors(stateDecorative).map((c) => c.name);
    expect(decorativeNames).toContain(PC.decorLineElevator.name());
    expect(decorativeNames).not.toContain(PC.elevatorFill.name());
    expect(decorativeNames).toContain(PC.verticalDecorLine.name());
    expect(decorativeNames).not.toContain(PC.verticalFill.name());
    expect(decorativeNames).not.toContain(PC.verticalArrow.name());
  });

  it("always shows the abstract vertical shared-style colors for vector-by-corridors (no verticalStyle field)", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_corridors",
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      nodes: [node(1, 0, 0, 0), node(2, 0, 0, 1)],
      edges: [edge(1, 2, "elevator")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.verticalFill.name());
    expect(names).toContain(PC.verticalArrow.name());
    expect(names).not.toContain(PC.verticalDecorLine.name());
  });

  it("shows elevator badge colors alongside abstract elevator colors when elevators are present", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      nodes: [node(1, 0, 0, 0), node(2, 0, 0, 1)],
      edges: [edge(1, 2, "elevator")],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.elevatorBadgeFill.name());
    expect(names).toContain(PC.elevatorBadgeText.name());
  });

  it("emits one split-node color entry per slot, using the maze's max stacked-node count", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      nodes: [node(1, 0, 0), node(2, 0, 0), node(3, 0, 0)],
      edges: [],
    });
    const names = selectActiveProfileColors(state).map((c) => c.name);
    expect(names).toContain(PC.splitNode(0).name());
    expect(names).toContain(PC.splitNode(1).name());
    expect(names).toContain(PC.splitNode(2).name());
    expect(names).not.toContain(PC.splitNode(3).name());
  });

  it("hides markerIndex colors when the layer is disabled, shows them (border included) when enabled", () => {
    const disabled = makeState({
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        markerIndex: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex, enabled: false },
      },
    });
    expect(selectActiveProfileColors(disabled).map((c) => c.name)).not.toContain(PC.markerIndexFill.name());

    const enabled = makeState({
      nodes: [node(1, 0, 0), node(2, 1, 0)],
      edges: [edge(1, 2, "teleport")],
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        markerIndex: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex, enabled: true, borderColorFromMarker: false },
      },
    });
    const names = selectActiveProfileColors(enabled).map((c) => c.name);
    expect(names).toContain(PC.markerIndexFill.name());
    expect(names).toContain(PC.markerIndexText.name());
    expect(names).toContain(PC.markerIndexBorder.name());

    const noMarkers = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        markerIndex: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex, enabled: true, borderColorFromMarker: false },
      },
    });
    expect(selectActiveProfileColors(noMarkers).map((c) => c.name)).not.toContain(PC.markerIndexFill.name());
  });

  it("lists start/finish caption colors only while the caption is drawn (textEnabled)", () => {
    const withText = (textEnabled: boolean) => makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, textColor: 0x112233, textEnabled },
        finishMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.finishMarker, textColor: 0x112233, textEnabled },
      },
    });
    const on = selectActiveProfileColors(withText(true)).map((c) => c.name);
    expect(on).toContain(PC.startText.name());
    expect(on).toContain(PC.finishText.name());
    const off = selectActiveProfileColors(withText(false)).map((c) => c.name);
    expect(off).not.toContain(PC.startText.name());
    expect(off).not.toContain(PC.finishText.name());
  });

  it("hides markerIndex border color when it follows the marker color", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        markerIndex: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex, enabled: true, borderColorFromMarker: true },
      },
    });
    expect(selectActiveProfileColors(state).map((c) => c.name)).not.toContain(PC.markerIndexBorder.name());
  });
});

describe("overrideActiveProfileColor", () => {
  it("clones the active profile and changes only the requested field", () => {
    const state = makeState({ openRenderModeSettings: "vector_by_walls" });
    const original = state.vectorByWallsSettings;
    const overridden = overrideActiveProfileColor(state, PC.bgFill.key, 0x123456);
    expect(overridden).not.toBeNull();
    expect(overridden?.background).toBe(0x123456);
    expect(overridden?.gridColor).toBe(original.gridColor);
    expect(state.vectorByWallsSettings).toBe(original);
    expect(original.background).not.toBe(0x123456);
  });

  it("overrides only the inner-grid color", () => {
    const state = makeState({ openRenderModeSettings: "vector_by_walls" });
    const original = state.vectorByWallsSettings;
    const overridden = overrideActiveProfileColor(state, PC.innerGrid.key, 0x123456);
    if (!overridden || !("innerGridColor" in overridden)) throw new Error("Expected vector-by-walls settings");
    expect(overridden.innerGridColor).toBe(0x123456);
    expect(overridden?.gridColor).toBe(original.gridColor);
  });

  it("overrides the active decorative field when its name overlaps the abstract field", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, verticalStyle: "decorative" },
    });
    const original = state.vectorByWallsSettings;
    const overridden = overrideActiveProfileColor(state, PC.decorArrowTwoWay.key, 0x123456);
    expect(overridden).not.toBeNull();
    if (!overridden || !("decorativeStairsArrowColor" in overridden)) throw new Error("Expected vector-by-walls settings");
    expect(overridden?.decorativeStairsArrowColor).toBe(0x123456);
    expect(overridden?.twoWayArrowColor).toBe(original.twoWayArrowColor);
  });

  it("overrides the decorative one-way arrow field without colliding with the abstract one-way arrow field", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, verticalStyle: "decorative" },
    });
    const original = state.vectorByWallsSettings;
    const overridden = overrideActiveProfileColor(state, PC.decorArrowOneWay.key, 0x123456);
    expect(overridden).not.toBeNull();
    if (!overridden || !("decorativeStairsOneWayArrowColor" in overridden)) throw new Error("Expected vector-by-walls settings");
    expect(overridden?.decorativeStairsOneWayArrowColor).toBe(0x123456);
    expect(overridden?.oneWayArrowColor).toBe(original.oneWayArrowColor);
  });

  it("overrides a split color even when the profile still uses the default palette", () => {
    const state = makeState({
      openRenderModeSettings: "vector_by_corridors",
      nodes: [node(1, 0, 0), node(2, 0, 0)],
    });
    const overridden = overrideActiveProfileColor(state, PC.splitNode(1).key, 0x123456);

    expect(overridden).not.toBeNull();
    expect(overridden?.splitNodeColors[1]).toBe(0x123456);
  });
});

// GitHub issue #701 — the shared-style marker fill / border sources are project colors.
describe("shared-style marker colors (GitHub issue #701)", () => {
  it("lists them for both render modes", () => {
    for (const mode of ["vector_by_walls", "vector_by_corridors"] as const) {
      const names = selectActiveProfileColors(makeState({ openRenderModeSettings: mode })).map((c) => c.name);
      expect(names, mode).toContain(PC.sharedMarkerFill.name());
      expect(names, mode).toContain(PC.sharedMarkerBorder.name());
    }
  });

  it("overrideActiveProfileColor rewrites only the targeted source", () => {
    const state = makeState({ openRenderModeSettings: "vector_by_walls" });
    const fill = overrideActiveProfileColor(state, PC.sharedMarkerFill.key, 0x123456);
    expect(fill?.markerFillColor).toBe(0x123456);
    expect(fill?.markerBorderColor).toBe(state.vectorByWallsSettings.markerBorderColor);
    const border = overrideActiveProfileColor(state, PC.sharedMarkerBorder.key, 0x654321);
    expect(border?.markerBorderColor).toBe(0x654321);
    expect(border?.markerFillColor).toBe(state.vectorByWallsSettings.markerFillColor);
  });
});

describe("color field keys (GitHub issue #717)", () => {
  it("every static field's key is its PC property name and resolves back to itself", () => {
    for (const key of STATIC_COLOR_FIELD_KEYS) {
      expect(PC[key].key).toBe(key);
      expect(resolveColorField(key)).toBe(PC[key]);
    }
  });

  it("static field names are unique, so a name collision can never hide a field", () => {
    const names = STATIC_COLOR_FIELD_KEYS.map((key) => PC[key].name());
    expect(new Set(names).size).toBe(names.length);
  });

  it("resolves dynamic split-node and teleport-group keys", () => {
    expect(resolveColorField(PC.splitNode(2).key)?.name()).toBe(PC.splitNode(2).name());
    expect(resolveColorField(PC.teleportGroup(1, "border").key)?.name()).toBe(PC.teleportGroup(1, "border").name());
    expect(resolveColorField("nonsense")).toBeNull();
  });

  it("entries carry their field's key", () => {
    expect(PC.bgGrid.at(0x123456)).toMatchObject({ key: "bgGrid", color: 0x123456 });
  });
});

describe("field visibility predicate (GitHub issue #717)", () => {
  const maze = { nodes: [] as NodeDto[], edges: [] as EdgeDto[], floors: [{ id: "floor_1", title: "Floor 1" }] } as never;

  it("hides start/finish text fields when textEnabled is false, everywhere", () => {
    const settings = {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, textEnabled: false, textColor: 0xffffff },
    };
    const ctx = buildColorVisibility(maze, settings);
    expect(PC.startText.isVisible(ctx)).toBe(false);
    const state = makeState({ openRenderModeSettings: "vector_by_walls", vectorByWallsSettings: settings });
    expect(selectActiveProfileColors(state).map((c) => c.key)).not.toContain("startText");
  });

  it("is mode-aware: floor/wall fields exist only in walls mode, corridor fill only in corridors", () => {
    const walls = buildColorVisibility(maze, DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    const corridors = buildColorVisibility(maze, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS);
    expect(PC.tilesFloor.isVisible(walls)).toBe(true);
    expect(PC.tilesFloor.isVisible(corridors)).toBe(false);
    expect(PC.corridorFill.isVisible(walls)).toBe(false);
    expect(PC.corridorFill.isVisible(corridors)).toBe(true);
  });

  it("gates teleport, split and group-override fields on the maze and settings", () => {
    const ctx = buildColorVisibility(maze, { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, teleportGroupCustomization: true });
    expect(PC.teleportEdge.isVisible(ctx)).toBe(false);
    expect(PC.splitNode(0).isVisible(ctx)).toBe(false);
    expect(PC.teleportGroup(0, "fill").isVisible(ctx)).toBe(false);
  });

  it("gates vertical, decorative and elevator-badge fields by kind, style and badge toggle", () => {
    const elevatorMaze = {
      nodes: [node(0, 0, 0, 0), node(1, 0, 0, 1)],
      edges: [edge(0, 1, "elevator"), edge(1, 0, "elevator")],
      floors: [{ id: "f1", title: "1" }, { id: "f2", title: "2" }],
    } as never;
    const base = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, replaceTwoFloorElevatorsWithStairs: false };
    const abstract = buildColorVisibility(elevatorMaze, base);
    expect(PC.elevatorFill.isVisible(abstract)).toBe(true);
    expect(PC.twoWayFill.isVisible(abstract)).toBe(false);
    expect(PC.decorLineElevator.isVisible(abstract)).toBe(false);

    const decorative = buildColorVisibility(elevatorMaze, { ...base, verticalStyle: "decorative" });
    expect(PC.elevatorFill.isVisible(decorative)).toBe(false);
    expect(PC.decorLineElevator.isVisible(decorative)).toBe(true);
    expect(PC.verticalDecorLine.isVisible(decorative)).toBe(true);

    const badgesOff = buildColorVisibility(elevatorMaze, {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      elevatorBadges: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.elevatorBadges, enabled: false },
    });
    expect(PC.elevatorBadgeFill.isVisible(badgesOff)).toBe(false);
    expect(PC.elevatorBadgeFill.isVisible(abstract)).toBe(
      DEFAULT_VECTOR_BY_WALLS_SETTINGS.elevatorBadges.enabled,
    );
  });

  it("the listing contains exactly the visible static fields", () => {
    for (const mode of ["vector_by_walls", "vector_by_corridors"] as const) {
      const state = makeState({ openRenderModeSettings: mode });
      const settings = mode === "vector_by_walls" ? state.vectorByWallsSettings : state.vectorByCorridorsSettings;
      const ctx = buildColorVisibility(state, settings);
      const listed = new Set(selectActiveProfileColors(state).map((c) => c.key));
      for (const key of STATIC_COLOR_FIELD_KEYS) {
        // A visible field with no value (e.g. unset text color) is legitimately absent.
        if (listed.has(key)) expect(PC[key].isVisible(ctx)).toBe(true);
        else if (PC[key].isVisible(ctx)) expect(["startText", "finishText"]).toContain(key);
      }
    }
  });
});
