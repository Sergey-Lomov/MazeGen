import { describe, it, expect } from "vitest";
import { buildMarkerIndexEndpointResolver } from "../pixi/imageExport/exportStyleBuilders";
import { TILE_SIZE } from "../pixi/constants";
import type { TeleportEdge, TeleportLineStyle } from "../pixi/renderers/types";
import type { VerticalConnectionStyle, VerticalMarkerStyle } from "../pixi/renderers/VerticalConnectionRenderer";

const teleportStyle = (patch: Partial<TeleportLineStyle> = {}): TeleportLineStyle => ({
  shape: "circle", cornerStyle: "round", size: 0.2,
  edgeColor: 0x111111, edgeBorderColor: 0x222222, borderWidth: 0, edgeGapWidth: 0,
  connectorColor: 0x333333, connectorWidth: 2, connectorStyle: "straight", arrowMode: "none",
  ...patch,
} as TeleportLineStyle);

const marker = (patch: Partial<VerticalMarkerStyle> = {}): VerticalMarkerStyle => ({
  shape: "circle", cornerStyle: "round", fillColor: 0xaa0000, borderColor: 0xbb0000,
  borderWidth: 0, gapWidth: 0, gapColor: 0x000000, size: 0.25, ...patch,
});

const verticalStyle = (patch: Partial<VerticalConnectionStyle> = {}): VerticalConnectionStyle => ({
  twoWayPassageMarker: marker({ fillColor: 0x00aa00, borderColor: 0x00bb00 }),
  oneWayPassageMarker: marker({ fillColor: 0x00aa00, borderColor: 0x00bb00 }),
  elevatorMarker: marker({ fillColor: 0x0000aa, borderColor: 0x0000bb }),
  oneWayAccentColor: 0x00cc00,
  ...patch,
} as VerticalConnectionStyle);

describe("buildMarkerIndexEndpointResolver", () => {
  it("resolves a vertical endpoint to the two-way-passage marker, an elevator endpoint to the elevator marker", () => {
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: [], teleportStyle: teleportStyle(), groupCustomization: false, groupOverrides: {},
      verticalStyle: verticalStyle(),
    });
    expect(resolve(1, "vertical").borderMatchColor).toBe(0x00aa00); // no border -> fill
    expect(resolve(2, "elevator").borderMatchColor).toBe(0x0000aa);
  });

  it("uses the marker border color for borderMatchColor only when the marker has a border", () => {
    const withBorder = buildMarkerIndexEndpointResolver({
      teleportEdges: [], teleportStyle: teleportStyle(), groupCustomization: false, groupOverrides: {},
      verticalStyle: verticalStyle({ elevatorMarker: marker({ fillColor: 0x0000aa, borderColor: 0x0000bb, borderWidth: 3 }) }),
    });
    expect(withBorder(2, "elevator").borderMatchColor).toBe(0x0000bb);
  });

  it("reports the marker outer radius as size*TILE_SIZE + borderWidth", () => {
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: [], teleportStyle: teleportStyle(), groupCustomization: false, groupOverrides: {},
      verticalStyle: verticalStyle({ elevatorMarker: marker({ size: 0.25, borderWidth: 4 }) }),
    });
    expect(resolve(2, "elevator").outerRadius).toBeCloseTo(0.25 * TILE_SIZE + 4);
  });

  it("uses the drawn decorative line color and size for vertical indices", () => {
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: [], teleportStyle: teleportStyle(), groupCustomization: false, groupOverrides: {},
      verticalStyle: verticalStyle({
        style: "decorative",
        decorativeStairsTwoWay: { lineColor: 0x123456, lineWidth: 5, size: 0.31 },
        decorativeElevator: { lineColor: 0x654321, lineWidth: 6, size: 0.27 },
      }),
    });
    expect(resolve(1, "vertical")).toEqual({ outerRadius: 0.31 * TILE_SIZE, borderMatchColor: 0x123456 });
    expect(resolve(2, "elevator")).toEqual({ outerRadius: 0.27 * TILE_SIZE, borderMatchColor: 0x654321 });
  });

  it("uses the one-way decorative line color for one-way vertical indices", () => {
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: [], teleportStyle: teleportStyle(), groupCustomization: false, groupOverrides: {},
      verticalStyle: verticalStyle({
        style: "decorative",
        decorativeStairsTwoWay: { lineColor: 0x123456, lineWidth: 5, size: 0.31 },
        decorativeStairsOneWay: { lineColor: 0xabcdef, lineWidth: 5, size: 0.29 },
      }),
    });
    expect(resolve(1, "vertical", true)).toEqual({ outerRadius: 0.29 * TILE_SIZE, borderMatchColor: 0xabcdef });
  });

  it("uses the one-way secondary color for abstract vertical indices", () => {
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: [], teleportStyle: teleportStyle(), groupCustomization: false, groupOverrides: {},
      verticalStyle: verticalStyle({ oneWayAccentColor: 0xfedcba }),
    });
    expect(resolve(1, "vertical", true).borderMatchColor).toBe(0xfedcba);
  });

  it("resolves a teleport endpoint via the base teleport style when no group override applies", () => {
    const edges: TeleportEdge[] = [{ from: [1, 1], to: [4, 4], oneWay: false, fromNode: 10, toNode: 11 }];
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: edges, teleportStyle: teleportStyle({ edgeColor: 0xcccccc, borderWidth: 0 }),
      groupCustomization: true, groupOverrides: {}, verticalStyle: verticalStyle(),
    });
    expect(resolve(10, "teleport").borderMatchColor).toBe(0xcccccc); // no border -> edgeColor
  });

  it("applies a TeleportGroupOverride covering the endpoint's own cell", () => {
    const edges: TeleportEdge[] = [{ from: [1, 1], to: [4, 4], oneWay: false, fromNode: 10, toNode: 11 }];
    // The resolver keys overrides by `TeleportGroup.key` (a sorted edge-key join). Rather than
    // reconstruct that key here, hand it a map that returns the same override for any key.
    const override = { fillColor: 0xfeed01, borderColor: 0xfeed02 };
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: edges, teleportStyle: teleportStyle({ borderWidth: 2 }),
      groupCustomization: true,
      groupOverrides: new Proxy({}, { get: () => override }) as unknown as Record<string, typeof override>,
      verticalStyle: verticalStyle(),
    });
    // borderWidth > 0 -> borderMatchColor is the (overridden) border color
    expect(resolve(10, "teleport").borderMatchColor).toBe(0xfeed02);
  });

  it("ignores group overrides when groupCustomization is off", () => {
    const edges: TeleportEdge[] = [{ from: [1, 1], to: [4, 4], oneWay: false, fromNode: 10, toNode: 11 }];
    const override = { fillColor: 0xfeed01, borderColor: 0xfeed02 };
    const resolve = buildMarkerIndexEndpointResolver({
      teleportEdges: edges, teleportStyle: teleportStyle({ edgeColor: 0xcccccc, borderWidth: 0 }),
      groupCustomization: false,
      groupOverrides: new Proxy({}, { get: () => override }) as unknown as Record<string, typeof override>,
      verticalStyle: verticalStyle(),
    });
    expect(resolve(10, "teleport").borderMatchColor).toBe(0xcccccc);
  });
});
