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

  it("keeps the layout with — for the numbers when only the cell types are known", () => {
    render(<CellSizesSection sizes={[]} tessellationKind="square" placeholderTypes={["triangle", "hexagon"]} />);
    expect(screen.getByText("Triangle")).toBeInTheDocument();
    expect(screen.getByText("Hexagon")).toBeInTheDocument();
    expect(screen.getAllByText(/Side — mm|Сторона — мм/)).toHaveLength(2);
    expect(screen.getAllByText(/Diameter — mm|Диаметр — мм/)).toHaveLength(2);
  });

  it("replaces the numbers with indicators while loading, keeping the type names", () => {
    render(<CellSizesSection sizes={[type("triangle"), type("hexagon")]} tessellationKind="square" placeholderTypes={["triangle", "hexagon"]} loading />);
    expect(screen.getByText("Triangle")).toBeInTheDocument();
    expect(screen.getAllByTestId("value-skeleton")).toHaveLength(4);
    expect(screen.getAllByText(/Side|Сторона/)).toHaveLength(2);
    expect(screen.getAllByText(/Diameter|Диаметр/)).toHaveLength(2);
    expect(screen.queryByText(/8\.0/)).toBeNull();
  });

  it("keeps the rows of the answer on screen while loading, not the types of the tessellation", () => {
    render(<CellSizesSection sizes={[type("triangle"), type("hexagon")]} tessellationKind="square" placeholderTypes={["triangle", "hexagon", "square"]} loading />);
    expect(screen.queryByText("Square")).toBeNull();
    expect(screen.getAllByTestId("value-skeleton")).toHaveLength(4);
  });

  it("renders nothing when the types are not known and the cells are regular", () => {
    const { container } = render(<CellSizesSection sizes={[]} tessellationKind="square" placeholderTypes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a row of — for one known type", () => {
    render(<CellSizesSection sizes={[]} tessellationKind="square" placeholderTypes={["cell"]} />);
    expect(screen.getByText(/Side — mm|Сторона — мм/)).toBeInTheDocument();
    expect(screen.getByText(/Diameter — mm|Диаметр — мм/)).toBeInTheDocument();
    expect(screen.getByText(/^(Cell|Ячейка)$/)).toBeInTheDocument();
  });

  it("shows the explanation at once for an irregular tessellation", () => {
    render(<CellSizesSection sizes={[]} tessellationKind="voronoi" placeholderTypes={["cell"]} cellsVary />);
    expect(screen.getByText(/average cell size|средний размер ячейки/i)).toBeInTheDocument();
  });

  it("lists a single type as a table row with its name and one decimal", () => {
    render(<CellSizesSection sizes={[type("cell")]} tessellationKind="square" />);
    expect(screen.getByText(/Cell sizes|Размеры ячеек/)).toBeInTheDocument();
    expect(screen.getByText(/^(Cell|Ячейка)$/)).toBeInTheDocument();
    expect(screen.getByText(/8\.0/)).toBeInTheDocument();
    expect(screen.getByText(/11\.3/)).toBeInTheDocument();
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
    expect(screen.getByText(/average cell size|средний размер ячейки/i)).toBeInTheDocument();
    expect(screen.queryByText(/Diameter|Диаметр/)).toBeNull();
  });

  it("explains a radial field's size as the ring thickness", () => {
    render(<CellSizesSection sizes={[type("cell", { regular: false, sidesMm: [], diameterMm: 0 })]} tessellationKind="radial" />);
    expect(screen.getByText(/thickness of a ring|толщина кольца/)).toBeInTheDocument();
    expect(screen.queryByText(/average cell size|средний размер ячейки/i)).toBeNull();
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
