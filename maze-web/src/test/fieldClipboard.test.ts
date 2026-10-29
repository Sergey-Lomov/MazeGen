import { describe, expect, it } from "vitest";
import { fieldClipboardBlock } from "../pixi/fieldClipboard";
import { fieldOf } from "./fieldConfigFixtures";

const square = fieldOf("square", { shape: "rect", cols: 3, rows: 3 }).tessellation;
const radial = fieldOf("radial", { shape: "custom", points: [] }).tessellation;

describe("fieldClipboardBlock", () => {
  it("copy needs a selection", () => {
    expect(fieldClipboardBlock("copy", square, false, true)).toBe("no_selection");
    expect(fieldClipboardBlock("copy", square, true, false)).toBeNull();
  });

  it("paste needs a clipboard", () => {
    expect(fieldClipboardBlock("paste", square, true, false)).toBe("empty_clipboard");
    expect(fieldClipboardBlock("paste", square, false, true)).toBeNull();
  });

  it("the tessellation reason wins over the others", () => {
    expect(fieldClipboardBlock("copy", radial, false, false)).toBe("tessellation");
    expect(fieldClipboardBlock("paste", radial, false, false)).toBe("tessellation");
  });
});
