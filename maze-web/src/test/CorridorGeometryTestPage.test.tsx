import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CorridorGeometryTestPage, PROBLEM_TYPES, labCellGeometry } from "../components/CorridorGeometryTestPage";
import { contourToPolyline } from "../pixi/imageExport/vectorByCorridorsContour";
import { convexPolygonOutsideDistance } from "./polygonTestHelpers";

// Cell centres come from wasm, unavailable here — mock with the square identity formula. It is only
// geometrically correct for square cells; other tessellations are exercised here for UI structure
// only (`corridorLabParity.test.ts` compares their geometry on the real wasm build).
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

describe("CorridorGeometryTestPage", () => {
  const cards = () => screen.getAllByRole("button", { name: /^Enlarge / });

  it("renders every face-port combination of the selected tessellation", () => {
    render(<CorridorGeometryTestPage />);
    expect(cards()).toHaveLength(16); // square: 2^4
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "hex" } });
    expect(cards()).toHaveLength(64); // hex: 2^6
  });

  it("draws one filled contour per non-empty combination", () => {
    render(<CorridorGeometryTestPage />);
    const filled = (name: string) => screen.getByRole("img", { name }).querySelectorAll("path[fill]").length;
    expect(filled("Square combination 0000")).toBe(0);
    expect(filled("Square combination 0101")).toBe(1);
  });

  it("opens an enlarged card whose debug overlays can all be toggled on", () => {
    render(<CorridorGeometryTestPage />);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge Square combination 0111" }));
    const dialog = screen.getByRole("dialog");
    const svg = within(dialog).getByRole("img");
    const before = svg.querySelectorAll("*").length;
    for (const toggle of within(dialog).getAllByRole("switch")) fireEvent.click(toggle);
    expect(within(dialog).getAllByRole("switch").every((toggle) => toggle.getAttribute("aria-checked") === "true")).toBe(true);
    expect(within(dialog).getByRole("img").querySelectorAll("*").length).toBeGreaterThan(before);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("frames each card by its cell alone: thickness keeps the frame, cell size scales it", () => {
    render(<CorridorGeometryTestPage />);
    const viewBox = () => screen.getByRole("img", { name: "Square combination 0001" }).getAttribute("viewBox")!.split(" ").map(Number);
    const [, , , size] = viewBox();
    fireEvent.change(screen.getByRole("slider", { name: /Corridor thickness/ }), { target: { value: "40" } });
    expect(viewBox()[3]).toBe(size);
    const cellSizeSlider = screen.getByRole("slider", { name: /Cell size/ });
    expect(cellSizeSlider).toHaveValue("40"); // square cells have 40px faces
    fireEvent.change(cellSizeSlider, { target: { value: "20" } });
    // The frame is the cell's bounding square plus a fixed 16px margin.
    expect(viewBox()[3]).toBeCloseTo((size - 16) / 2 + 16, 9);
  });

  it("keeps the cell size per tessellation", () => {
    render(<CorridorGeometryTestPage />);
    const cellSizeSlider = () => screen.getByRole("slider", { name: /Cell size/ });
    fireEvent.change(cellSizeSlider(), { target: { value: "25" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "hex" } });
    expect(cellSizeSlider()).not.toHaveValue("25");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "square" } });
    expect(cellSizeSlider()).toHaveValue("25");
  });

  it("opens a card from the keyboard and closes the enlarged view by its button or the backdrop", () => {
    render(<CorridorGeometryTestPage />);
    const card = screen.getByRole("button", { name: "Enlarge Square combination 0011" });
    fireEvent.keyDown(card, { key: "a" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.mouseDown(screen.getByRole("dialog")); // inside the dialog: stays open
    fireEvent.keyDown(document, { key: "a" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close enlarged sample" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the corner radius slider reshapes the junction corners", () => {
    render(<CorridorGeometryTestPage />);
    const contour = () => screen.getByRole("img", { name: "Square combination 0111" }).querySelector("path[fill]")!.getAttribute("d");
    const rounded = contour();
    fireEvent.change(screen.getByRole("slider", { name: /Junction corner radius/ }), { target: { value: "0" } });
    expect(contour()).not.toBe(rounded);
  });

  it("the cell outline debug layer redraws the cell border over the corridor", () => {
    render(<CorridorGeometryTestPage />);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge Square combination 0101" }));
    const dialog = screen.getByRole("dialog");
    const outlines = () => within(dialog).getByRole("img").querySelectorAll("polygon[stroke-dasharray]").length;
    expect(outlines()).toBe(0);
    fireEvent.click(within(dialog).getByRole("switch", { name: "Cell outline on top" }));
    expect(outlines()).toBe(1);
  });
});

describe("overflow problems view", () => {
  it("shows each problem type as its description followed by five ordinary cards", () => {
    render(<CorridorGeometryTestPage />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "problems" } });
    for (const problem of PROBLEM_TYPES) {
      expect(screen.getByRole("heading", { name: problem.title })).toBeInTheDocument();
      expect(screen.getByText(problem.description)).toBeInTheDocument();
      expect(problem.examples).toHaveLength(5);
      for (const example of problem.examples) {
        expect(screen.getByRole("button", { name: new RegExp(`^Enlarge ${example.cell.label} combination`) })).toBeInTheDocument();
      }
    }
    expect(screen.queryByRole("slider", { name: /Corridor thickness/ })).not.toBeInTheDocument();
  });

  it("opens an example enlarged with its own thickness", () => {
    render(<CorridorGeometryTestPage />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "problems" } });
    const [example] = PROBLEM_TYPES[0].examples;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Enlarge ${example.cell.label} combination`) }));
    expect(within(screen.getByRole("dialog")).getByText(new RegExp(`thickness ${example.thickness}px`))).toBeInTheDocument();
  });
});

// Each example once left its cell; they now pin down the fix (the closure becomes the deepest arc
// between the two side ends that fits, `deepestChordArc`).
describe("overflow problem examples stay inside their cell", () => {
  it.each(PROBLEM_TYPES.flatMap((problem) => problem.examples.map((example) => [example.cell.label, example] as const)))("%s", (_label, example) => {
    const { geometry, thickness } = labCellGeometry(example.cell, example.mask, example.thickness, 4);
    expect(thickness).toBe(example.thickness); // not narrowed by the shortest-face clamp
    const contour = geometry!.contour[0];
    expect(Math.max(...contourToPolyline(contour, 0.25).map((point) => convexPolygonOutsideDistance(point, example.cell.polygon)))).toBeLessThan(1e-6);
    // The closure no longer runs around the junction target.
    expect(contour.cmds.some((command) => command.kind === "arc" && Math.hypot(command.c.x - geometry!.target.x, command.c.y - geometry!.target.y) < 1e-6)).toBe(false);
  });
});
