import { describe, expect, it } from "vitest";
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
    expect(buildTeleportLineStyle(settings, settings.floorColor)).toEqual(DEFAULT_MAZE_RENDER_STYLE.teleport);
    // `text`/`textEnabled`/`textFontWeight`/`textSize`/`textColor`
    // deliberately diverge (GitHub issue #697, second follow-up): the live canvas stays textless
    // (`DEFAULT_MAZE_RENDER_STYLE` marker text is always `""`, no symbol fields) while the
    // vector-by-walls export defaults to "S"/"F" with the symbol shown — excluded from these two
    // comparisons on purpose.
    expect(buildMarkerStyle(settings.startMarker, settings.floorColor)).toEqual({
      ...DEFAULT_MAZE_RENDER_STYLE.startMarker,
      text: "S",
      textEnabled: false,
      textFontWeight: "bold",
      textSize: DEFAULT_MARKER_TEXT_SIZE, textMargin: 1,
      textColor: settings.startMarker.textColor,
    });
    expect(buildMarkerStyle(settings.finishMarker, settings.floorColor)).toEqual({
      ...DEFAULT_MAZE_RENDER_STYLE.finishMarker,
      text: "F",
      textEnabled: false,
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
