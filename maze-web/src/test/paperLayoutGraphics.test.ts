import { describe, expect, it } from "vitest";
import { drawPaperLayoutFrame, drawPaperLayoutMargins } from "../pixi/imageExport/paperLayoutGraphics";

type Stroke = { width: number };
type Point = { x: number; y: number };

function graphicsRecorder() {
  const strokes: Stroke[] = [];
  const segments: Point[] = [];
  const graphics = {
    rect: () => graphics,
    fill: () => graphics,
    moveTo: (x: number, y: number) => { segments.push({ x, y }); return graphics; },
    lineTo: (x: number, y: number) => { segments.push({ x, y }); return graphics; },
    stroke: (options: Stroke) => { strokes.push(options); return graphics; },
  };
  return { graphics, strokes, segments };
}

describe("paper-layout graphics", () => {
  it("compensates frame and margin measurements for the viewport layer scale", () => {
    const a0 = graphicsRecorder();
    const a5 = graphicsRecorder();
    const rect = { x: 0, y: 0, w: 100, h: 200 };

    drawPaperLayoutFrame(a0.graphics as never, rect, 0xffffff, 0.1);
    drawPaperLayoutMargins(a0.graphics as never, rect, 10, 10, 0xffffff, 0.1);
    drawPaperLayoutFrame(a5.graphics as never, rect, 0xffffff, 2);
    drawPaperLayoutMargins(a5.graphics as never, rect, 10, 10, 0xffffff, 2);

    expect(a0.strokes[0].width * 0.1).toBeCloseTo(2);
    expect(a5.strokes[0].width * 2).toBeCloseTo(2);
    expect(a0.strokes.slice(1).every(({ width }) => width * 0.1 === 1)).toBe(true);
    expect(a5.strokes.slice(1).every(({ width }) => width * 2 === 1)).toBe(true);
    expect(distance(a0.segments[0], a0.segments[1]) * 0.1).toBeCloseTo(10);
    expect(distance(a5.segments[0], a5.segments[1]) * 2).toBeCloseTo(10);
    expect(distance(a0.segments[0], a0.segments[2]) * 0.1).toBeCloseTo(16);
    expect(distance(a5.segments[0], a5.segments[2]) * 2).toBeCloseTo(16);
  });

  it("falls back to unscaled measurements for an invalid viewport scale", () => {
    const recorded = graphicsRecorder();
    const rect = { x: 0, y: 0, w: 100, h: 200 };

    drawPaperLayoutFrame(recorded.graphics as never, rect, 0xffffff, 0);
    drawPaperLayoutMargins(recorded.graphics as never, rect, 10, 10, 0xffffff, Number.NaN);

    expect(recorded.strokes[0].width).toBe(2);
    expect(recorded.strokes.slice(1).every(({ width }) => width === 1)).toBe(true);
  });
});

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
