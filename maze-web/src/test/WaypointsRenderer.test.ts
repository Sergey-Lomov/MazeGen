import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    circle(...args: unknown[]) { this.calls.push({ fn: "circle", args }); return this; }
    poly(...args: unknown[]) { this.calls.push({ fn: "poly", args }); return this; }
    roundPoly(...args: unknown[]) { this.calls.push({ fn: "roundPoly", args }); return this; }
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    arcTo(...args: unknown[]) { this.calls.push({ fn: "arcTo", args }); return this; }
    closePath(...args: unknown[]) { this.calls.push({ fn: "closePath", args }); return this; }
    fill(...args: unknown[]) { this.calls.push({ fn: "fill", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
  }
  class FakeContainer {
    addChild() {}
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

const { WaypointsRenderer } = await import("../pixi/renderers/WaypointsRenderer");
const { Container, Graphics } = await import("pixi.js");
import type { MarkerData } from "../pixi/renderers/types";

function g(renderer: InstanceType<typeof WaypointsRenderer>) {
  return (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;
}

describe("WaypointsRenderer.render", () => {
  it("a marker with no border/gap draws only a fill, no stroke", () => {
    const renderer = new WaypointsRenderer(new Container());
    const marker: MarkerData = { pos: [5, 5], color: 0x111, radius: 10 };
    renderer.render({ markers: [marker] });
    const calls = g(renderer).calls;
    expect(calls.filter((c) => c.fn === "circle")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "fill")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "stroke")).toHaveLength(0);
  });

  it("a border draws with alignment: 0 (pixi's outer alignment), so the marker's own radius never shrinks", () => {
    const renderer = new WaypointsRenderer(new Container());
    const marker: MarkerData = { pos: [5, 5], color: 0x111, radius: 10, borderColor: 0x222, borderWidth: 4 };
    renderer.render({ markers: [marker] });
    const [strokeCall] = g(renderer).calls.filter((c) => c.fn === "stroke");
    expect(strokeCall.args[0]).toMatchObject({ color: 0x222, width: 4, alignment: 0 });
  });

  it("gapWidth > 0 draws a floor-colored gap ring first, wider than radius + borderWidth (GitHub issue #302)", () => {
    const renderer = new WaypointsRenderer(new Container());
    const marker: MarkerData = {
      pos: [5, 5], color: 0x111, radius: 10, borderColor: 0x222, borderWidth: 4, gapWidth: 3, gapColor: 0x333,
    };
    renderer.render({ markers: [marker] });
    const calls = g(renderer).calls;
    const circleCalls = calls.filter((c) => c.fn === "circle");
    // Gap ring circle, then the marker's own circle (fill + border stroke share this one path) — 2 total.
    expect(circleCalls).toHaveLength(2);
    const [, , gapRadius] = circleCalls[0].args as [number, number, number];
    // radius (10) + borderWidth (4) + gapWidth (3) — matches the outer-alignment border's true edge.
    expect(gapRadius).toBe(17);
    const fillCalls = calls.filter((c) => c.fn === "fill");
    expect(fillCalls[0].args[0]).toBe(0x333);
  });

  it("gapWidth 0 (or unset) skips the gap ring entirely — not a zero-radius circle", () => {
    const renderer = new WaypointsRenderer(new Container());
    const marker: MarkerData = { pos: [5, 5], color: 0x111, radius: 10, gapWidth: 0 };
    renderer.render({ markers: [marker] });
    expect(g(renderer).calls.filter((c) => c.fn === "circle")).toHaveLength(1);
  });

  it("cornerStyle: 'round' rounds a non-circle shape via the shared arcTo-based path, not a plain poly", () => {
    const renderer = new WaypointsRenderer(new Container());
    const marker: MarkerData = { pos: [5, 5], color: 0x111, radius: 10, shape: "square", cornerStyle: "round" };
    renderer.render({ markers: [marker] });
    const calls = g(renderer).calls;
    expect(calls.filter((c) => c.fn === "arcTo").length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.fn === "poly")).toHaveLength(0);
  });

  it("clear() resets between render() calls — no stale draws accumulate across a second render", () => {
    const renderer = new WaypointsRenderer(new Container());
    renderer.render({ markers: [{ pos: [0, 0], color: 0x111, radius: 10 }] });
    renderer.render({ markers: [{ pos: [0, 0], color: 0x111, radius: 10 }] });
    expect(g(renderer).calls.filter((c) => c.fn === "circle")).toHaveLength(1);
  });
});
