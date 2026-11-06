import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmbeddedHotkeyHint } from "../components/EmbeddedHotkeyHint";

describe("EmbeddedHotkeyHint", () => {
  it("renders a centered keycap column beside left-aligned text", () => {
    render(<EmbeddedHotkeyHint keys={["Ctrl"]}>Move the canvas.</EmbeddedHotkeyHint>);

    const text = screen.getByText("Move the canvas.");
    const root = text.parentElement;
    expect(root).toHaveStyle({ display: "grid", gridTemplateColumns: "48px minmax(0, 1fr)", alignItems: "center" });
    expect(text).toHaveStyle({ textAlign: "left" });
    expect(screen.getByLabelText("Shortcut: Ctrl").parentElement).toHaveStyle({ justifyContent: "center" });
  });
});
