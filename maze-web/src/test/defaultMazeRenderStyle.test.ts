import { describe, expect, it } from "vitest";
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
    expect(buildMarkerStyle(settings.startMarker, settings.floorColor)).toEqual(DEFAULT_MAZE_RENDER_STYLE.startMarker);
    expect(buildMarkerStyle(settings.finishMarker, settings.floorColor)).toEqual(DEFAULT_MAZE_RENDER_STYLE.finishMarker);
    expect(DEFAULT_VERTICAL_STYLE).toBe(DEFAULT_MAZE_RENDER_STYLE.verticalConnections);

    const vertical = buildVerticalConnectionStyle(DEFAULT_VERTICAL_SETTINGS, settings.floorColor);
    expect(vertical.twoWayPassageMarker).toEqual(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker);
    expect(vertical.oneWayPassageMarker).toEqual(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayPassageMarker);
    expect(vertical.elevatorMarker).toEqual(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorMarker);
  });
});
