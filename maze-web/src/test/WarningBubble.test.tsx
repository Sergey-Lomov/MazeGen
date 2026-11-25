import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WarningBubble } from "../components/WarningBubble";

describe("WarningBubble dismiss", () => {
  it("shows a close button that calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<WarningBubble message="Check this" onDismiss={onDismiss} dismissTitle="Dismiss it" />);
    expect(screen.getByText("Check this")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss it" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("has no close button without onDismiss", () => {
    render(<WarningBubble message="Check this" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not trigger onInfo when the close button is clicked", () => {
    const onInfo = vi.fn();
    render(<WarningBubble message="Check this" onInfo={onInfo} onDismiss={() => {}} dismissTitle="Dismiss it" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss it" }));
    expect(onInfo).not.toHaveBeenCalled();
  });
});
