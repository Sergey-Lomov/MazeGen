import { describe, it, expect, vi } from "vitest";
import { Graphics } from "pixi.js";
import { buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import type { FieldConfig } from "../fieldConfig";
import { getCellVertices, pointInPolygon } from "../pixi/tessellationGeometry";
import { fieldOf } from "./fieldConfigFixtures";
import { settingsA, settingsB, baseState, makeRenderer, useRendererReset } from "./vbcKit";

import { mockStore } from "./vbcMocks";

vi.mock("../pixi/selectors/mazeSelectors", async () => (await import("./vbcMocks")).mazeSelectorsMock());
vi.mock("../pixi/renderers/WallRenderer", async () => (await import("./vbcMocks")).wallRendererMock());
vi.mock("../pixi/renderers/TeleportRenderer", async () => (await import("./vbcMocks")).teleportRendererMock());
vi.mock("../pixi/renderers/VerticalConnectionRenderer", async () => (await import("./vbcMocks")).verticalConnectionRendererMock());
vi.mock("../pixi/renderers/GridRenderer", async () => (await import("./vbcMocks")).gridRendererMock());
vi.mock("../store/mazeStore", async () => (await import("./vbcMocks")).mazeStoreMock());
vi.mock("pixi.js", async () => (await import("./vbcMocks")).pixiMock());

useRendererReset();

describe("VectorByCorridorsRenderer split points", () => {
  describe("split points (GitHub issue #314)", () => {
    it("draws each node's own face share as a straight line from the point's own center, one stroke per share", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          {
            color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 },
            wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 0, y: 10 }, center: { x: 10, y: 5 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
            connectors: [],
          },
          {
            color: 0xbbbbbb, pointKey: "0,0", center: { x: 5, y: 5 },
            wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 10 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
            connectors: [],
          },
        ],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> } }).splitLines;
      const colors = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { color: number }).color);
      expect(colors).toContain(0xaaaaaa);
      expect(colors).toContain(0xbbbbbb);
      // Every line starts at the point's own center (5,5), never a hub offset.
      expect(corridorsGraphics.moveTo).toHaveBeenCalledWith(5, 5);
    });

    it("a node with 3+ face shares draws one straight line per share, all from the same center — no hub fan-out", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 },
          wallSegments: [
            { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 10, y: 5 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 0, y: 5 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 5, y: 10 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
          ],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn>; moveTo: ReturnType<typeof vi.fn> } }).splitLines;
      expect(corridorsGraphics.stroke).toHaveBeenCalledTimes(3);
      expect(corridorsGraphics.moveTo.mock.calls.every((call: unknown[]) => call[0] === 5 && call[1] === 5)).toBe(true);
    });

    it("sharp hex diagonal divider converges each node's three lines at its own off-center junction", () => {
      const segment = (x: number, y: number) => ({
        v0: { x, y }, v1: { x, y }, center: { x, y }, isUndefined: false,
        atFaceStart: false, atFaceEnd: false,
      });
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(10, 0), segment(10, 5), segment(10, 10)], connectors: [] },
          { color: 0xbbbbbb, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(0, 0), segment(0, 5), segment(0, 10)], connectors: [] },
        ],
        wallFaces: [],
        specialShapes: [{
          kind: "diagonal", pointKey: "0,0", corner0: { x: 5, y: 0 }, corner1: { x: 5, y: 10 },
          dividerJunctions: [{ x: 7, y: 5 }, { x: 3, y: 5 }],
        }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsB, splitSpecialShapes: true } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { moveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; quadraticCurveTo: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> } }).splitLines;
      expect(corridorsGraphics.stroke).toHaveBeenCalledTimes(6);
      expect(corridorsGraphics.moveTo.mock.calls.filter(([x, y]) => x === 7 && y === 5)).toHaveLength(3);
      expect(corridorsGraphics.moveTo.mock.calls.filter(([x, y]) => x === 3 && y === 5)).toHaveLength(3);
      expect(corridorsGraphics.moveTo).not.toHaveBeenCalledWith(5, 5);
      expect(corridorsGraphics.stroke.mock.calls.every(([style]) => style.cap === "butt")).toBe(true);
      expect(corridorsGraphics.stroke.mock.calls.every(([style]) => style.color === settingsB.color)).toBe(true);
      // Only the inward wedge is needed at each seam; the outward stroke halves already overlap.
      expect(corridorsGraphics.fill.mock.calls.filter(([color]) => color === settingsB.color)).toHaveLength(6);
    });

    it("rounded hex diagonal divider uses the rounded junction contour", () => {
      const segment = (x: number, y: number) => ({
        v0: { x, y }, v1: { x, y }, center: { x, y }, isUndefined: false,
        atFaceStart: false, atFaceEnd: false,
      });
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(10, 0), segment(10, 5), segment(10, 10)], connectors: [] },
          { color: 0xbbbbbb, pointKey: "0,0", center: { x: 5, y: 5 }, wallSegments: [segment(0, 0), segment(0, 5), segment(0, 10)], connectors: [] },
        ],
        wallFaces: [],
        specialShapes: [{
          kind: "diagonal", pointKey: "0,0", corner0: { x: 5, y: 0 }, corner1: { x: 5, y: 10 },
          dividerJunctions: [{ x: 7, y: 5 }, { x: 3, y: 5 }],
        }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { moveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; arc: ReturnType<typeof vi.fn>; quadraticCurveTo: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> } }).splitLines;
      expect(corridorsGraphics.stroke).not.toHaveBeenCalled();
      // The universal cell-safe contour may use Bezier fallbacks for synthetic split-cell fixtures;
      // the production geometry path is still curved, but no longer relies on Pixi arc commands.
      expect(corridorsGraphics.arc).not.toHaveBeenCalled();
      expect(corridorsGraphics.quadraticCurveTo.mock.calls.length + corridorsGraphics.bezierCurveTo.mock.calls.length).toBeGreaterThan(0);
      expect(corridorsGraphics.fill.mock.calls.filter(([color]) => color === settingsA.background)).toHaveLength(2);
      expect(corridorsGraphics.fill.mock.calls.filter(([color]) => color === settingsA.color)).toHaveLength(4);
    });

    it("draws an undefined (tentative) share in a desaturated version of the node's color, not the plain color", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xff0000, pointKey: "0,0", center: { x: 5, y: 5 },
          wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: true, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn> } }).splitLines;
      const colors = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { color: number }).color);
      expect(colors).not.toContain(0xff0000);
    });

    it("plain (non-special) shares draw at half the corridor's own thickness", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 5, y: 5 },
          wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 }, center: { x: 5, y: 0 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [],
      });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn> } }).splitLines;
      const widths = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { width: number }).width);
      expect(widths).toContain(settingsA.thickness / 2);
    });

    it("bridge special shape: draws the through line, the cross line, and a background-colored gap stroke at their intersection when splitGapWidth > 0, both in the plain corridor color", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [{ v0: { x: 0, y: 20 }, v1: { x: 0, y: 20 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "0,0",
          crossFaces: [{ v0: { x: 20, y: 0 }, v1: { x: 20, y: 0 } }, { v0: { x: 20, y: 40 }, v1: { x: 20, y: 40 } }],
          edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
          edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
          throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }],
        }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 3 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn> } }).splitLines;
      // The through/cross lines and the background gap patch all draw on their own throwaway
      // tile-masked `clipView` (GitHub issue #314 follow-up), never on the shared `corridors`
      // graphics — so the point's own ordinary passage share must not appear there either, and
      // neither must the special shape's own lines.
      const corridorsStrokeCalls = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number });
      expect(corridorsStrokeCalls.some((s) => s.color === 0xaaaaaa)).toBe(false);
      expect(corridorsStrokeCalls.length).toBe(0);

      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number }));
      // Through line and cross line both draw in the plain corridor color, at full thickness — 2
      // separate stroke calls at that color (through, then cross, on top); the gap patch is a
      // separate stroke in `settings.background`, all on the same `clipView`.
      const fullColorCalls = allStrokeCalls.filter((s) => s.color === settingsA.color && s.width === settingsA.thickness);
      expect(fullColorCalls.length).toBe(2);
      expect(allStrokeCalls.some((s) => s.color === settingsA.background)).toBe(true);
    });

    it("bridge special shape: draws no background gap stroke when splitGapWidth is 0", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [{ v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "0,0",
          crossFaces: [{ v0: { x: 20, y: 0 }, v1: { x: 20, y: 0 } }, { v0: { x: 20, y: 40 }, v1: { x: 20, y: 40 } }],
          edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
          edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
          throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }],
        }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn> } }).splitLines;
      expect(corridorsGraphics.stroke.mock.calls.some(([style]) => (style as { color: number }).color === 0xaaaaaa)).toBe(false);
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number }));
      expect(allStrokeCalls.some((s) => s.color === settingsA.background)).toBe(false);
    });

    // A crossing bridge with no through line: the second node is a 3-face fork (it reaches the
    // extra face midpoint (10, 10)) drawn as the ordinary corridor underlay beneath the deck.
    const bridgeOverFork = () => ({
      passages: [
        {
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [
            { v0: { x: 10, y: 0 }, v1: { x: 30, y: 0 }, center: { x: 20, y: 0 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 10, y: 40 }, v1: { x: 30, y: 40 }, center: { x: 20, y: 40 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
          ],
          connectors: [],
        },
        {
          color: 0xbbbbbb, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [
            { v0: { x: 0, y: 10 }, v1: { x: 0, y: 30 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 40, y: 10 }, v1: { x: 40, y: 30 }, center: { x: 40, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
            { v0: { x: 5, y: 5 }, v1: { x: 15, y: 15 }, center: { x: 10, y: 10 }, isUndefined: false, atFaceStart: false, atFaceEnd: false },
          ],
          connectors: [],
        },
      ],
      wallFaces: [],
      specialShapes: [{
        kind: "bridge", pointKey: "0,0",
        crossFaces: [{ v0: { x: 10, y: 0 }, v1: { x: 30, y: 0 } }, { v0: { x: 10, y: 40 }, v1: { x: 30, y: 40 } }],
        edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
        edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
      }],
    });

    it("bridge special shape without a through line keeps the underlying fork below the bridge", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce(bridgeOverFork() as never);
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).splitLines;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const allStrokeCalls = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number }));
      expect(allStrokeCalls.filter((s) => s.color === settingsA.color && s.width === settingsA.thickness)).toHaveLength(1);
      expect(corridorsGraphics.stroke).not.toHaveBeenCalled();
      expect(corridorsGraphics.fill.mock.calls.every(([color]) => color === settingsA.color)).toBe(true);
    });

    it("miter bridge underlay draws the fork as plain connector lines, not a contour fill", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce(bridgeOverFork() as never);
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsB, splitSpecialShapes: true, splitGapWidth: 0 } });
      const renderer = makeRenderer();
      const corridors = (renderer as unknown as { splitLines: {
        moveTo: ReturnType<typeof vi.fn>;
        lineTo: ReturnType<typeof vi.fn>;
        closePath: ReturnType<typeof vi.fn>;
      } }).splitLines;
      expect(corridors.moveTo).toHaveBeenCalledWith(20, 20);
      expect(corridors.lineTo).toHaveBeenCalledWith(10, 10);
      expect(corridors.closePath).not.toHaveBeenCalled();
    });

    it("clips a Cairo bridge gap as a cell-bounded polygon with independently limited ends", () => {
      const cfg: FieldConfig = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
      const vertices = getCellVertices(2, 1, cfg)!;
      const face = (index: number) => ({ v0: vertices[index], v1: vertices[(index + 1) % vertices.length] });
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "2,1",
          crossFaces: [face(0), face(2)],
          edge0: [vertices[0], vertices[1], vertices[2], vertices[3]],
          edge1: [vertices[1], vertices[2], vertices[3], vertices[4]],
        }],
      });
      mockStore.current = baseState({
        activeFieldConfig: cfg,
        vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 10 },
      });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn> } }).splitLines;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { poly: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const backgroundPolygons = groupGraphics.flatMap((g) => g.fill.mock.calls.some((call: unknown[]) => call[0] === settingsA.background)
        ? g.poly.mock.calls
        : []);
      expect(backgroundPolygons.length).toBeGreaterThan(0);
      const polygon = backgroundPolygons[0][0] as number[];
      const polygonPoints = Array.from({ length: polygon.length / 2 }, (_, index) => ({ x: polygon[index * 2], y: polygon[index * 2 + 1] }));
      expect(polygonPoints.length).toBeGreaterThan(4);
      expect(polygonPoints.every((point) => pointInPolygon(point, vertices))).toBe(true);
      expect(groupGraphics.flatMap((g) => g.stroke.mock.calls).some((call: unknown[]) => (call[0] as { color?: number }).color === settingsA.background)).toBe(false);
    });

    it("parallel Cairo divider leaves the lower 1-4 connection without a gap underlay", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { nodeIndex: 1, color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }] },
          { nodeIndex: 0, color: 0xbbbbbb, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 20, y: 40 }, to: { x: 40, y: 20 }, isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 }, topNodeIndex: 0 }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitGapWidth: 3 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { fill: ReturnType<typeof vi.fn> } }).splitLines;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const fills = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(fills.filter((color) => color === settingsA.background)).toHaveLength(1);
      expect(fills.filter((color) => color === settingsA.color)).toHaveLength(2);
    });

    it("diagonal special shape: draws each node's connector as a bowed ribbon (bezierCurveTo), not a straight line, when splitDiagonalBowAmount > 0, in the plain corridor color", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }] },
          { color: 0xbbbbbb, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 20, y: 40 }, to: { x: 40, y: 20 }, isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 } }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitDiagonalBowAmount: 0.15, splitGapWidth: 0 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { bezierCurveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).splitLines;
      // Each ribbon draws on its own throwaway tile-masked `clipView` (GitHub issue #314
      // follow-up), never on the shared `corridors` graphics.
      expect(corridorsGraphics.bezierCurveTo).not.toHaveBeenCalled();
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { bezierCurveTo: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      // splitGapWidth: 0 -> no gap-patch pass, 2 bezierCurveTo calls per ribbon (one per long
      // edge), 2 connectors total -> 4.
      const totalBezier = groupGraphics.reduce((sum, g) => sum + g.bezierCurveTo.mock.calls.length, 0);
      expect(totalBezier).toBe(4);
      const allFillCalls = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(allFillCalls.some((c) => c === settingsA.color)).toBe(true);
      expect(allFillCalls.some((c) => c === settingsA.background)).toBe(false);
    });

    it("diagonal special shape: draws a background-colored gap frame around each arc when splitGapWidth > 0", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 } }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitDiagonalBowAmount: 0.15, splitGapWidth: 3 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { bezierCurveTo: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> } }).splitLines;
      // The ribbon's own line and its background gap frame draw on two separate `Graphics`
      // (`clipView`/`gapView`, GitHub issue #314 follow-up) — never on the shared `corridors`
      // graphics. Each is its own filled ribbon (2 bezierCurveTo calls, one per long edge).
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { bezierCurveTo: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      const totalBezier = groupGraphics.reduce((sum, g) => sum + g.bezierCurveTo.mock.calls.length, 0);
      expect(totalBezier).toBe(4);
      const allFillCalls = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(allFillCalls.some((c) => c === settingsA.background)).toBe(true);
      expect(allFillCalls.some((c) => c === settingsA.color)).toBe(true);
      expect(corridorsGraphics.bezierCurveTo).not.toHaveBeenCalled();
    });

    it("miter diagonal uses a sharp ribbon and suppresses its gap even when splitGapWidth > 0", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [],
          connectors: [{ from: { x: 0, y: 20 }, to: { x: 20, y: 0 }, isUndefined: false }],
        }],
        wallFaces: [],
        specialShapes: [{ kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 40, y: 40 } }],
      });
      mockStore.current = baseState({
        vectorByCorridorsSettings: { ...settingsB, splitSpecialShapes: true, splitDiagonalBowAmount: 0.8, splitGapWidth: 8 },
      });

      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { fill: ReturnType<typeof vi.fn> } }).splitLines;
      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as {
        bezierCurveTo: ReturnType<typeof vi.fn>;
        fill: ReturnType<typeof vi.fn>;
      });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);
      expect(groupGraphics.every((g) => g.bezierCurveTo.mock.calls.length === 0)).toBe(true);
      const fills = groupGraphics.flatMap((g) => g.fill.mock.calls.map((call: unknown[]) => call[0] as number));
      expect(fills).toContain(settingsB.color);
      expect(fills).not.toContain(settingsB.background);
    });

    it("hex_triple_corridor: the opposite-pair throughLine draws once (deduped across its 2 diagonal entries), after both ribbons, with its own background gap patch cutting into them when splitGapWidth > 0", () => {
      const throughLine: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 0, y: 20 }, { x: 40, y: 20 }];
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [
          { color: 0xaaaaaa, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 0, y: 0 }, to: { x: 20, y: 0 }, isUndefined: false }] },
          { color: 0xbbbbbb, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: { x: 20, y: 40 }, to: { x: 40, y: 40 }, isUndefined: false }] },
          { color: 0xcccccc, pointKey: "1,1", center: { x: 20, y: 20 }, wallSegments: [], connectors: [{ from: throughLine[0], to: throughLine[1], isUndefined: false }] },
        ],
        wallFaces: [],
        specialShapes: [
          { kind: "diagonal", pointKey: "1,1", corner0: { x: 0, y: 0 }, corner1: { x: 20, y: 40 }, throughLine },
          { kind: "diagonal", pointKey: "1,1", corner0: { x: 20, y: 0 }, corner1: { x: 40, y: 40 } },
        ],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: true, splitDiagonalBowAmount: 0.15, splitGapWidth: 3 } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> } }).splitLines;

      const graphicsInstances = vi.mocked(Graphics).mock.results.map((r) => r.value as { stroke: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn> });
      const groupGraphics = graphicsInstances.filter((g) => g !== corridorsGraphics);

      // Exactly one straight-line stroke at full thickness in the plain corridor color — the
      // throughLine, drawn once despite appearing on both diagonal entries sharing this pointKey.
      const fullColorStrokes = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number; width: number }))
        .filter((s) => s.color === settingsA.color && s.width === settingsA.thickness);
      expect(fullColorStrokes.length).toBe(1);

      // Its own background gap patch (splitGapWidth > 0) exists as a separate background-colored
      // stroke, distinct from the through line's own full-color stroke.
      const backgroundStrokes = groupGraphics.flatMap((g) => g.stroke.mock.calls.map((call: unknown[]) => call[0] as { color: number }))
        .filter((s) => s.color === settingsA.background);
      expect(backgroundStrokes.length).toBeGreaterThan(0);

      // Both ribbons still draw — with splitGapWidth > 0 each ribbon draws its own gap frame plus
      // its own line (2 bezierCurveTo calls each), 2 ribbons -> 8 total.
      const totalBezier = groupGraphics.reduce((sum, g) => sum + g.bezierCurveTo.mock.calls.length, 0);
      expect(totalBezier).toBe(8);
      expect(corridorsGraphics.stroke).not.toHaveBeenCalled();
    });

    it("splitSpecialShapes off: special-shape points fall back to the ordinary per-node face-share reading", () => {
      vi.mocked(buildSplitPassages).mockReturnValueOnce({
        passages: [{
          color: 0xaaaaaa, pointKey: "0,0", center: { x: 20, y: 20 },
          wallSegments: [{ v0: { x: 0, y: 20 }, v1: { x: 0, y: 20 }, center: { x: 0, y: 20 }, isUndefined: false, atFaceStart: false, atFaceEnd: false }],
          connectors: [],
        }],
        wallFaces: [],
        specialShapes: [{
          kind: "bridge", pointKey: "0,0",
          crossFaces: [{ v0: { x: 20, y: 0 }, v1: { x: 20, y: 0 } }, { v0: { x: 20, y: 40 }, v1: { x: 20, y: 40 } }],
          edge0: [{ x: 10, y: 0 }, { x: 14, y: 8 }, { x: 14, y: 32 }, { x: 10, y: 40 }],
          edge1: [{ x: 30, y: 0 }, { x: 26, y: 8 }, { x: 26, y: 32 }, { x: 30, y: 40 }],
          throughLine: [{ x: 0, y: 20 }, { x: 40, y: 20 }],
        }],
      });
      mockStore.current = baseState({ vectorByCorridorsSettings: { ...settingsA, splitSpecialShapes: false } });
      const renderer = makeRenderer();
      const corridorsGraphics = (renderer as unknown as { splitLines: { stroke: ReturnType<typeof vi.fn> } }).splitLines;
      const strokeArgs = corridorsGraphics.stroke.mock.calls.map((call: unknown[]) => (call[0] as { color: number }).color);
      expect(strokeArgs).toContain(0xaaaaaa);
    });
  });
});
