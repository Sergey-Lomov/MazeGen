import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CellSizesSection, typeBreakdown } from "../components/dialogs/CellSizesSection";
import type { PrintCellTypeSize } from "../pixi/printCellSizes";

function type(key: string, overrides: Partial<PrintCellTypeSize> = {}): PrintCellTypeSize {
  return { key, count: 10, sidesMm: [8], diameterMm: 11.3137, regular: true, ...overrides };
}

describe("CellSizesSection", () => {
  it("renders nothing without cell types", () => {
    const { container } = render(<CellSizesSection sizes={[]} tessellationKind="square" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("describes a single type in one line with one decimal", () => {
    render(<CellSizesSection sizes={[type("cell")]} tessellationKind="square" />);
    expect(screen.getByText(/8\.0.*11\.3/)).toBeInTheDocument();
  });

  it("lists every type of a mixed tessellation with prefixed values", () => {
    render(<CellSizesSection sizes={[type("triangle", { sidesMm: [6] }), type("hexagon", { sidesMm: [6, 4.5] })]} tessellationKind="square" />);
    expect(screen.getByText("Triangle")).toBeInTheDocument();
    expect(screen.getByText("Hexagon")).toBeInTheDocument();
    expect(screen.getByText(/6\.0 \/ 4\.5/)).toBeInTheDocument();
  });

  it("marks only a too small side with a warning icon", () => {
    render(<CellSizesSection sizes={[type("triangle", { sidesMm: [3] }), type("hexagon", { sidesMm: [8] })]} tessellationKind="square" />);
    expect(screen.getAllByText("⚠")).toHaveLength(1);
  });

  it("shows only the explanation when a type is irregular", () => {
    render(<CellSizesSection sizes={[type("cell", { regular: false, sidesMm: [], diameterMm: 0 })]} tessellationKind="square" />);
    expect(screen.getByText(/nominal|условный/)).toBeInTheDocument();
    expect(screen.queryByText(/Diameter|Диаметр/)).toBeNull();
  });

  it("explains a radial field's size as the ring thickness", () => {
    render(<CellSizesSection sizes={[type("cell", { regular: false, sidesMm: [], diameterMm: 0 })]} tessellationKind="radial" />);
    expect(screen.getByText(/thickness of a ring|толщина кольца/)).toBeInTheDocument();
    expect(screen.queryByText(/nominal|условный/)).toBeNull();
  });
});

describe("typeBreakdown", () => {
  it("is empty for a single type", () => {
    expect(typeBreakdown([type("cell")])).toBe("");
  });

  it("lists the count of each type", () => {
    expect(typeBreakdown([type("triangle", { count: 600 }), type("square", { count: 300 })])).toBe("Triangle 600, Square 300");
  });
});
