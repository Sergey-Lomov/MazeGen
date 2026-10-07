import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../components/Button";
import { ToolIconButton } from "../components/ToolIconButton";

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

  it("keeps tool buttons clickable through the native button surface", () => {
    const onClick = vi.fn();
    render(
      <ToolIconButton selected title="Rectangle" onClick={onClick}>
        <span aria-hidden="true">R</span>
      </ToolIconButton>,
    );

    const button = screen.getByRole("button", { name: "Rectangle" });
    expect(button).toHaveClass("btn-tool-icon-selected");
    expect(button.querySelector(".tool-icon-face")).toBeInTheDocument();
    expect(button.querySelector(".tool-icon-content")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
