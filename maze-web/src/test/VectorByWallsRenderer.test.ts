import { describe, it, expect } from "vitest";
import { viewportWorldRect, buildWallStyle, buildOneWayStyle } from "../pixi/imageExport/VectorByWallsRenderer";
import { TILE_SIZE } from "../pixi/constants";
import type { VectorByWallsSettings } from "../store/storeTypes";

function baseSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0x111111,
    showGrid: true,
    gridColor: 0x222222,
    floorColor: 0x333333,
    wallColor: 0x444444,
    wallJoin: "round",
    wallThickness: 3,
    oneWayPattern: "triangle",
    oneWayColor: 0x555555,
    oneWayBorderWidth: 3,
    oneWaySize: 0.3,
    oneWayThickness: 4,
    oneWayJoin: "round",
    startMarker: { shape: "circle", fillColor: 0, borderColor: 0, borderWidth: 0 },
    finishMarker: { shape: "circle", fillColor: 0, borderColor: 0, borderWidth: 0 },
    ...overrides,
  };
}

describe("viewportWorldRect", () => {
  it("inverts the viewport's screen-space offset and scale into world-space", () => {
    expect(viewportWorldRect({ x: 100, y: 50, w: 800, h: 600, scale: 2 })).toEqual({ x: -50, y: -25, w: 400, h: 300 });
  });
});

describe("buildWallStyle", () => {
  it("maps color/width straight through and derives cap from join", () => {
    expect(buildWallStyle(baseSettings({ wallColor: 0xabc, wallThickness: 7, wallJoin: "round" })))
      .toEqual({ color: 0xabc, width: 7, join: "round", cap: "round" });
  });

  it("derives a square cap for a miter join", () => {
    expect(buildWallStyle(baseSettings({ wallJoin: "miter" })).cap).toBe("square");
  });
});

describe("buildOneWayStyle", () => {
  it("maps pattern/color/borderWidth/thickness straight through", () => {
    const style = buildOneWayStyle(baseSettings({ oneWayPattern: "chevron", oneWayColor: 0xaaa, oneWayBorderWidth: 5, oneWayThickness: 8 }));
    expect(style.pattern).toBe("chevron");
    expect(style.color).toBe(0xaaa);
    expect(style.borderWidth).toBe(5);
    expect(style.thickness).toBe(8);
  });

  it("mirrors floorColor as the border color, independent of oneWayColor", () => {
    const style = buildOneWayStyle(baseSettings({ floorColor: 0xdead00, oneWayColor: 0xbeef00 }));
    expect(style.borderColor).toBe(0xdead00);
  });

  it("scales oneWaySize (a tile fraction) into world-space via TILE_SIZE", () => {
    const style = buildOneWayStyle(baseSettings({ oneWaySize: 0.5 }));
    expect(style.size).toBe(TILE_SIZE * 0.5);
  });

  it("derives a square cap for a miter join, round for round", () => {
    expect(buildOneWayStyle(baseSettings({ oneWayJoin: "miter" })).cap).toBe("square");
    expect(buildOneWayStyle(baseSettings({ oneWayJoin: "round" })).cap).toBe("round");
  });
});
