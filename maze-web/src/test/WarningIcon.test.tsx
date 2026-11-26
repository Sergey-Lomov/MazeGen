import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WarningIcon } from "../components/WarningIcon";
import * as m from "~/paraglide/messages";

const tooltipText = () => {
  const anchor = screen.getByTestId("tooltip-anchor");
  return document.getElementById(anchor.getAttribute("aria-describedby") ?? "");
};

describe("WarningIcon messages", () => {
  it("shows a single message as plain text without a heading or list", () => {
    render(<WarningIcon messages={["Only one"]} />);
    const tooltip = tooltipText();
    expect(tooltip?.textContent).toBe("Only one");
    expect(tooltip?.querySelector("ul")).toBeNull();
  });

  it("shows several messages as a bulleted list under a Warnings heading", () => {
    render(<WarningIcon messages={["First", "Second"]} />);
    const tooltip = tooltipText();
    expect(tooltip?.textContent).toContain(m["common.warnings_title"]());
    expect(Array.from(tooltip?.querySelectorAll("li") ?? []).map((item) => item.textContent)).toEqual(["First", "Second"]);
  });

  it("keeps the default and custom title behavior without messages", () => {
    render(<WarningIcon title="Custom" />);
    expect(tooltipText()?.textContent).toBe("Custom");
  });
});
