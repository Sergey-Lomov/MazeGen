import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToggleRow } from "../components/ToggleRow";
import { ui } from "../styles/theme";

// Regression coverage for the disabled-label styling branch (previously an inline
// `opacity: 0.4` hack layered on the muted color, replaced with the shared `disabled()`
// typography token so it matches every other disabled-text usage in the app, e.g. the
// Analytics Path section's "no route" notice).
describe("ToggleRow disabled styling", () => {
  it("uses the muted color when enabled", () => {
    render(<ToggleRow label="Maze" checked={false} onChange={vi.fn()} />);
    const label = screen.getByText("Maze");
    expect(label).toHaveStyle({ color: ui.text.secondary });
  });

  it("uses the disabled color, not opacity, when disabled", () => {
    render(<ToggleRow label="Cycles" checked={false} onChange={vi.fn()} disabled />);
    const label = screen.getByText("Cycles");
    expect(label).toHaveStyle({ color: ui.text.disabled });
    expect(label.style.opacity).toBe("");
  });
});
