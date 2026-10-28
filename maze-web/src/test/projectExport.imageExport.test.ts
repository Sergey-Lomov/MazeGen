import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../store/slices/imageExportSlice";
import { makeState, toJson } from "./projectExportKit";

describe("parseAndValidate — imageExport (GitHub issue #295)", () => {
  it("defaults activeRenderMode/openRenderModeSettings/vectorByWallsSettings/vectorByWallsSectionsExpanded for a project file saved before this section existed", () => {
    const raw = toJson(makeState());
    delete raw.imageExport;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport).toEqual({
    activeRenderMode: null,
    openRenderModeSettings: null,
      showColorWarnings: true,
      linkIconVisibility: "linked",
      vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      vectorByWallsSectionsExpanded: {},
      vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      vectorByCorridorsSectionsExpanded: {},
      pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
      floorLabelModeChosen: false,
      vectorByWallsLinks: null,
      vectorByCorridorsLinks: null,
    });
  });

  it("round-trips pngExportSettings", () => {
    const settings = {
      outputMode: "print" as const,
      digital: { ...DEFAULT_PNG_EXPORT_SETTINGS.digital, scale: 4, canvasMode: "fixed_size" as const, fixedWidth: 800, fixedHeight: 600 },
      print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, paperSize: "a3" as const, orientation: "landscape" as const, anchor: "top_left" as const },
    };
    const state = makeState({ pngExportSettings: settings });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport.pngExportSettings).toEqual(settings);
  });

  it("defaults pngExportSettings fields to their own defaults when malformed, without throwing", () => {
    const raw = toJson(makeState());
    raw.imageExport.pngExportSettings = {
      outputMode: "not-a-mode",
      digital: { scale: "not-a-number", canvasMode: "not-a-mode" },
      print: { density: "not-a-density", paperSize: "not-a-size" },
    };
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.pngExportSettings).toEqual(DEFAULT_PNG_EXPORT_SETTINGS);
  });

  it("degrades a completely missing pngExportSettings to defaults", () => {
    const raw = toJson(makeState());
    delete raw.imageExport.pngExportSettings;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.pngExportSettings).toEqual(DEFAULT_PNG_EXPORT_SETTINGS);
  });

  it("round-trips vectorByWallsSectionsExpanded", () => {
    const state = makeState({ vectorByWallsSectionsExpanded: { background: true, tiles: false } });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport.vectorByWallsSectionsExpanded).toEqual({ background: true, tiles: false });
  });

  it("degrades an unknown/future activeRenderMode and openRenderModeSettings to null instead of throwing", () => {
    const state = makeState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    const raw = toJson(state);
    raw.imageExport.activeRenderMode = "some_future_mode";
    raw.imageExport.openRenderModeSettings = "some_future_mode";
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.activeRenderMode).toBeNull();
    expect(reparsed.imageExport.openRenderModeSettings).toBeNull();
  });

  it("round-trips a non-default vectorByWallsSettings", () => {
    const state = makeState({
      activeRenderMode: "vector_by_walls",
      openRenderModeSettings: "vector_by_walls",
      vectorByWallsSettings: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
        floorColor: 0x123456,
        wallThickness: 7,
        teleportGroupOverrides: { g1: { fillColor: 0xabcdef, shape: "star" } },
        floorLabel: {
          ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
          positionsByFloorId: {
            floor_1: { mode: "cell", cell: [2, 3] },
            floor_2: { mode: "free", x: -12.5, y: 40 },
          },
        },
      },
    });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.imageExport).toEqual(serialized.imageExport);
  });

  it("keeps valid floor-label positions and discards malformed entries", () => {
    const raw = toJson(makeState());
    raw.imageExport.vectorByWallsSettings.floorLabel.positionsByFloorId = {
      anchored: { mode: "anchored", anchor: "bottom_right" },
      cell: { mode: "cell", cell: [-2, 7] },
      free: { mode: "free", x: 1.5, y: -3.25 },
      bad_anchor: { mode: "anchored", anchor: "outside" },
      fractional_cell: { mode: "cell", cell: [1.5, 2] },
      incomplete_free: { mode: "free", x: 1 },
      unknown: { mode: "future" },
    };
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.vectorByWallsSettings.floorLabel.positionsByFloorId).toEqual({
      anchored: { mode: "anchored", anchor: "bottom_right" },
      cell: { mode: "cell", cell: [-2, 7] },
      free: { mode: "free", x: 1.5, y: -3.25 },
    });
  });

  it("omits vectorByWallsLinks/vectorByCorridorsLinks when links are untouched (GitHub issue #651)", () => {
    const serialized = serializeProject(makeState());
    expect(serialized.imageExport.vectorByWallsLinks).toBeNull();
    expect(serialized.imageExport.vectorByCorridorsLinks).toBeNull();
  });

  it("persists vectorByWallsSettings.links verbatim when it deviates from the defaults, and round-trips it", () => {
    const disabled = DEFAULT_VECTOR_BY_WALLS_SETTINGS.links.map((l) => (l.target === "startMarker.size" ? { ...l, enabled: false } : l));
    const state = makeState({ vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, links: disabled } });
    const serialized = serializeProject(state);
    expect(serialized.imageExport.vectorByWallsLinks).not.toBeNull();
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    const link = reparsed.imageExport.vectorByWallsSettings.links.find((l) => l.target === "startMarker.size");
    expect(link?.enabled).toBe(false);
  });

  it("persists a color link's colorModifiers chain and round-trips it (GitHub issue #667)", () => {
    const colorLink = {
      id: "color-link-1",
      source: "startMarker.fillColor" as const,
      target: "startMarker.borderColor" as const,
      enabled: true,
      colorModifiers: [{ model: "oklch" as const, channel: "oklch-l" as const, op: "mul" as const, value: 1.5 }],
    };
    const links = [...DEFAULT_VECTOR_BY_WALLS_SETTINGS.links.filter((l) => l.target !== colorLink.target), colorLink];
    const state = makeState({ vectorByWallsSettings: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, links } });
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    const link = reparsed.imageExport.vectorByWallsSettings.links.find((l) => l.target === colorLink.target);
    expect(link?.colorModifiers).toEqual(colorLink.colorModifiers);
  });

  it("drops a malformed colorModifier step (unknown channel) but keeps the link, falling back to no chain", () => {
    const raw = toJson(makeState());
    const base = DEFAULT_VECTOR_BY_WALLS_SETTINGS.links.find((l) => l.target !== "startMarker.size") ?? DEFAULT_VECTOR_BY_WALLS_SETTINGS.links[0];
    raw.imageExport.vectorByWallsLinks = [
      { ...base, source: "startMarker.fillColor", target: "startMarker.borderColor", colorModifiers: [{ model: "oklch", channel: "not-a-channel", op: "mul", value: 1.5 }] },
    ];
    const reparsed = parseAndValidate(raw);
    const link = reparsed.imageExport.vectorByWallsSettings.links.find((l) => l.target === "startMarker.borderColor");
    expect(link).toBeDefined();
    expect(link?.colorModifiers).toBeUndefined();
  });

  it("an absent vectorByWallsLinks section (pre-#651 project file) reads the current defaults", () => {
    const raw = toJson(makeState());
    delete raw.imageExport.vectorByWallsLinks;
    delete raw.imageExport.vectorByCorridorsLinks;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.vectorByWallsSettings.links).toEqual(DEFAULT_VECTOR_BY_WALLS_SETTINGS.links);
    expect(reparsed.imageExport.vectorByCorridorsSettings.links).toEqual(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.links);
  });

  it("falls back to the defaults when a persisted links array is structurally invalid (duplicate target), without throwing", () => {
    const raw = toJson(makeState());
    const base = DEFAULT_VECTOR_BY_WALLS_SETTINGS.links[0];
    raw.imageExport.vectorByWallsLinks = [{ ...base, id: "dup-1" }, { ...base, id: "dup-2" }];
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.vectorByWallsSettings.links).toEqual(DEFAULT_VECTOR_BY_WALLS_SETTINGS.links);
  });

  it("defaults the optional inner grid for projects saved before it existed", () => {
    const raw = toJson(makeState());
    delete raw.imageExport.vectorByWallsSettings.showInnerGrid;
    delete raw.imageExport.vectorByWallsSettings.innerGridColor;
    const settings = parseAndValidate(raw).imageExport.vectorByWallsSettings;
    expect(settings.showInnerGrid).toBe(false);
    expect(settings.innerGridColor).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.innerGridColor);
  });

  it("falls back per-field to defaults when vectorByWallsSettings is malformed, without throwing", () => {
    const raw = toJson(makeState());
    raw.imageExport.vectorByWallsSettings = {
      floorColor: "not-a-number",
      wallJoin: "bevel",
      startMarker: { shape: "not-a-shape" },
      splitNodeColors: "not-an-array",
      teleportGroupOverrides: { g1: { shape: "not-a-shape", fillColor: "nope" }, g2: { fillColor: 0x111111 } },
    };
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport.vectorByWallsSettings.floorColor).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorColor);
    expect(reparsed.imageExport.vectorByWallsSettings.wallJoin).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallJoin);
    expect(reparsed.imageExport.vectorByWallsSettings.startMarker.shape).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker.shape);
    expect(reparsed.imageExport.vectorByWallsSettings.splitNodeColors).toEqual([]);
    expect(reparsed.imageExport.vectorByWallsSettings.teleportGroupOverrides).toEqual({ g1: {}, g2: { fillColor: 0x111111 } });
  });

  it("treats a non-object vectorByWallsSettings/imageExport as absent rather than throwing", () => {
    const raw = toJson(makeState());
    raw.imageExport = "not-an-object";
    const reparsed = parseAndValidate(raw);
    expect(reparsed.imageExport).toEqual({
      activeRenderMode: null,
      openRenderModeSettings: null,
      showColorWarnings: true,
      linkIconVisibility: "linked",
      vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      vectorByWallsSectionsExpanded: {},
      vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      vectorByCorridorsSectionsExpanded: {},
      pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
      floorLabelModeChosen: false,
      vectorByWallsLinks: null,
      vectorByCorridorsLinks: null,
    });
  });
});