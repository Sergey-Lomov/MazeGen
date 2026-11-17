import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InfoIconButton } from "../components/InfoIconButton";

describe("InfoIconButton", () => {
  it("activates on click", () => {
    const onClick = vi.fn();
    render(<InfoIconButton onClick={onClick} label="Info" />);
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is a native button, so Enter and Space activate it through the browser", () => {
    render(<InfoIconButton onClick={() => {}} label="Info" />);
    const icon = screen.getByRole("button", { name: "Info" }) as HTMLButtonElement;
    expect(icon.tagName).toBe("BUTTON");
    expect(icon.type).toBe("button");
  });

  it("is a tab stop and highlights on hover by default", () => {
    render(<InfoIconButton onClick={() => {}} label="Info" />);
    const icon = screen.getByRole("button", { name: "Info" });
    expect(icon.tabIndex).toBe(0);
    expect(icon.classList.contains("btn-flat-icon-no-hover")).toBe(false);
  });

  it("drops the hover highlight when told so", () => {
    render(<InfoIconButton onClick={() => {}} label="Info" hoverable={false} />);
    expect(screen.getByRole("button", { name: "Info" }).classList.contains("btn-flat-icon-no-hover")).toBe(true);
  });

  it("in a list is no tab stop and keeps the click from reaching the row or taking focus", () => {
    const onClick = vi.fn();
    const onRowClick = vi.fn();
    render(<div onClick={onRowClick}><InfoIconButton inList onClick={onClick} label="Info" /></div>);
    const icon = screen.getByRole("button", { name: "Info" });
    expect(icon.tabIndex).toBe(-1);
    expect(fireEvent.mouseDown(icon)).toBe(false);
    fireEvent.click(icon);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
