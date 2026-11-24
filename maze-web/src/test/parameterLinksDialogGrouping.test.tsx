import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParameterLinksDialog } from "../components/features/ParameterLinksDialog";
import type { ParamDescriptor, ParamLink } from "../store/parameterLinks";

type P = "a" | "b" | "c";

const registry: Record<P, ParamDescriptor> = {
  a: { type: "number", equals: Object.is, label: "Alpha", group: ["First"], format: String },
  b: { type: "number", equals: Object.is, label: "Beta", group: ["Second"], format: String },
  c: { type: "number", equals: Object.is, label: "Gamma", group: ["Shared"], format: String },
};

// Both links read from "c", so filtering by "Shared" matches them across two different sections.
const links: ParamLink<P>[] = [
  { id: "l1", source: "c", target: "a", enabled: true },
  { id: "l2", source: "c", target: "b", enabled: true },
];

function renderDialog() {
  render(
    <ParameterLinksDialog<P>
      registry={registry}
      settings={{ a: 1, b: 2, c: 3 }}
      links={links}
      onSetLinkEnabled={vi.fn()}
      onAddLink={vi.fn()}
      onRemoveLink={vi.fn()}
      onClose={vi.fn()}
      activePaths={new Set<P>(["a", "b", "c"])}
    />,
  );
}

// GitHub issue #1081 — grouping is dropped while the breadcrumb filter is active.
describe("ParameterLinksDialog grouping", () => {
  it("groups links into collapsed sections by the target's top-level segment while unfiltered", () => {
    renderDialog();
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("shows every matching link in one flat list while filtered", () => {
    renderDialog();
    fireEvent.click(screen.getByText("First"));
    fireEvent.click(screen.getByText("Shared"));

    // "Second" was never expanded, yet its link shows: sections are gone while the filter is active.
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
  });
});
