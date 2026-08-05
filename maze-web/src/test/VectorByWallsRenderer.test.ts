import { describe, it, expect } from "vitest";
import { viewportWorldRect, buildWallStyle, buildOneWayStyle, buildTeleportLineStyle, buildEffectiveSplitNodeColors, buildMarkerStyle, resolveEffectiveEndpoints } from "../pixi/imageExport/VectorByWallsRenderer";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto } from "../wasm/types";
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
    oneWayGapWidth: 3,
    oneWaySize: 0.3,
    oneWayThickness: 4,
    oneWayJoin: "round",
    startMarker: { shape: "circle", cornerStyle: "sharp", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225 },
    finishMarker: { shape: "circle", cornerStyle: "sharp", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225 },
    teleportLineCornerStyle: "sharp",
    teleportLineShape: "square",
    teleportLineSize: 0.3,
    teleportEdgeColor: 0,
    teleportEdgeBorderColor: 0,
    teleportEdgeBorderWidth: 3,
    teleportEdgeGapWidth: 0,
    teleportConnectorColor: 0,
    teleportConnectorWidth: 3,
    teleportConnectorStyle: "straight",
    teleportAvoidFieldExit: false,
    teleportArrowMode: "center",
    teleportArrowPeriod: 5,
    teleportArrowSize: 6,
    teleportConnectorGapWidth: 0,
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
  it("maps pattern/color/gapWidth/thickness straight through", () => {
    const style = buildOneWayStyle(baseSettings({ oneWayPattern: "chevron", oneWayColor: 0xaaa, oneWayGapWidth: 5, oneWayThickness: 8 }));
    expect(style.pattern).toBe("chevron");
    expect(style.color).toBe(0xaaa);
    expect(style.gapWidth).toBe(5);
    expect(style.thickness).toBe(8);
  });

  it("mirrors floorColor as the gap color, independent of oneWayColor", () => {
    const style = buildOneWayStyle(baseSettings({ floorColor: 0xdead00, oneWayColor: 0xbeef00 }));
    expect(style.gapColor).toBe(0xdead00);
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
      teleportEdgeGapWidth: 6,
      teleportConnectorColor: 0x222,
      teleportConnectorWidth: 7,
      teleportConnectorStyle: "orthogonal",
      teleportArrowMode: "periodic",
      teleportArrowPeriod: 8,
      teleportArrowSize: 11,
      teleportConnectorGapWidth: 9,
      floorColor: 0x999,
    }));
    expect(style).toEqual({
      shape: "star", cornerStyle: "round", size: 0.4, edgeColor: 0x111, edgeBorderColor: 0x112, borderWidth: 5, edgeGapWidth: 6,
      connectorColor: 0x222, connectorWidth: 7, connectorStyle: "orthogonal",
      arrowMode: "periodic", arrowPeriod: 8, arrowSize: 11, connectorGapWidth: 9, floorColor: 0x999,
    });
  });
});

describe("buildMarkerStyle", () => {
  it("spreads MarkerSettings straight through and sets gapColor to the given floorColor", () => {
    const settings = { shape: "star" as const, cornerStyle: "round" as const, fillColor: 0x111, borderColor: 0x222, borderWidth: 4, gapWidth: 3, size: 0.5 };
    const style = buildMarkerStyle(settings, 0xdead00);
    expect(style).toEqual({ ...settings, gapColor: 0xdead00 });
  });

  it("gapColor tracks floorColor independently of the marker's own fillColor/borderColor", () => {
    const settings = { shape: "circle" as const, cornerStyle: "sharp" as const, fillColor: 0xaaa, borderColor: 0xbbb, borderWidth: 0, gapWidth: 0, size: 0.225 };
    expect(buildMarkerStyle(settings, 0x111).gapColor).toBe(0x111);
    expect(buildMarkerStyle(settings, 0x222).gapColor).toBe(0x222);
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

describe("resolveEffectiveEndpoints", () => {
  const nodes: NodeDto[] = [
    { id: 1, x: 0, y: 0, i: 0 },
    { id: 2, x: 1, y: 0, i: 0 },
    { id: 3, x: 2, y: 0, i: 0 },
  ];

  it("falls back to state.start/finish when post-edit was never confirmed", () => {
    expect(resolveEffectiveEndpoints({ nodes, start: 1, finish: 2, postEditMeta: null, postEditDraftSplitPoints: {} }))
      .toEqual({ start: 1, finish: 2 });
  });

  it("uses postEditMeta's endpoints once post-edit has confirmed, ignoring the stale generated start/finish — GitHub issue #303", () => {
    expect(resolveEffectiveEndpoints({
      nodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: nodeEndpoint(3), finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: {},
    })).toEqual({ start: 3, finish: 2 });
  });

  it("resolves a null postEditMeta endpoint (cleared marker) to null even though state.start/finish still holds the generated id", () => {
    expect(resolveEffectiveEndpoints({
      nodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: null, finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: {},
    })).toEqual({ start: null, finish: 2 });
  });

  it("resolves a split-endpoint start to its confirmed slot node, not the point's original node", () => {
    const splitNodes: NodeDto[] = [
      { id: 1, x: 0, y: 0, i: 0 },
      { id: 4, x: 0, y: 0, i: 1 }, // confirmed slot 7 at the same point
      { id: 2, x: 1, y: 0, i: 0 },
    ];
    expect(resolveEffectiveEndpoints({
      nodes: splitNodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: splitEndpoint([0, 0], 7), finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: { "0,0": [7] },
    })).toEqual({ start: 4, finish: 2 });
  });

  it("resolves an unconfirmed split-endpoint start to null rather than falling back to the stale generated id", () => {
    expect(resolveEffectiveEndpoints({
      nodes,
      start: 1,
      finish: 2,
      postEditMeta: { start: splitEndpoint([0, 0], 7), finish: nodeEndpoint(2) },
      postEditDraftSplitPoints: { "0,0": [7] },
    })).toEqual({ start: null, finish: 2 });
  });
});

