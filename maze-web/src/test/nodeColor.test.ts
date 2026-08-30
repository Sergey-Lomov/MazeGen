import { describe, it, expect, vi } from "vitest";
import { nodeColor } from "../pixi/BaseGraphRenderer";
import { canvas } from "../pixi/colorTokens";

vi.mock("pixi.js", () => {
  class FakeBitmapText {}
  class FakeGraphics {
    circle() { return this; }
    fill() { return this; }
    clear() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    stroke() { return this; }
    poly() { return this; }
    on() { return this; }
  }
  class FakeContainer {
    addChild() {}
    destroy() {}
  }
  return { Container: FakeContainer, Graphics: FakeGraphics, BitmapText: FakeBitmapText };
});

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
}));

describe("nodeColor", () => {
  it("returns selected color when id matches selectedNode", () => {
    expect(nodeColor(5, 5, 1, 2)).toBe(canvas.node.selected);
  });

  it("selected takes priority over start", () => {
    expect(nodeColor(1, 1, 1, 2)).toBe(canvas.node.selected);
  });

  it("selected takes priority over finish", () => {
    expect(nodeColor(2, 2, 1, 2)).toBe(canvas.node.selected);
  });

  it("returns start color when id matches start and not selected", () => {
    expect(nodeColor(1, null, 1, 2)).toBe(canvas.node.start);
  });

  it("returns finish color when id matches finish and not selected", () => {
    expect(nodeColor(2, null, 1, 2)).toBe(canvas.node.finish);
  });

  it("returns start over finish when id matches both (start check first)", () => {
    expect(nodeColor(5, null, 5, 5)).toBe(canvas.node.start);
  });

  it("returns default color for regular node", () => {
    expect(nodeColor(3, null, 1, 2)).toBe(canvas.node.default);
  });

  it("returns default color when all nulls", () => {
    expect(nodeColor(0, null, null, null)).toBe(canvas.node.default);
  });

  it("returns start color with null finish", () => {
    expect(nodeColor(1, null, 1, null)).toBe(canvas.node.start);
  });

  it("returns finish color with null start", () => {
    expect(nodeColor(2, null, null, 2)).toBe(canvas.node.finish);
  });
});
