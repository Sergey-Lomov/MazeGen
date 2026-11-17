import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  STATIC_FIELD_DEFS, STATIC_FIELD_ORDER, buildColorVisibility, visibleColor, unownedColor, writeColorField, isLayoutGateOpen,
} from "../pixi/selectors/colorFieldRegistry";
import type { TeleportGroupOverride } from "../pixi/renderers/types";
import { STATIC_COLOR_FIELD_KEYS, parseColorFieldKey } from "../pixi/colorFieldKeys";
import { PC } from "../pixi/selectors/projectColorsSelector";
import { ColorRow } from "../components/ColorRow";
import { ColorVisibilityProvider, LayoutGate } from "../components/ColorVisibilityContext";
import {
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
} from "../store/slices/imageExportSlice";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const emptyMaze = { nodes: [], edges: [], floors: [{ id: "f", title: "F" }] } as never;

describe("color field registry (GitHub issue #717)", () => {
  it("the display order lists every static key exactly once", () => {
    const ordered = STATIC_FIELD_ORDER.flat();
    expect([...ordered].sort()).toEqual([...STATIC_COLOR_FIELD_KEYS].sort());
  });

  it("every static field's setter writes what its getter reads", () => {
    for (const settings of [DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS]) {
      const ctx = buildColorVisibility(emptyMaze, settings);
      for (const key of STATIC_COLOR_FIELD_KEYS) {
        const clone = structuredClone(settings);
        // A field that doesn't exist in this profile has no value to round-trip.
        if (STATIC_FIELD_DEFS[key].get(clone) === undefined && key !== "startText" && key !== "finishText") continue;
        expect(writeColorField(ctx, clone, key, 0x123456)).toBe(true);
        expect(STATIC_FIELD_DEFS[key].get(clone)).toBe(0x123456);
      }
    }
  });

  it("visibleColor returns the color for a visible field and null for a hidden one", () => {
    const hiddenGrid = buildColorVisibility(emptyMaze, { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showGrid: false });
    expect(visibleColor(hiddenGrid, "bgGrid")).toBeNull();
    const shownGrid = buildColorVisibility(emptyMaze, { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showGrid: true });
    expect(visibleColor(shownGrid, "bgGrid")).toMatchObject({
      value: DEFAULT_VECTOR_BY_WALLS_SETTINGS.gridColor,
      field: "bgGrid",
    });
  });

  it("a split slot without a stored override resolves to the palette color", () => {
    const maze = { nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0, kind: "split", splitCount: 2 }], edges: [], floors: [] } as never;
    const ctx = buildColorVisibility(maze, DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    if (ctx.slotCount > 0) expect(visibleColor(ctx, "splitNode:0")?.field).toBe("splitNode:0");
    expect(visibleColor(ctx, `splitNode:${ctx.slotCount}`)).toBeNull();
  });

  it("an unowned color carries no field", () => {
    expect(unownedColor(0xabcdef)).toMatchObject({ value: 0xabcdef, field: null });
  });
});

describe("marker index availability (GitHub issue #730)", () => {
  const withEdge = (kind: string) => buildColorVisibility(
    { nodes: [], floors: [{ id: "f", title: "F" }], edges: [{ from: 1, to: 2, kind }] as never },
    {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      markerIndex: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex,
        enabled: true,
        coverage: { singleFloorTeleport: false, crossFloorTeleport: false, verticalPassage: false, elevator: false },
      },
    },
  );

  it("is available for any teleport / vertical passage / elevator edge, whatever the coverage", () => {
    for (const kind of ["teleport", "vertical_passage", "elevator"]) {
      const ctx = withEdge(kind);
      expect(ctx.activity.hasMarkerIndexSource).toBe(true);
      expect(PC.markerIndexFill.isVisible(ctx)).toBe(true);
    }
  });

  it("is unavailable without such edges, hiding the layer's colors even when enabled", () => {
    const ctx = withEdge("basic");
    expect(ctx.activity.hasMarkerIndexSource).toBe(false);
    expect(PC.markerIndexFill.isVisible(ctx)).toBe(false);
  });
});

describe("ColorRow visibility gating (GitHub issue #717)", () => {
  const hiddenGridCtx = buildColorVisibility(emptyMaze, { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showGrid: false });
  const shownGridCtx = buildColorVisibility(emptyMaze, { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, showGrid: true });

  it("renders a hidden field's swatch disabled", () => {
    render(
      <ColorVisibilityProvider value={hiddenGridCtx}>
        <ColorRow field={PC.bgGrid} label="Grid" color={0} onChange={() => {}} />
      </ColorVisibilityProvider>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps a visible field's swatch enabled", () => {
    render(
      <ColorVisibilityProvider value={shownGridCtx}>
        <ColorRow field={PC.bgGrid} label="Grid" color={0} onChange={() => {}} />
      </ColorVisibilityProvider>,
    );
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("LayoutGate (GitHub issue #717)", () => {
  const wallsCtx = (verticalStyle: "abstract" | "decorative") => buildColorVisibility(
    {
      nodes: [], floors: [{ id: "f", title: "F" }, { id: "g", title: "G" }],
      edges: [{ from: "a", to: "b", kind: "elevator" }] as never,
    },
    { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, verticalStyle },
  );

  it("opens only the gate matching the vertical style, in step with the color predicates", () => {
    const decorative = wallsCtx("decorative");
    const abstract = wallsCtx("abstract");
    expect([isLayoutGateOpen("verticalDecorative", decorative), isLayoutGateOpen("verticalAbstract", decorative)]).toEqual([true, false]);
    expect([isLayoutGateOpen("verticalDecorative", abstract), isLayoutGateOpen("verticalAbstract", abstract)]).toEqual([false, true]);
    expect(PC.decorLineElevator.isVisible(decorative)).toBe(true);
    expect(PC.elevatorFill.isVisible(decorative)).toBe(false);
  });

  it("renders children only while its gate is open; always outside a panel", () => {
    const { rerender } = render(
      <ColorVisibilityProvider value={wallsCtx("abstract")}><LayoutGate gate="verticalDecorative"><i>x</i></LayoutGate></ColorVisibilityProvider>,
    );
    expect(screen.queryByText("x")).toBeNull();
    rerender(<ColorVisibilityProvider value={wallsCtx("decorative")}><LayoutGate gate="verticalDecorative"><i>x</i></LayoutGate></ColorVisibilityProvider>);
    expect(screen.getByText("x")).toBeTruthy();
    rerender(<LayoutGate gate="verticalAbstract"><i>y</i></LayoutGate>);
    expect(screen.getByText("y")).toBeTruthy();
  });
});

describe("schema-derived color visibility (GitHub issue #965)", () => {
  it("every static field is derived from a schema path, except the two grid colors that keep their own rule", () => {
    const own = STATIC_COLOR_FIELD_KEYS.filter((key) => STATIC_FIELD_DEFS[key].path === undefined);
    expect(own.sort()).toEqual(["bgGrid", "innerGrid"]);
  });

  it("hides a walls-only field in Vector by corridors, whatever the settings say", () => {
    const ctx = buildColorVisibility(emptyMaze, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS);
    expect(visibleColor(ctx, "tilesFloor")).toBeNull();
    expect(visibleColor(ctx, "tilesWall")).toBeNull();
    expect(visibleColor(ctx, "corridorFill")).not.toBeNull();
  });

  it("hides the single wall color while random wall colors replace it", () => {
    const s = structuredClone(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    expect(visibleColor(buildColorVisibility(emptyMaze, s), "tilesWall")).not.toBeNull();
    s.randomWallColorMode = "per_pass";
    expect(visibleColor(buildColorVisibility(emptyMaze, s), "tilesWall")).toBeNull();
  });

  it("hides the floor label border color at zero border width", () => {
    const s = structuredClone(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    s.floorLabel = { ...s.floorLabel, enabled: true, backgroundShape: "rectangle", borderWidth: 2 };
    const twoFloors = { nodes: [], edges: [], floors: [{ id: "a" }, { id: "b" }] } as never;
    expect(visibleColor(buildColorVisibility(twoFloors, s), "floorLabelBorder")).not.toBeNull();
    s.floorLabel.borderWidth = 0;
    expect(visibleColor(buildColorVisibility(twoFloors, s), "floorLabelBorder")).toBeNull();
  });

  it("the activity bridge answers project-wide flags and throws on floor-scoped ones", () => {
    const { activity } = buildColorVisibility({ nodes: [], edges: [], floors: [{ id: "a" }, { id: "b" }], hasGlues: false } as never, DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    expect(activity.hasMultipleFloors).toBe(true);
    // Several floors alone do not make a "Vertical connections" section, unlike the registry's own `vertical` flag.
    expect(activity.hasVerticalSection).toBe(false);
    expect(activity.hasGlues).toBe(false);
    expect(() => activity.hasSeams).toThrow();
    expect(() => activity.hasCreases).toThrow();
    expect(() => activity.hasAreaSpread).toThrow();
  });

  it("an unknown glue state counts as having glues", () => {
    expect(buildColorVisibility(emptyMaze, DEFAULT_VECTOR_BY_WALLS_SETTINGS).activity.hasGlues).toBe(true);
  });

  it("edge marker colour fields, shared and own, need a glue like their panel rows", () => {
    const s = structuredClone(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    s.edgeMarkers = { ...s.edgeMarkers, mode: "all", overrides: { f: { a: { color: 1 } } } };
    const noGlue = buildColorVisibility({ ...(emptyMaze as object), hasGlues: false } as never, s);
    expect(visibleColor(noGlue, "edgeMarker")).toBeNull();
    expect(visibleColor(noGlue, "edgeMarker:f|a")).toBeNull();
    const glued = buildColorVisibility({ ...(emptyMaze as object), hasGlues: true } as never, s);
    expect(visibleColor(glued, "edgeMarker")).not.toBeNull();
    expect(visibleColor(glued, "edgeMarker:f|a")).not.toBeNull();
  });
});

describe("dynamic color field keys (GitHub issue #717)", () => {
  const settings = () => structuredClone({
    ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    teleportGroupCustomization: true,
    teleportGroupOverrides: { "2,2": { fillColor: 0x111111 }, "1,1": { fillColor: 0x333333, borderColor: 0x222222 } },
  });

  it("parses each key family", () => {
    expect(parseColorFieldKey("splitNode:3")).toEqual({ kind: "split", index: 3 });
    expect(parseColorFieldKey("teleportGroup:1:border")).toEqual({ kind: "teleportGroup", index: 1, role: "border" });
    expect(parseColorFieldKey("bgFill")).toEqual({ kind: "static", key: "bgFill" });
  });

  it("writes through to the override at the sorted group index and reports unknown keys", () => {
    const s = settings();
    const ctx = buildColorVisibility(emptyMaze, s);
    expect(writeColorField(ctx, s, "teleportGroup:0:fill", 0xaaaaaa)).toBe(true); // "1,1" sorts first
    expect(s.teleportGroupOverrides["1,1"].fillColor).toBe(0xaaaaaa);
    // A picked color is an explicit value: it breaks the group role's inherited link (GitHub issue #729).
    expect((s.teleportGroupOverrides["1,1"] as TeleportGroupOverride).linkBroken).toMatchObject({ fillColor: true });
    expect(writeColorField(ctx, s, "teleportGroup:5:fill", 1)).toBe(false);
    expect(writeColorField(ctx, s, "splitNode:1", 0xbbbbbb)).toBe(true);
    expect(s.splitNodeColors[1]).toBe(0xbbbbbb);
    expect(writeColorField(ctx, s, "splitNode:4", 0xcccccc)).toBe(true);
    expect(s.splitNodeColors).toHaveLength(5);
    expect(s.splitNodeColors.every((c) => typeof c === "number")).toBe(true);
    expect(writeColorField(ctx, s, "nope", 1)).toBe(false);
  });

  it("edge marker colour fields address a floor's marker by key and break the colour link", () => {
    const s = settings();
    s.edgeMarkers = { ...s.edgeMarkers, mode: "gluings", overrides: { f: { "g2:0": { color: 0x222222 }, "g1:0": { shape: "star" } } } };
    const ctx = buildColorVisibility(emptyMaze, s);
    expect(parseColorFieldKey("edgeMarker:f|g2:0")).toEqual({ kind: "edgeMarker", floorId: "f", markerKey: "g2:0" });
    expect(visibleColor(ctx, "edgeMarker:f|g2:0")?.value).toBe(0x222222);
    expect(visibleColor(ctx, "edgeMarker:f|g1:0")).toBeNull(); // no colour of its own
    expect(writeColorField(ctx, s, "edgeMarker:f|g1:0", 0xabcdef)).toBe(true);
    expect(s.edgeMarkers.overrides.f["g1:0"]).toMatchObject({ color: 0xabcdef, linkBroken: { color: true } });
    expect(writeColorField(ctx, s, "edgeMarker:f|g7:0", 1)).toBe(false);
    expect(writeColorField(ctx, s, "edgeMarker:other|g1:0", 1)).toBe(false);
  });

  it("edge marker colour fields are hidden while the markers are", () => {
    const s = settings();
    s.edgeMarkers = { ...s.edgeMarkers, mode: "hidden", overrides: { f: { a: { color: 1 } } } };
    expect(visibleColor(buildColorVisibility(emptyMaze, s), "edgeMarker:f|a")).toBeNull();
    expect(visibleColor(buildColorVisibility(emptyMaze, s), "edgeMarker")).toBeNull();
  });
});
