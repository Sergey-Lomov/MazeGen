import { describe, expect, it } from "vitest";
import { isFeatureCardConfirmShortcut } from "../components/keyboardShortcuts";

function resultFor(target: HTMLElement, init: KeyboardEventInit): boolean {
  let result = false;
  target.addEventListener("keydown", (event) => { result = isFeatureCardConfirmShortcut(event); });
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  return result;
}

describe("feature-card confirmation shortcuts", () => {
  it("takes precedence over focused non-text controls", () => {
    expect(resultFor(document.createElement("button"), { key: "Enter", code: "Enter" })).toBe(true);
    expect(resultFor(document.createElement("select"), { key: " ", code: "Space" })).toBe(true);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(resultFor(checkbox, { key: " ", code: "Space" })).toBe(true);
  });

  it("preserves text-entry keyboard behavior", () => {
    expect(resultFor(document.createElement("textarea"), { key: "Enter", code: "Enter" })).toBe(false);
    const input = document.createElement("input");
    input.type = "number";
    expect(resultFor(input, { key: " ", code: "Space" })).toBe(false);
  });
});
