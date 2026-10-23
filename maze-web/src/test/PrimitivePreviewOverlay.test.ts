import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  graphics: [] as { calls: { name: string; args: unknown[] }[] }[],
}));

vi.mock("pixi.js", () => ({
  Container: class {
    addChild() {}
  },
  Graphics: class {
    calls: { name: string; args: unknown[] }[] = [];
    constructor() {
      stubs.graphics.push(this);
    }
    clear(...args: unknown[]) { this.calls.push({ name: "clear", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ name: "poly", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ name: "fill", args }); return this; }
    ellipse(...args: unknown[]) { this.calls.push({ name: "ellipse", args }); return this; }
    moveTo(...args: unknown[]) { this.calls.push({ name: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ name: "lineTo", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ name: "stroke", args }); return this; }
    arcTo(...args: unknown[]) { this.calls.push({ name: "arcTo", args }); return this; }
    closePath(...args: unknown[]) { this.calls.push({ name: "closePath", args }); return this; }
    cut(...args: unknown[]) { this.calls.push({ name: "cut", args }); return this; }
    destroy() {}
  },
}));

import { PrimitivePreviewOverlay } from "../pixi/PrimitivePreviewOverlay";
import { fieldOf } from "./fieldConfigFixtures";

const cfg = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });

beforeEach(() => {
  stubs.graphics.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("PrimitivePreviewOverlay selection frames", () => {
  it("uses the selection color for selected cells and dashed polygon edges", () => {
    const overlay = new PrimitivePreviewOverlay({ addChild() {} } as never);

    overlay.update(
      [[0, 0]],
      1,
      cfg,
      {
        kind: "polygon",
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }],
        dashedAll: true,
      },
    );

    const calls = stubs.graphics[0].calls;
    expect(calls.find(({ name }) => name === "fill")?.args[0]).toMatchObject({ color: 0xffffff });
    expect(calls.filter(({ name }) => name === "moveTo").length).toBeGreaterThan(3);
    expect(calls.filter(({ name }) => name === "stroke").length).toBeGreaterThan(3);
    overlay.destroy();
  });

  it("draws a filled inset contour for a boundary selection", () => {
    const overlay = new PrimitivePreviewOverlay({ addChild() {} } as never);
    const a = { x: 0, y: 0 }, b = { x: 40, y: 0 }, c = { x: 40, y: -40 }, d = { x: 0, y: -40 };

    overlay.update([], 1, cfg, { kind: "boundary", segments: [[a, b], [b, c], [c, d], [d, a]] });

    const calls = stubs.graphics[0].calls;
    expect(calls.some(({ name }) => name === "fill")).toBe(true);
    // Dashed border: one stroke per dash, several along each of the four sides.
    expect(calls.filter(({ name }) => name === "stroke").length).toBeGreaterThan(4);
    overlay.destroy();
  });

  it("keeps corner-touching components as separate contours", () => {
    const overlay = new PrimitivePreviewOverlay({ addChild() {} } as never);
    const square = (x: number, y: number) => {
      const a = { x, y }, b = { x: x + 40, y }, c = { x: x + 40, y: y - 40 }, d = { x, y: y - 40 };
      return [[a, b], [b, c], [c, d], [d, a]] as [typeof a, typeof a][];
    };
    // Second square shares only the corner (40, -40) with the first.
    const segments = [...square(0, 0), ...square(40, -40)];

    overlay.update([], 1, cfg, { kind: "boundary", segments, components: [0, 0, 0, 0, 1, 1, 1, 1] });

    const calls = stubs.graphics[0].calls;
    const fills = calls.filter(({ name }) => name === "fill");
    expect(fills).toHaveLength(2);
    expect(calls.filter(({ name }) => name === "stroke").length).toBeGreaterThan(8);
    overlay.destroy();
  });

  it("cuts a hole out of the fill for a nested contour", () => {
    const overlay = new PrimitivePreviewOverlay({ addChild() {} } as never);
    const loop = (x: number, y: number, size: number) => {
      const a = { x, y }, b = { x: x + size, y }, c = { x: x + size, y: y - size }, d = { x, y: y - size };
      return [[a, b], [b, c], [c, d], [d, a]] as [typeof a, typeof a][];
    };

    overlay.update([], 1, cfg, { kind: "boundary", segments: [...loop(0, 0, 120), ...loop(40, -40, 40)] });

    const calls = stubs.graphics[0].calls;
    expect(calls.some(({ name }) => name === "cut")).toBe(true);
    overlay.destroy();
  });

  it("draws a dashed ellipse frame for Select mode", () => {
    const overlay = new PrimitivePreviewOverlay({ addChild() {} } as never);

    overlay.update(
      [],
      1,
      cfg,
      { kind: "ellipse", center: { x: 20, y: 20 }, width: 80, height: 40, dashed: true },
    );

    const calls = stubs.graphics[0].calls;
    expect(calls.some(({ name }) => name === "ellipse")).toBe(false);
    expect(calls.filter(({ name }) => name === "moveTo").length).toBeGreaterThan(1);
    expect(calls.filter(({ name }) => name === "stroke").length).toBeGreaterThan(1);
    overlay.destroy();
  });

  it("keeps an active frame at the minimum screen-space stroke width after zooming out", () => {
    const overlay = new PrimitivePreviewOverlay({ addChild() {} } as never);

    overlay.update(
      [],
      1,
      cfg,
      { kind: "ellipse", center: { x: 20, y: 20 }, width: 80, height: 40 },
    );
    overlay.onViewportChanged(0, 0, 800, 600, 0.18);

    const stroke = stubs.graphics[0].calls.filter(({ name }) => name === "stroke").at(-1);
    expect(stroke?.args[0]).toMatchObject({ width: 1.25 / 0.18 });
    overlay.destroy();
  });
});
