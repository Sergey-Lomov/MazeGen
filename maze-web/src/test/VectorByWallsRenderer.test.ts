import { describe, it, expect } from "vitest";
import { viewportWorldRect, buildWallStyle, buildOneWayStyle, buildTeleportLineStyle, buildEffectiveSplitNodeColors } from "../pixi/imageExport/VectorByWallsRenderer";
import { TILE_SIZE } from "../pixi/constants";
import { splitSlotColor } from "../pixi/colorUtils";
import { canvas } from "../pixi/colorTokens";
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
    teleportLineCornerStyle: "sharp",
    teleportLineShape: "square",
    teleportLineSize: 0.3,
    teleportEdgeColor: 0,
    teleportEdgeBorderColor: 0,
    teleportEdgeBorderWidth: 3,
    teleportConnectorColor: 0,
    teleportConnectorWidth: 3,
    teleportConnectorStyle: "straight",
    teleportAvoidFieldExit: false,
    teleportArrowMode: "center",
    teleportArrowPeriod: 5,
    teleportArrowSize: 6,
    teleportConnectorBorderWidth: 0,
    teleportGroupCustomization: false,
    teleportGroupOverrides: {},
    splitNodeColors: [],
    splitSpecialShapes: false,
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

describe("buildTeleportLineStyle", () => {
  it("maps line-pattern settings straight through", () => {
    const style = buildTeleportLineStyle(baseSettings({
      teleportLineCornerStyle: "round",
      teleportLineShape: "star",
      teleportLineSize: 0.4,
      teleportEdgeColor: 0x111,
      teleportEdgeBorderColor: 0x112,
      teleportEdgeBorderWidth: 5,
      teleportConnectorColor: 0x222,
      teleportConnectorWidth: 7,
      teleportConnectorStyle: "orthogonal",
      teleportArrowMode: "periodic",
      teleportArrowPeriod: 8,
      teleportArrowSize: 11,
      teleportConnectorBorderWidth: 9,
      floorColor: 0x999,
    }));
    expect(style).toEqual({
      shape: "star", cornerStyle: "round", size: 0.4, edgeColor: 0x111, edgeBorderColor: 0x112, borderWidth: 5,
      connectorColor: 0x222, connectorWidth: 7, connectorStyle: "orthogonal",
      arrowMode: "periodic", arrowPeriod: 8, arrowSize: 11, connectorBorderWidth: 9, floorColor: 0x999,
    });
  });
});

describe("buildEffectiveSplitNodeColors", () => {
  it("an untouched (empty) splitNodeColors falls back to splitSlotColor's own default palette — GitHub issue: colors mismatched panel vs. canvas until first edit", () => {
    const result = buildEffectiveSplitNodeColors([], 2);
    expect(result).toEqual([splitSlotColor(0, canvas.node.splitSlots), splitSlotColor(1, canvas.node.splitSlots)]);
  });

  it("a user-set slot overrides the default, untouched slots still fall back", () => {
    const result = buildEffectiveSplitNodeColors([0xabcdef], 3);
    expect(result).toEqual([0xabcdef, splitSlotColor(1, canvas.node.splitSlots), splitSlotColor(2, canvas.node.splitSlots)]);
  });

  it("returns at least splitNodeColors.length entries even when maxSplit is smaller (e.g. after a maze regenerate shrinks the point)", () => {
    const result = buildEffectiveSplitNodeColors([0x111, 0x222, 0x333], 1);
    expect(result).toEqual([0x111, 0x222, 0x333]);
  });
});

