import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SectionHeader } from "../components/SectionHeader";

describe("SectionHeader hit testing", () => {
  it("keeps its negative-margin spacing while positioning the row for reliable pointer events", () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Filters" expanded={false} onToggle={onToggle} />);

    const row = screen.getByText("Filters").parentElement!;
    expect(row).toHaveStyle({ position: "relative", margin: "-4px 0" });

    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks and drops hover/clickable markers while disabled", () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Details" expanded={false} disabled onToggle={onToggle} />);

    const row = screen.getByText("Details").parentElement!;
    expect(row).toHaveStyle({ position: "relative" });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toHaveClass("hoverable");

    fireEvent.click(row);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
