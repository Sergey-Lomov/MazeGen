import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingScreen } from "../components/LoadingScreen";

describe("LoadingScreen", () => {
  it("exposes a determinate progress bar to assistive technology", () => {
    render(<LoadingScreen status="Loading engine" progress={0.42} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading engine");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });

  it("keeps an indeterminate progress bar without a numeric value", () => {
    render(<LoadingScreen status="Preparing graphics" />);

    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
});
