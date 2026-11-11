import { describe, expect, it } from "vitest";
import { isMarkerDrawn, withMarkerVisibility } from "../pixi/selectors/mazeSelectors/markers";
import { DEFAULT_MARKER_TEXT_SIZE } from "../pixi/renderConstants";
import { DEFAULT_MAZE_RENDER_STYLE } from "../pixi/defaultMazeRenderStyle";
import { DEFAULT_VERTICAL_STYLE } from "../pixi/renderers/VerticalConnectionRenderer";
import {
  buildMarkerStyle,
  buildOneWayStyle,
  buildTeleportLineStyle,
  buildVerticalConnectionStyle,
  buildWallStyle,
} from "../pixi/imageExport/exportStyleBuilders";
import {
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VERTICAL_SETTINGS,
} from "../store/slices/imageExportDefaults";

describe("DEFAULT_MAZE_RENDER_STYLE", () => {
  it("is the source of matching live-renderer and vector-by-walls defaults", () => {
    const settings = DEFAULT_VECTOR_BY_WALLS_SETTINGS;

    expect(buildWallStyle(settings)).toEqual(DEFAULT_MAZE_RENDER_STYLE.wall);
    expect(buildOneWayStyle(settings)).toEqual(DEFAULT_MAZE_RENDER_STYLE.oneWay);
    expect(buildTeleportLineStyle(settings, settings.floorColor)).toEqual({
      ...DEFAULT_MAZE_RENDER_STYLE.teleport,
      floorBadge: { ...DEFAULT_MAZE_RENDER_STYLE.teleport.floorBadge, textFontFamily: "" },
    });
    // `text`/`textEnabled`/`textFontWeight`/`textSize`/`textColor`
    // deliberately diverge (GitHub issue #697, second follow-up): the live canvas stays textless
    // (`DEFAULT_MAZE_RENDER_STYLE` marker text is always `""`, no symbol fields) while the
    // vector-by-walls export defaults to "S"/"F" with the symbol shown — excluded from these two
    // comparisons on purpose.
    expect(buildMarkerStyle(settings.startMarker, settings.floorColor)).toEqual({
      ...DEFAULT_MAZE_RENDER_STYLE.startMarker,
      text: "S",
      markerEnabled: true,
      textEnabled: false,
      textFontFamily: "",
      textFontWeight: "bold",
      textSize: DEFAULT_MARKER_TEXT_SIZE, textMargin: 1,
      textColor: settings.startMarker.textColor,
    });
    expect(buildMarkerStyle(settings.finishMarker, settings.floorColor)).toEqual({
      ...DEFAULT_MAZE_RENDER_STYLE.finishMarker,
      text: "F",
      markerEnabled: true,
      textEnabled: false,
      textFontFamily: "",
      textFontWeight: "bold",
      textSize: DEFAULT_MARKER_TEXT_SIZE, textMargin: 1,
      textColor: settings.finishMarker.textColor,
    });
    expect(DEFAULT_VERTICAL_STYLE).toBe(DEFAULT_MAZE_RENDER_STYLE.verticalConnections);

    const vertical = buildVerticalConnectionStyle(DEFAULT_VERTICAL_SETTINGS, settings.floorColor);
    // Vertical markers never expose a Symbol section (GitHub issue #697 scoped it to start/finish
    // only), so `MarkerSettings` defaults for the three vertical kinds carry no `text` field
    // at all — these compare equal to the live-renderer style as-is.
    expect(vertical.twoWayPassageMarker).toEqual(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker);
    expect(vertical.oneWayPassageMarker).toEqual(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayPassageMarker);
    expect(vertical.elevatorMarker).toEqual(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorMarker);
  });
});

describe("isMarkerDrawn (GitHub issue #963)", () => {
  it("needs the marker on and a size or a border; a size 0 marker of a project saved before the toggle is not drawn", () => {
    expect(isMarkerDrawn({ size: 17, borderWidth: 0 })).toBe(true);
    expect(isMarkerDrawn({ size: 0, borderWidth: 2 })).toBe(true);
    expect(isMarkerDrawn({ size: 0, borderWidth: 0 })).toBe(false);
    expect(isMarkerDrawn({ size: 17, borderWidth: 2, markerEnabled: false })).toBe(false);
  });
});

describe("buildMarkerStyle with a hidden marker (GitHub issue #963)", () => {
  it("draws no marker but keeps the caption settings", () => {
    const settings = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, markerEnabled: false, size: 17, borderWidth: 3, gapWidth: 2, textEnabled: true };
    expect(buildMarkerStyle(settings, 0xffffff)).toMatchObject({ size: 0, borderWidth: 0, gapWidth: 0, text: "S", textEnabled: true });
  });
});

describe("withMarkerVisibility (GitHub issue #963)", () => {
  const style = { size: 17, borderWidth: 3, gapWidth: 2 };

  it("keeps a marker that is on or unset", () => {
    expect(withMarkerVisibility(style)).toBe(style);
    expect(withMarkerVisibility({ ...style, markerEnabled: true })).toMatchObject(style);
  });

  it("zeroes size, border and gap of a hidden marker", () => {
    expect(withMarkerVisibility({ ...style, markerEnabled: false })).toMatchObject({ size: 0, borderWidth: 0, gapWidth: 0 });
  });
});
