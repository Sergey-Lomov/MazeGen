import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "../components/ConfirmModal";
import * as m from "~/paraglide/messages";

describe("ConfirmModal", () => {
  it("renders the standard confirmation layout when a message is provided", () => {
    render(
      <ConfirmModal message="Discard changes?" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText(m["common.confirm"]())).toBeInTheDocument();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(screen.getByText(m["common.ok"]()).parentElement?.style.borderTop).toContain("1px solid");
    expect(screen.getByRole("button", { name: m["common.cancel"]() })).toHaveStyle({ minWidth: "80px" });
    expect(screen.getByRole("button", { name: m["common.ok"]() })).toHaveStyle({ minWidth: "80px" });
  });

  it("renders a compact confirmation layout when only a title is provided", () => {
    render(
      <ConfirmModal title="Reset all" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("Reset all")).toBeInTheDocument();
    expect(screen.queryByText(m["common.confirm"]())).not.toBeInTheDocument();
    expect(screen.getByText(m["common.ok"]()).parentElement?.style.borderTop).toBe("");
  });
});
