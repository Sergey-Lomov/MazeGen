import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => {
  class FakeGraphics {
    calls: { fn: string; args: unknown[] }[] = [];
    moveTo(...args: unknown[]) { this.calls.push({ fn: "moveTo", args }); return this; }
    lineTo(...args: unknown[]) { this.calls.push({ fn: "lineTo", args }); return this; }
    stroke(...args: unknown[]) { this.calls.push({ fn: "stroke", args }); return this; }
    clear() { this.calls = []; return this; }
  }
  class FakeContainer {
    addChild() {}
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

const { SplitJunctionRenderer } = await import("../pixi/renderers/SplitJunctionRenderer");
const { Container, Graphics } = await import("pixi.js");

// Two wallFaces sharing a vertex — an ordinary corner, chainable when a style override is given.
const wallFaces = [
  { v0: { x: 0, y: 0 }, v1: { x: 10, y: 0 } },
  { v0: { x: 10, y: 0 }, v1: { x: 10, y: 10 } },
];

function graphicsOf(renderer: InstanceType<typeof SplitJunctionRenderer>) {
  return (renderer as unknown as { g: InstanceType<typeof Graphics> & { calls: { fn: string; args: unknown[] }[] } }).g;
}

describe("SplitJunctionRenderer.render wallFaces", () => {
  it("without a style override, draws each wallFace as its own isolated stroke", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [], wallFaces });
    const strokeCalls = graphicsOf(renderer).calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(2);
  });

  it("with a style override, chains wallFaces sharing a vertex into one continuous stroked path", () => {
    const renderer = new SplitJunctionRenderer(new Container());
    renderer.render({ passages: [], wallFaces }, { color: 0xabcdef, width: 4, join: "miter", cap: "square" });
    const calls = graphicsOf(renderer).calls;
    const strokeCalls = calls.filter((c) => c.fn === "stroke");
    expect(strokeCalls).toHaveLength(1);
    expect(strokeCalls[0].args[0]).toMatchObject({ color: 0xabcdef, width: 4, join: "miter", cap: "square" });
  });
});
