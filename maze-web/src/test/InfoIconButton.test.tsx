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

  it.each(["Enter", " "])("activates on %j and suppresses the browser default (page scroll)", (key) => {
    const onClick = vi.fn();
    render(<InfoIconButton onClick={onClick} label="Info" />);
    const notPrevented = fireEvent.keyDown(screen.getByRole("button", { name: "Info" }), { key });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("ignores other keys and leaves their default alone", () => {
    const onClick = vi.fn();
    render(<InfoIconButton onClick={onClick} label="Info" />);
    const notPrevented = fireEvent.keyDown(screen.getByRole("button", { name: "Info" }), { key: "Tab" });
    expect(onClick).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});
