import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WarningsSection } from "../components/WarningsSection";

describe("WarningsSection", () => {
  it("stays visible and collapsed when there are no warnings", () => {
    render(<WarningsSection warnings={[]} testId="warnings" />);

    const section = screen.getByTestId("warnings");
    expect(section).toHaveTextContent("Warnings (0)");
    expect(section.querySelector("[style*='border-width: 1px']")).toBeNull();

    fireEvent.click(screen.getByText("Warnings (0)"));
    expect(section.querySelector("[style*='border-width: 1px']")).toBeNull();
  });
});
