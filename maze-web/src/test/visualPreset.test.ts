import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import {
  serializeVisualPreset,
  parseVisualPreset,
  parseAndValidate,
  serializeProject,
  FileKindMismatchError,
  VISUAL_PRESET_KIND,
  VISUAL_PRESET_VERSION,
} from "../store/projectExport";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../store/slices/imageExportSlice";
import { markLinked } from "../store/slices/parameterLinksEngine";
import type { TeleportGroupOverride } from "../pixi/renderers/types";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

const sourcePositions = { floor_1: { mode: "free" as const, x: 1, y: 2 } };
const targetPositions = { floor_1: { mode: "free" as const, x: 7, y: 8 } };
const sourceOverrides = { "1,1": { fillColor: 0x111111 } as TeleportGroupOverride };
const targetOverrides = { "2,2": { fillColor: 0x222222 } as TeleportGroupOverride };

function resetStore() {
  useMazeStore.setState({
    ...baseStoreState(),
    activeRenderMode: null,
    floorLabelModeChosen: true,
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
  });
}

/** Styles the current store as the "source" project and returns its preset, JSON round-tripped. */
function saveSourcePreset() {
  const s = useMazeStore.getState();
  const links = DEFAULT_VECTOR_BY_WALLS_SETTINGS.links.map((l) => (l.target === "finishMarker.size" ? { ...l, enabled: false } : l));
  useMazeStore.setState({
    activeRenderMode: "vector_by_corridors",
    showColorWarnings: false,
    linkIconVisibility: "always",
    vectorByWallsSettings: markLinked({
      ...s.vectorByWallsSettings,
      wallColor: 0x123456,
      links,
      teleportGroupOverrides: sourceOverrides,
      floorLabel: { ...s.vectorByWallsSettings.floorLabel, prefix: "Level ", positionsByFloorId: sourcePositions },
    }),
    vectorByCorridorsSettings: markLinked({ ...s.vectorByCorridorsSettings, color: 0x654321 }),
  });
  return JSON.parse(JSON.stringify(serializeVisualPreset(useMazeStore.getState())));
}

beforeEach(resetStore);

describe("visual preset (GitHub issue #750)", () => {
  it("saves the style without maze-bound data or project sections", () => {
    const raw = saveSourcePreset();
    expect(raw.kind).toBe(VISUAL_PRESET_KIND);
    expect(raw.version).toBe(VISUAL_PRESET_VERSION);
    expect(Object.keys(raw).sort()).toEqual(["imageExport", "kind", "version"]);
    expect(raw.imageExport.vectorByWallsSettings.teleportGroupOverrides).toBeUndefined();
    expect(raw.imageExport.vectorByWallsSettings.floorLabel.positionsByFloorId).toBeUndefined();
    expect(raw.imageExport.vectorByWallsSettings.floorLabel.prefix).toBe("Level ");
    expect(raw.imageExport.vectorByWallsLinks).not.toBeNull();
  });

  it("loading replaces the visual configuration and links, keeping generation and maze-bound settings", () => {
    const raw = saveSourcePreset();
    resetStore();
    const s = useMazeStore.getState();
    useMazeStore.setState({
      seed: 777,
      vectorByWallsSettings: markLinked({
        ...s.vectorByWallsSettings,
        teleportGroupOverrides: targetOverrides,
        floorLabel: { ...s.vectorByWallsSettings.floorLabel, positionsByFloorId: targetPositions },
      }),
    });

    useMazeStore.getState().loadVisualPreset(parseVisualPreset(raw));

    const after = useMazeStore.getState();
    expect(after.seed).toBe(777);
    expect(after.activeRenderMode).toBe("vector_by_corridors");
    expect(after.showColorWarnings).toBe(false);
    expect(after.linkIconVisibility).toBe("always");
    expect(after.vectorByWallsSettings.wallColor).toBe(0x123456);
    expect(after.vectorByCorridorsSettings.color).toBe(0x654321);
    expect(after.vectorByWallsSettings.floorLabel.prefix).toBe("Level ");
    expect(after.vectorByWallsSettings.floorLabel.positionsByFloorId).toEqual(targetPositions);
    expect(after.vectorByWallsSettings.teleportGroupOverrides).toEqual(targetOverrides);
    expect(after.vectorByWallsSettings.links.find((l) => l.target === "finishMarker.size")?.enabled).toBe(false);
  });

  it("loaded links keep propagating", () => {
    const raw = saveSourcePreset();
    resetStore();
    useMazeStore.getState().loadVisualPreset(parseVisualPreset(raw));

    useMazeStore.getState().patchVectorByWallsSharedStyle({ markerSize: 33 });

    const settings = useMazeStore.getState().vectorByWallsSettings;
    expect(settings.startMarker.size).toBe(33);
    expect(settings.finishMarker.size).not.toBe(33);
  });

  it("a preset saved before any render mode was picked keeps the current mode", () => {
    const raw = saveSourcePreset();
    raw.imageExport.activeRenderMode = null;
    resetStore();
    useMazeStore.setState({ activeRenderMode: "vector_by_walls" });

    useMazeStore.getState().loadVisualPreset(parseVisualPreset(raw));

    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
  });

  it("a preset whose floor-label mode was never chosen gets one picked for the current floors", () => {
    const raw = saveSourcePreset();
    raw.imageExport.floorLabelModeChosen = false;
    raw.imageExport.vectorByWallsSettings.floorLabel.labelMode = "index";
    resetStore();
    useMazeStore.setState({ floorLabelModeChosen: false, floors: [{ id: "floor_1", title: "Basement", titleCustomized: true }] });

    useMazeStore.getState().loadVisualPreset(parseVisualPreset(raw));

    const after = useMazeStore.getState();
    expect(after.floorLabelModeChosen).toBe(true);
    expect(after.vectorByWallsSettings.floorLabel.labelMode).toBe("title");
    expect(after.vectorByCorridorsSettings.floorLabel.labelMode).toBe("title");
  });

  it("missing and unknown fields from an older or newer-minor preset fall back to defaults", () => {
    const preset = parseVisualPreset({
      kind: VISUAL_PRESET_KIND,
      version: 1,
      imageExport: { vectorByWallsSettings: { wallColor: 0xabcdef, futureField: 5 }, futureSection: {} },
    });
    expect(preset.imageExport.vectorByWallsSettings.wallColor).toBe(0xabcdef);
    expect(preset.imageExport.vectorByWallsSettings.floorColor).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorColor);
    expect(preset.imageExport.vectorByWallsSettings.links).toEqual(DEFAULT_VECTOR_BY_WALLS_SETTINGS.links);
    expect(preset.imageExport.vectorByCorridorsSettings).toEqual(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS);
    expect(preset.imageExport.pngExportSettings).toEqual(DEFAULT_PNG_EXPORT_SETTINGS);
    expect("futureField" in preset.imageExport.vectorByWallsSettings).toBe(false);
  });

  it("rejects a preset saved by a newer app version", () => {
    expect(() => parseVisualPreset({ kind: VISUAL_PRESET_KIND, version: VISUAL_PRESET_VERSION + 1, imageExport: {} })).toThrow(/newer/);
  });

  it("rejects a project file loaded as a visual preset", () => {
    const project = JSON.parse(JSON.stringify(serializeProject(useMazeStore.getState())));
    expect(() => parseVisualPreset(project)).toThrow(FileKindMismatchError);
  });

  it("rejects a visual preset loaded as a project file", () => {
    const raw = saveSourcePreset();
    expect(() => parseAndValidate(raw)).toThrow(FileKindMismatchError);
  });

  it("rejects unrelated JSON as a visual preset with a plain error", () => {
    expect(() => parseVisualPreset({ foo: 1 })).toThrow("Not a visual preset file");
    expect(() => parseVisualPreset({ foo: 1 })).not.toThrow(FileKindMismatchError);
  });
});
