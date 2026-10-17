import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LinkStatusIcon } from "../components/LinkStatusIcon";
import { getTooltipAnchor } from "./tooltipTestUtils";
import { useMazeStore } from "../store/mazeStore";
import type { ParamDescriptor, ParamLink } from "../store/parameterLinks";
import { ui } from "../styles/theme";

type P = "a" | "b" | "c";

const registry: Record<P, ParamDescriptor> = {
  a: { type: "number", equals: Object.is, label: "A", group: [], format: String },
  b: { type: "number", equals: Object.is, label: "B", group: [], format: String },
  c: { type: "number", equals: Object.is, label: "C", group: [], format: String },
};

function link(overrides: Partial<ParamLink<P>>): ParamLink<P> {
  return { id: "l1", source: "a", target: "b", enabled: true, ...overrides };
}

function renderIcon(target: P | null, links: ParamLink<P>[]) {
  return render(
    <LinkStatusIcon<P>
      target={target}
      links={links}
      registry={registry}
      onSetLinkEnabled={vi.fn()}
      onAddLink={vi.fn()}
      activePaths={new Set<P>(["a", "b", "c"])}
    />,
  );
}

// Regression coverage for GitHub issue #652 — LinkStatusIcon's branching visual states had zero
// tests despite driving the chain-icon color, corner badges, and tooltip header across ~8 distinct
// states. These assert the observable DOM (title attribute, rendered SVGs via lucide's data-* attrs
// aren't exposed, so we assert via title text + badge presence) rather than internal booleans.
describe("LinkStatusIcon", () => {
  beforeEach(() => {
    useMazeStore.setState({ linkIconVisibility: "always" });
  });

  it("lists numeric modifiers of the driving and dependent links in the tooltip", () => {
    renderIcon("b", [
      link({ modifiers: [{ op: "mul", value: 2 }] }),
      link({ id: "l2", source: "b", target: "c", modifiers: [{ op: "add", value: 3 }] }),
    ]);
    const title = document.getElementById(getTooltipAnchor(/Driving link/).getAttribute("aria-describedby")!)?.textContent ?? "";
    expect(title).toContain("A × 2");
    expect(title).toContain("C + 3");
  });

  it("lists color modifiers of the driving link in the tooltip", () => {
    renderIcon("b", [link({ colorModifiers: [{ model: "oklch", channel: "oklch-l", op: "sub", value: 15 }] })]);
    expect(document.getElementById(getTooltipAnchor(/Driving link/).getAttribute("aria-describedby")!)?.textContent).toContain("− 15");
  });

  it("lists modifiers of a derived link in group mode", () => {
    render(
      <LinkStatusIcon<P>
        target="b"
        links={[link({ modifiers: [{ op: "mul", value: 2 }] })]}
        registry={registry}
        onSetLinkEnabled={vi.fn()}
        onAddLink={vi.fn()}
        activePaths={new Set<P>(["a", "b", "c"])}
        onToggleLink={vi.fn()}
        alwaysVisible
      />,
    );
    expect(document.getElementById(getTooltipAnchor(/Driving link/).getAttribute("aria-describedby")!)?.textContent).toContain("A × 2");
  });

  it("renders the unsupported state with a red X badge when target is null", () => {
    renderIcon(null, []);
    const icon = getTooltipAnchor(/Links not supported/);
    expect(icon.querySelector("svg")).toBeTruthy();
  });

  it("renders no badge at all when the field is linkable but has no link", () => {
    const { container } = renderIcon("b", []);
    expect(getTooltipAnchor(/No links/)).toBeTruthy();
    // Only the chain glyph's own <svg> — no corner-badge <svg> alongside it.
    expect(container.querySelectorAll("svg").length).toBe(1);
  });

  it("shows the driving-disabled header and no badge when overridden with no dependents", () => {
    renderIcon("b", [link({ enabled: false })]);
    expect(getTooltipAnchor(/Driving link disabled/)).toBeTruthy();
  });

  it("uses semantic colors for status and dims disabled link details", () => {
    renderIcon("b", [link({ enabled: false })]);
    const description = document.getElementById(getTooltipAnchor(/Driving link disabled/).getAttribute("aria-describedby")!);
    const [header, detail] = [...(description?.children ?? [])] as HTMLElement[];
    expect(header).toHaveStyle({ color: ui.text.disabled });
    expect(detail).toHaveStyle({ color: ui.text.disabled });
  });

  it("uses the success color for an active driving-link status", () => {
    renderIcon("b", [link({ enabled: true })]);
    const description = document.getElementById(getTooltipAnchor(/Driving link active/).getAttribute("aria-describedby")!);
    expect(description?.firstElementChild).toHaveStyle({ color: ui.text.success });
  });

  it("uses semantic colors for dependents-only and unlinked statuses", () => {
    renderIcon("a", [link({ source: "a", target: "b", enabled: true })]);
    const dependentsOnly = document.getElementById(getTooltipAnchor(/No driving link/).getAttribute("aria-describedby")!);
    expect(dependentsOnly?.firstElementChild).toHaveStyle({ color: ui.text.info });

    renderIcon("c", []);
    const unlinked = document.getElementById(getTooltipAnchor(/No links/).getAttribute("aria-describedby")!);
    expect(unlinked?.firstElementChild).toHaveStyle({ color: ui.text.primary });
  });

  it("uses an error heading and tertiary explanation for unsupported links", () => {
    renderIcon(null, []);
    const description = document.getElementById(getTooltipAnchor(/Links not supported/).getAttribute("aria-describedby")!);
    const [header, hint] = [...(description?.children ?? [])] as HTMLElement[];
    expect(header).toHaveStyle({ display: "block", color: ui.text.error });
    expect(hint).toHaveStyle({ display: "block", color: ui.text.tertiary });
  });

  it("uses a wider, capped bubble only for link-status tooltips", () => {
    renderIcon("b", [link({ enabled: true })]);
    fireEvent.focus(getTooltipAnchor(/Driving link active/));
    expect(screen.getByTestId("tooltip")).toHaveStyle({ width: "max-content", maxWidth: "560px", overflowWrap: "anywhere" });
  });

  it("shows the driving-active header when the driving link is enabled", () => {
    renderIcon("b", [link({ enabled: true })]);
    expect(getTooltipAnchor(/Driving link active/)).toBeTruthy();
  });

  it("shows 'No driving link' when the field is only ever a source", () => {
    renderIcon("a", [link({ source: "a", target: "b", enabled: true })]);
    expect(getTooltipAnchor(/No driving link/)).toBeTruthy();
  });

  it("respects linkIconVisibility=never by rendering nothing", () => {
    useMazeStore.setState({ linkIconVisibility: "never" });
    const { container } = renderIcon("b", [link({ enabled: true })]);
    expect(container.firstChild).toBeNull();
  });

  it("respects linkIconVisibility=linked by hiding unlinked fields", () => {
    useMazeStore.setState({ linkIconVisibility: "linked" });
    const { container } = renderIcon("b", []);
    expect(container.firstChild).toBeNull();
  });

  it("respects linkIconVisibility=linked by still showing linked fields", () => {
    useMazeStore.setState({ linkIconVisibility: "linked" });
    renderIcon("b", [link({ enabled: true })]);
    expect(getTooltipAnchor(/Driving link active/)).toBeTruthy();
  });

  it("uses a custom unsupportedHint over the generic one", () => {
    render(
      <LinkStatusIcon<P>
        target={null}
        links={[]}
        registry={registry}
        onSetLinkEnabled={vi.fn()}
        onAddLink={vi.fn()}
        activePaths={new Set<P>(["a", "b", "c"])}
        unsupportedHint="Custom explanation"
      />,
    );
    expect(getTooltipAnchor(/Custom explanation/)).toBeTruthy();
  });
});
