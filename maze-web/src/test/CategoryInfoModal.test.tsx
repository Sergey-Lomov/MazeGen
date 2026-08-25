import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryInfoModal } from "../components/CategoryInfoModal";

describe("CategoryInfoModal", () => {
  it("renders the title and every param's label and description", () => {
    render(
      <CategoryInfoModal
        title="Teleport"
        params={[
          { label: "Chance", description: "How often a teleport is added." },
          { label: "One-way chance", description: "How often a teleport is one-way." },
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Teleport")).toBeInTheDocument();
    expect(screen.getByText("Chance")).toBeInTheDocument();
    expect(screen.getByText("How often a teleport is added.")).toBeInTheDocument();
    expect(screen.getByText("One-way chance")).toBeInTheDocument();
    expect(screen.getByText("How often a teleport is one-way.")).toBeInTheDocument();
  });
});
