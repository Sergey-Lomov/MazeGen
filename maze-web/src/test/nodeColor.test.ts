import { describe, it, expect, vi } from "vitest";
import { nodeColor } from "../pixi/MazeRenderer";

vi.mock("pixi.js", () => {
  class FakeTextStyle {}
  class FakeText {}
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
  return { Container: FakeContainer, Graphics: FakeGraphics, Text: FakeText, TextStyle: FakeTextStyle };
});

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
}));

const NODE_COLOR = 0x4a9eff;
const NODE_SELECTED_COLOR = 0xff4a4a;
const NODE_START_COLOR = 0x44dd88;
const NODE_FINISH_COLOR = 0xdd4466;

describe("nodeColor", () => {
  it("returns selected color when id matches selectedNode", () => {
    expect(nodeColor(5, 5, 1, 2)).toBe(NODE_SELECTED_COLOR);
  });

  it("selected takes priority over start", () => {
    expect(nodeColor(1, 1, 1, 2)).toBe(NODE_SELECTED_COLOR);
  });

  it("selected takes priority over finish", () => {
    expect(nodeColor(2, 2, 1, 2)).toBe(NODE_SELECTED_COLOR);
  });

  it("returns start color when id matches start and not selected", () => {
    expect(nodeColor(1, null, 1, 2)).toBe(NODE_START_COLOR);
  });

  it("returns finish color when id matches finish and not selected", () => {
    expect(nodeColor(2, null, 1, 2)).toBe(NODE_FINISH_COLOR);
  });

  it("returns start over finish when id matches both (start check first)", () => {
    expect(nodeColor(5, null, 5, 5)).toBe(NODE_START_COLOR);
  });

  it("returns default color for regular node", () => {
    expect(nodeColor(3, null, 1, 2)).toBe(NODE_COLOR);
  });

  it("returns default color when all nulls", () => {
    expect(nodeColor(0, null, null, null)).toBe(NODE_COLOR);
  });

  it("returns start color with null finish", () => {
    expect(nodeColor(1, null, 1, null)).toBe(NODE_START_COLOR);
  });

  it("returns finish color with null start", () => {
    expect(nodeColor(2, null, null, 2)).toBe(NODE_FINISH_COLOR);
  });
});
