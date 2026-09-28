import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureCard } from "../components/FeatureCard";

describe("FeatureCard", () => {
  it("is clickable and hoverable when collapsed and available", () => {
    render(
      <FeatureCard title="Floors" status="set" expanded={false} onOpen={vi.fn()}>
        <div>body</div>
      </FeatureCard>,
    );

    const header = screen.getByRole("button");
    expect(header).not.toBeDisabled();
    expect(header.className).toBe("hoverable");
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("renders optional comment and subtitle text when provided", () => {
    render(
      <FeatureCard title="Floors" status="set" comment="2 floors" subtitle="auto-numbered" expanded={false} onOpen={vi.fn()} />,
    );

    expect(screen.getByText("2 floors")).toBeInTheDocument();
    expect(screen.getByText("auto-numbered")).toBeInTheDocument();
  });

  it("drops the hover highlight but stays clickable when already expanded", () => {
    render(
      <FeatureCard title="Floors" status="set" expanded={true} onOpen={vi.fn()}>
        <div>body</div>
      </FeatureCard>,
    );

    const header = screen.getByRole("button");
    expect(header).not.toBeDisabled();
    expect(header.className).toBe("hoverable-off");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("disables the header and never shows a hover class when status is unavailable", () => {
    render(
      <FeatureCard title="Floors" status="unavailable" expanded={false} onOpen={vi.fn()}>
        <div>body</div>
      </FeatureCard>,
    );

    const header = screen.getByRole("button");
    expect(header).toBeDisabled();
    expect(header.className).toBe("");
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("stays disabled with no hover class even if expanded is forced true while unavailable", () => {
    render(
      <FeatureCard title="Floors" status="unavailable" expanded={true} onOpen={vi.fn()}>
        <div>body</div>
      </FeatureCard>,
    );

    const header = screen.getByRole("button");
    expect(header).toBeDisabled();
    expect(header.className).toBe("");
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });
});
