import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../components/Button";

describe("Button", () => {
  it("binds semantic variants to the shared CSS class without inline visual colors", () => {
    render(<Button variant="secondary" layoutStyle={{ width: "100%" }}>Cancel</Button>);

    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("btn-secondary");
    expect(button).toHaveStyle({ width: "100%" });
    expect(button.style.background).toBe("");
    expect(button.style.border).toBe("");
    expect(button.style.color).toBe("");
  });
});
