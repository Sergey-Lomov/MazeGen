import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileNameModal, timestampedBaseName } from "../components/FileNameModal";
import * as m from "~/paraglide/messages";

describe("FileNameModal", () => {
  it("keeps the extension outside the editable generated name", () => {
    const onConfirm = vi.fn();
    render(<FileNameModal defaultBaseName="maze-project-18182000" extension=".maze" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: m["file_name.label"]() });
    expect(input).toHaveValue("maze-project-18182000");
    expect(screen.getByText(".maze")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "castle" } });
    fireEvent.click(screen.getByRole("button", { name: m["file_name.save"]() }));

    expect(onConfirm).toHaveBeenCalledWith("castle.maze");
  });

  it("disables saving for an empty or whitespace-only base name", () => {
    render(<FileNameModal defaultBaseName="maze-project" extension=".maze" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByRole("textbox", { name: m["file_name.label"]() }), { target: { value: "   " } });

    expect(screen.getByRole("button", { name: m["file_name.save"]() })).toBeDisabled();
  });

  it("uses a wide dialog for longer file names", () => {
    render(<FileNameModal defaultBaseName="maze-style-18080503" extension=".mazestyle" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(m["file_name.title"]()).parentElement?.parentElement).toHaveStyle({ width: "min(460px, calc(100vw - 32px))" });
  });

  it("builds a compact local timestamp", () => {
    expect(timestampedBaseName("maze-project", new Date(2026, 10, 18, 8, 5, 3))).toBe("maze-project-18080503");
  });
});
