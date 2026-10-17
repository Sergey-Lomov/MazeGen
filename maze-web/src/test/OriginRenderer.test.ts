import { describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    clear() { return this; }
    setStrokeStyle() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    stroke() { return this; }
    circle() { return this; }
    fill() { return this; }
    destroy() {}
  }
  return { Graphics: FakeGraphics, Container: class { addChild() {} } };
});

import { OriginRenderer } from "../pixi/renderers/OriginRenderer";
import { fieldOf } from "./fieldConfigFixtures";

describe("OriginRenderer", () => {
  it.each(["square", "hex", "tri", "cairo"] as const)("draws the %s origin marker without an invalid cell", (kind) => {
    const renderer = new OriginRenderer({ addChild: vi.fn() } as never);
    const cfg = fieldOf(kind, kind === "hex" ? { shape: "hexagon", radius: 2 } : { shape: "rect", cols: 3, rows: 3 });
    expect(() => renderer.render({ show: true }, cfg)).not.toThrow();
  });
});
