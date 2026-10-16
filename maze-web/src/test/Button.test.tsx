import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../components/Button";
import { ToolIconButton } from "../components/ToolIconButton";
import { ui } from "../styles/theme";

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

  it("separates a tool explanation from its label", () => {
    render(
      <ToolIconButton selected danger title="Clear" description="Shift: delete all entities." onClick={() => {}}>
        <span aria-hidden="true">C</span>
      </ToolIconButton>,
    );

    const anchor = screen.getByTestId("tooltip-anchor");
    expect(document.getElementById(anchor.getAttribute("aria-describedby")!)?.textContent).toBe("ClearShift: delete all entities.");
    fireEvent.focus(anchor);
    const [title, description] = screen.getByTestId("tooltip").querySelectorAll("span");
    expect(title).toHaveStyle({ color: ui.text.primary });
    expect(description).toHaveStyle({ color: ui.text.tertiary });
  });
});
