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
});
