import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SectionHeader, SubsectionHeader } from "../components/SectionHeader";

describe("SectionHeader hit testing", () => {
  it("keeps its negative-margin spacing while positioning the row for reliable pointer events", () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Filters" expanded={false} onToggle={onToggle} />);

    const row = screen.getByText("Filters").parentElement!;
    expect(row).toHaveStyle({ position: "relative", margin: "-4px 0" });

    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("applies the same hit-testing workaround to subsection headers", () => {
    render(<SubsectionHeader label="Details" expanded={false} onToggle={vi.fn()} />);

    expect(screen.getByText("Details").parentElement).toHaveStyle({ position: "relative" });
  });
});
