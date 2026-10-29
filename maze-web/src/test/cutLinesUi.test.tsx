import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import * as m from "~/paraglide/messages";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { cutLineSides } from "../pixi/imageExport/cutLines";
import { getCellCenter } from "../pixi/tessellationGeometry";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";
import { oneGlue, range } from "./seamFixtures";

const { ExportTopologyPanel } = await import("../components/features/ExportTopologyPanel");
const { ImageExportFeature } = await import("../components/features/ImageExportFeature");
const { SettingsSection } = await import("../components/features/SharedStyleSection");
const { CutLineDragController, activeCutLines, hasManualCutLine, cutEditingActive } = await import("../pixi/imageExport/CutLineDragController");
const { useMazeStore } = await import("../store/mazeStore");
const { DEFAULT_PNG_EXPORT_SETTINGS } = await import("../store/slices/imageExportSlice");
const { cutLineColors } = await import("../pixi/imageExport/cutLineStyle");
const { drawnSideSpans } = await import("../pixi/imageExport/cutLineSpans");
const { validateCutExportSettings } = await import("../store/projectExport/validateImageExport");
const { baseStoreState, TEST_FLOOR_ID } = await import("./storeTestHelpers");

// Cut lines (GitHub issue #859): settings validation, store actions, the inspector and the canvas
// drag controller, on the 6x5 square cylinder / Möbius of `cutLines.test.ts`.

const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });
const fold = (a: [number, number], aFace: number, b: [number, number], bFace: number, twist = false): WireFold => ({
  a: { cell: a, face_idx: aFace },
  b: { cell: b, face_idx: bFace },
  twist,
  group: 0,
});
const cylinder = (): WireTopology => oneGlue("square{}", range(ROWS).map((y) => fold([COLUMNS - 1, y], 0, [0, y], 2)));
const mobius = (): WireTopology => oneGlue("square{}", range(ROWS).map((y) => fold([COLUMNS - 1, y], 0, [0, ROWS - 1 - y], 2, true)));
type Lines = Record<string, Record<number, { mode: "none" | "auto" | "manual"; offset: number }>>;

function setState(topology: WireTopology | undefined, lines: Lines = {}) {
  useMazeStore.setState({
    ...baseStoreState(),
    activeFieldConfig: field,
    nodes: cells.map(([x, y], id) => ({ id, x, y, i: 0 })),
    floorTopology: topology ? { [TEST_FLOOR_ID]: topology } : {},
    openCard: "image_export",
    exportTopologyOpen: true,
    topologyHover: null,
    pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, cuts: { lines } },
  } as never);
  // After the store update: a topology change in the store resets the cartesian cache.
  if (topology) warmCartesianCache(field, topology);
}

const lineOffset = () => useMazeStore.getState().pngExportSettings.cuts.lines[TEST_FLOOR_ID]?.[0]?.offset;

describe("validateCutExportSettings", () => {
  it("falls back to defaults for a missing or non-object value", () => {
    expect(validateCutExportSettings(undefined, "p")).toEqual({ lines: {} });
    expect(validateCutExportSettings(5, "p")).toEqual({ lines: {} });
  });

  it("drops malformed, unknown-mode and none entries, and clamps offsets to [-1, 1]", () => {
    const result = validateCutExportSettings({
      lines: {
        floor: {
          0: { mode: "manual", offset: 7 },
          1: { mode: "manual", offset: -3 },
          2: { mode: "auto", offset: 0.5 },
          3: { mode: "none", offset: 0.5 },
          4: { mode: "diagonal", offset: 0.5 },
          5: 12,
          6: null,
          7: [],
          x: { mode: "auto", offset: 0 },
        },
        empty: { 0: { mode: "none", offset: 0 } },
        bad: 5,
        list: [],
      },
    }, "p");
    expect(result.lines).toEqual({
      floor: {
        0: { mode: "manual", offset: 1 },
        1: { mode: "manual", offset: -1 },
        2: { mode: "auto", offset: 0.5 },
      },
    });
  });

  it("ignores a non-object lines value", () => {
    expect(validateCutExportSettings({ lines: [1, 2] }, "p").lines).toEqual({});
  });
});

describe("setCutLine / setCutShowLines", () => {
  beforeEach(() => setState(cylinder()));

  it("sets, replaces and removes a line without touching the others", () => {
    const { setCutLine } = useMazeStore.getState();
    setCutLine("f", 0, { mode: "manual", offset: 0.3 });
    setCutLine("f", 1, { mode: "auto", offset: 0 });
    setCutLine("g", 0, { mode: "manual", offset: 0.1 });
    setCutLine("f", 0, { mode: "manual", offset: 0.6 });
    expect(useMazeStore.getState().pngExportSettings.cuts.lines).toEqual({
      f: { 0: { mode: "manual", offset: 0.6 }, 1: { mode: "auto", offset: 0 } },
      g: { 0: { mode: "manual", offset: 0.1 } },
    });
    setCutLine("f", 0, null);
    setCutLine("f", 1, { mode: "none", offset: 0 });
    setCutLine("g", 0, null);
    expect(useMazeStore.getState().pngExportSettings.cuts.lines).toEqual({});
  });
});

describe("reset renderer settings", () => {
  beforeEach(() => setState(cylinder()));

  it.each(["resetVectorByWallsSettings", "resetVectorByCorridorsSettings"] as const)("%s also clears the cut lines", (reset) => {
    useMazeStore.getState().setCutLine("f", 0, { mode: "manual", offset: 0.3 });
    useMazeStore.getState().setVectorByWallsShowCutLines(false);
    useMazeStore.getState().setVectorByCorridorsShowCutLines(false);
    useMazeStore.getState().setVectorByCorridorsCutLinesColor(0x123456);
    useMazeStore.getState()[reset]();
    expect(useMazeStore.getState().pngExportSettings.cuts).toEqual({ lines: {} });
    // The cut-line style is part of the render mode's settings and returns to its defaults with them.
    const settings = useMazeStore.getState()[reset === "resetVectorByWallsSettings" ? "vectorByWallsSettings" : "vectorByCorridorsSettings"];
    expect(settings).toMatchObject({ showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0x808080 });
  });
});

describe("cutLineColors", () => {
  const style = { showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0x123456 };

  it("gives every glue its own colour, or the single colour when the glue colour is off", () => {
    const topology = cylinder();
    warmCartesianCache(field, topology);
    const byGlue = cutLineColors(style, field, topology);
    expect(byGlue(0)).not.toBe(0x123456);
    // A glue without an arrow falls back to the single colour.
    expect(byGlue(99)).toBe(0x123456);
    expect(cutLineColors({ ...style, cutLinesGlueColor: false }, field, topology)(0)).toBe(0x123456);
  });
});

describe("stale cut lines", () => {
  it("keeps lines when the topology is untouched", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    expect(lineOffset()).toBe(0.5);
  });
});

describe("ExportTopologyPanel", () => {
  const glueCards = () => screen.queryAllByTestId("topology-glue");

  it("shows the glue cards with editing disabled and explained, each with its cut line editor", () => {
    setState(cylinder());
    render(<ExportTopologyPanel />);
    expect(glueCards()).toHaveLength(1);
    const reason = m["image_export.cuts.edit_unavailable"]();
    // The edit and the remove button both carry the reason as their tooltip.
    expect(screen.getAllByText(reason)).toHaveLength(2);
    expect((screen.getByRole("button", { name: reason }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("✎").closest("button") as HTMLButtonElement).disabled).toBe(true);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("none");
  });

  it("disables a non-translation glue and shows the reason", () => {
    setState(mobius());
    render(<ExportTopologyPanel />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(m["image_export.cuts.unavailable.not_translation"]())).toBeTruthy();
  });

  it("stores the chosen mode, and shows the position slider only in manual mode", () => {
    setState(cylinder());
    render(<ExportTopologyPanel />);
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "manual" } });
    expect(useMazeStore.getState().pngExportSettings.cuts.lines[TEST_FLOOR_ID]?.[0]?.mode).toBe("manual");
    expect(screen.getByRole("slider")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "none" } });
    expect(useMazeStore.getState().pngExportSettings.cuts.lines[TEST_FLOOR_ID]).toBeUndefined();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("hovers the glue of the card under the pointer, like the field editor's panel", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "auto", offset: 0 } } });
    render(<ExportTopologyPanel />);
    fireEvent.mouseEnter(glueCards()[0]);
    expect(useMazeStore.getState().topologyHover).toEqual({ glue: 0, fold: null });
    fireEvent.mouseLeave(glueCards()[0]);
    expect(useMazeStore.getState().topologyHover).toBeNull();
  });

  it("clears the hover and the open flag when closed", () => {
    setState(cylinder());
    render(<ExportTopologyPanel />);
    fireEvent.mouseEnter(glueCards()[0]);
    fireEvent.click(document.querySelector("svg.lucide-x")!.closest("button")!);
    expect(useMazeStore.getState().topologyHover).toBeNull();
    expect(useMazeStore.getState().exportTopologyOpen).toBe(false);
  });
});

describe("topology button of the render mode settings", () => {
  const settingsSection = () => (
    <SettingsSection
      onResetAll={() => {}}
      settings={{}}
      links={[]}
      registry={{}}
      onSetLinkEnabled={() => {}}
      onAddLink={() => {}}
      onRemoveLink={() => {}}
      activePaths={new Set<string>()}
    />
  );
  const openButton = () => screen.queryByRole("button", { name: m["topology.title"]() });

  it("is hidden without glues", () => {
    setState(undefined);
    useMazeStore.setState({ exportTopologyOpen: false } as never);
    render(settingsSection());
    expect(openButton()).toBeNull();
  });

  it("opens the export topology panel on a floor with glues", () => {
    setState(cylinder());
    useMazeStore.setState({ exportTopologyOpen: false } as never);
    render(settingsSection());
    fireEvent.click(openButton()!);
    expect(useMazeStore.getState().exportTopologyOpen).toBe(true);
  });
});

describe("export topology panel of the export card", () => {
  it("is shown with the glues and closes when they are gone", () => {
    setState(cylinder());
    useMazeStore.setState({ exportTopologyOpen: false } as never);
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    expect(screen.queryAllByTestId("topology-glue")).toHaveLength(0);
    act(() => useMazeStore.getState().setExportTopologyOpen(true));
    expect(screen.queryAllByTestId("topology-glue")).toHaveLength(1);
    act(() => useMazeStore.setState({ floorTopology: {} } as never));
    expect(useMazeStore.getState().exportTopologyOpen).toBe(false);
    expect(screen.queryAllByTestId("topology-glue")).toHaveLength(0);
  });
});

describe("CutLineDragController", () => {
  const viewport = { x: 0, y: 0, scale: { x: 1, y: 1 } };
  const pan = {
    calls: [] as string[],
    start() { this.calls.push("start"); },
    move() { this.calls.push("move"); },
    end() { this.calls.push("end"); },
  };
  const controller = () => {
    pan.calls = [];
    return new CutLineDragController(() => viewport as never, pan);
  };

  it("is active only for a manual line while the export topology panel is open", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "auto", offset: 0 } } });
    expect(cutEditingActive(useMazeStore.getState())).toBe(true);
    expect(hasManualCutLine(useMazeStore.getState())).toBe(false);
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    expect(hasManualCutLine(useMazeStore.getState())).toBe(true);
    useMazeStore.setState({ exportTopologyOpen: false } as never);
    expect(hasManualCutLine(useMazeStore.getState())).toBe(false);
    useMazeStore.setState({ exportTopologyOpen: true, openCard: "generation" } as never);
    expect(hasManualCutLine(useMazeStore.getState())).toBe(false);
  });

  it("drags a grabbed manual line along the period and clamps it to the allowed range", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const [{ line }] = activeCutLines(useMazeStore.getState());
    const [px, py] = line.point;
    const c = controller();
    c.onPointerDown(px, py, 0);
    expect(pan.calls).toEqual([]);

    // One period to the right of the line is far past the allowed range: clamped to maxOffset.
    c.onPointerMove(px + line.cut.period[0] * 3, py);
    expect(lineOffset()).toBeCloseTo(line.cut.maxOffset, 9);
    // The other way, past the cells' far border: clamped to minOffset.
    c.onPointerMove(px - line.cut.period[0] * 3, py);
    expect(lineOffset()).toBeCloseTo(line.cut.minOffset, 9);
    // Half way to the near border: the line follows the pointer.
    const target = line.cut.maxOffset / 2;
    c.onPointerMove(line.cut.origin[0] + line.cut.period[0] * target, py);
    expect(lineOffset()).toBeCloseTo(target, 9);

    c.onPointerUp();
    c.onPointerMove(px, py);
    expect(lineOffset()).toBeCloseTo(target, 9);
    expect(pan.calls).toEqual([]);
  });

  it("drags the twin side of a line just the same: it is the line one period over", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const [{ line }] = activeCutLines(useMazeStore.getState());
    const twin = cutLineSides(line)[1];
    const c = controller();
    c.onPointerDown(twin[0], twin[1], 0);
    expect(pan.calls).toEqual([]);
    // The twin follows the pointer: that far past the origin's twin puts the line at that offset.
    const target = line.cut.maxOffset / 2;
    c.onPointerMove(line.cut.origin[0] + line.cut.period[0] * (1 + target), twin[1]);
    expect(lineOffset()).toBeCloseTo(target, 9);
    c.onPointerUp();
  });

  it("pans, without moving the line, when the press misses it", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const [{ line }] = activeCutLines(useMazeStore.getState());
    const c = controller();
    c.onPointerDown(line.point[0] + line.cut.period[0] * 2, line.point[1], 0);
    c.onPointerMove(10, 10);
    c.onPointerUp();
    expect(pan.calls).toEqual(["start", "move", "end"]);
    expect(lineOffset()).toBe(0.5);
  });

  it("grabs a line only where it is drawn: along it, past the last cell the press pans", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const [{ line }] = activeCutLines(useMazeStore.getState());
    const bottom = Math.max(...cells.map(([x, y]) => getCellCenter(x, y, field).y)) + 1000;
    const c = controller();
    c.onPointerDown(line.point[0], bottom, 0);
    c.onPointerUp();
    expect(pan.calls).toEqual(["start", "end"]);
    // On the line, over the cells: grabbed.
    const over = controller();
    over.onPointerDown(line.point[0], getCellCenter(0, 1, field).y, 0);
    expect(pan.calls).toEqual([]);
    over.onPointerUp();
  });

  it("drawn spans follow the cells: a line unchanged but for the cells under it is re-measured", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const extent = () => {
      const st = useMazeStore.getState();
      const [handle] = activeCutLines(st);
      const [[span]] = drawnSideSpans(st, handle);
      return Math.abs(span[1][1] - span[0][1]);
    };
    const full = extent();
    const kept = cells.filter(([, y]) => y < ROWS - 2);
    useMazeStore.setState({ nodes: kept.map(([x, y], id) => ({ id, x, y, i: 0 })) } as never);
    expect(extent()).toBeLessThan(full);
  });

  it("pans on a non-primary button even right on the line", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const [{ line }] = activeCutLines(useMazeStore.getState());
    const c = controller();
    c.onPointerDown(line.point[0], line.point[1], 1);
    c.cancelPointerGesture();
    expect(pan.calls).toEqual(["start", "end"]);
  });

  it("stops dragging when the line is no longer manual", () => {
    setState(cylinder(), { [TEST_FLOOR_ID]: { 0: { mode: "manual", offset: 0.5 } } });
    const [{ line }] = activeCutLines(useMazeStore.getState());
    const c = controller();
    c.onPointerDown(line.point[0], line.point[1], 0);
    useMazeStore.getState().setCutLine(TEST_FLOOR_ID, 0, null);
    c.onPointerMove(line.point[0] + 5, line.point[1]);
    expect(lineOffset()).toBeUndefined();
  });
});
