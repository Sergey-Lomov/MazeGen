import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldEditController } from "../pixi/FieldEditController";
import { encodePoint, makeProjection } from "../pixi/tessellationProjection";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import type { FieldSizeReadout } from "../pixi/fieldSizeReadout";
import type { PrimitiveWorldGeometry } from "../pixi/primitiveGeometry";
import { fieldOf } from "./fieldConfigFixtures";
import { resetNotifications, useNotificationStore } from "../notifications/notificationStore";
import { AUTO_FILL_PREVIEW_ACTIVE } from "../notifications/fieldSetupNotifications";

const activeControllers: FieldEditController[] = [];

function makeController() {
  const updates: PrimitiveWorldGeometry[] = [];
  const previewCells: [number, number][][] = [];
  const symmetryUpdates: { axis: { x: number; y: number }[]; polygon: { x: number; y: number }[] }[] = [];
  const commits: { cells: [number, number][]; button: number }[] = [];
  const selectionMovePreviews: { source: [number, number][]; temporary: [number, number][] }[] = [];
  const selectionMoves: { cells: [number, number][]; vector: [number, number] }[] = [];
  const previewClear = vi.fn();
  const readouts: FieldSizeReadout[] = [];
  const canvas = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const viewport = { x: 0, y: 0, scale: { x: 1, y: 1 } } as never;
  const controller = new FieldEditController(
    canvas,
    () => makeProjection(fieldOf("square", { shape: "rect", cols: 10, rows: 10 })),
    () => viewport,
    { startPan: vi.fn(), movePan: vi.fn(), endPan: vi.fn() },
    {
      onPreviewUpdate: (cells, _button, _kind, _cfg, geometry) => {
        previewCells.push(cells);
        updates.push(geometry);
      },
      onPreviewClear: previewClear,
      onPrimitiveCommit: (cells, button) => commits.push({ cells, button }),
      onSelectionMovePreview: (source, temporary) => selectionMovePreviews.push({ source, temporary }),
      onSelectionMove: (cells, vector) => {
        selectionMoves.push({ cells, vector });
        return true;
      },
      onSymmetryPreviewUpdate: (axis, polygon) => symmetryUpdates.push({ axis, polygon }),
      onSizeReadout: (readout) => readouts.push(readout),
    },
  );
  activeControllers.push(controller);
  return { controller, updates, previewCells, symmetryUpdates, commits, selectionMoves, selectionMovePreviews, previewClear, readouts };
}

function click(controller: FieldEditController, x: number, y: number, button = 0): void {
  controller.onPointerDown(x, y, button);
  controller.onPointerUp();
}

function lastPolygon(updates: PrimitiveWorldGeometry[]): Extract<PrimitiveWorldGeometry, { kind: "polygon" }> {
  const geometry = updates.at(-1);
  if (!geometry || geometry.kind !== "polygon") throw new Error("Expected polygon preview geometry");
  return geometry;
}

beforeEach(() => {
  resetNotifications();
  useMazeStore.setState({
    ...baseStoreState(),
    backgroundAutoFillPreview: null,
    openCard: "field_setup",
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        fieldEditMode: "custom",
        fieldPrimitive: "polygon",
        fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
      }),
    },
  });
});

afterEach(() => {
  for (const controller of activeControllers) controller.destroy();
  activeControllers.length = 0;
});

describe("FieldEditController primitive shortcuts", () => {
  it("selects field figures in list order and assigns mnemonic keys to special tools", () => {
    makeController();

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("point");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit7" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("parallelogram");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit8" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("polygon");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("magic_wand");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("symmetry");
  });

  it("does not select the disabled symmetry tool in select mode", () => {
    makeController();
    useMazeStore.getState().setFieldOperation("select");
    useMazeStore.getState().setFieldPrimitive("point");

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("point");
  });

  it("does not select a tool while field editing is locked", () => {
    makeController();
    useMazeStore.getState().setFieldPrimitive("point");
    useMazeStore.setState({ backgroundAutoFillPreview: new Set() });

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit7" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("point");
  });

  it("clears the feature-card focus after a keyboard tool selection", () => {
    makeController();
    const header = document.createElement("button");
    document.body.append(header);
    header.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1" }));

    expect(document.activeElement).not.toBe(header);
    header.remove();
  });
});

describe("FieldEditController polygon interaction", () => {
  it("updates the preview on pointer movement and marks the closing segment dashed", () => {
    const { controller, updates } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    controller.onPointerMove(120, -120);

    const geometry = lastPolygon(updates);
    expect(geometry).toMatchObject({
      kind: "polygon",
      vertexCount: 2,
      dashedClosing: true,
    });
    expect(geometry.dashedAll).toBeUndefined();
    expect(geometry.frameColor).toBeUndefined();
    expect(geometry?.points).toHaveLength(3);
  });

  it("snaps a new vertex to the cell center by default", () => {
    const { controller, updates } = makeController();
    click(controller, 45, -45);

    expect(lastPolygon(updates).points[0]).toEqual({ x: 60, y: 60 });
  });

  it("allows free vertex placement while Shift is held", () => {
    const { controller, updates } = makeController();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    click(controller, 45, -45);

    expect(lastPolygon(updates).points[0]).toEqual({ x: 45, y: 45 });
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
  });

  it("snaps a dragged vertex to the cell center by default", () => {
    const { controller, updates } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);

    controller.onPointerDown(140, -60, 0);
    controller.onPointerMove(165, -165);
    controller.onPointerUp();

    expect(lastPolygon(updates).points[1]).toEqual({ x: 180, y: 180 });
    expect(lastPolygon(updates).dashedClosing).toBe(true);
  });

  it("allows a dragged vertex to move freely while Shift is held", () => {
    const { controller, updates } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    controller.onPointerDown(140, -60, 0);
    controller.onPointerMove(165, -165);
    controller.onPointerUp();

    expect(lastPolygon(updates).points[1]).toEqual({ x: 165, y: 165 });
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
  });

  it("commits when a new vertex is double-clicked", () => {
    const { controller, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);
    click(controller, 205, -125);
    controller.onDoubleClick(205, -125);

    expect(commits).toHaveLength(1);
  });

  it("commits when the last installed vertex is double-clicked", () => {
    const { controller, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);
    controller.onDoubleClick(140, -140);

    expect(commits).toHaveLength(1);
  });

  it("drops isolated and single-connection cells from a committed polygon when smoothing is on", () => {
    useMazeStore.setState({ smoothPrimitives: true });
    const { controller, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 445, -45);
    click(controller, 445, -285);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(commits).toHaveLength(1);
    const cells = commits[0].cells;
    const set = new Set(cells.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of cells) {
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => set.has(`${x + dx},${y + dy}`)).length;
      expect(n).toBeGreaterThan(1);
    }
  });

  it("commits a polygon with the remove operation", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "polygon",
          fieldOperation: "remove",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
        }),
      },
    });
    const { controller, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(commits).toHaveLength(1);
    expect(commits[0].button).toBe(2);
  });

  it("does not commit a stale polygon after the tool changes", () => {
    const { controller, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: { ...useMazeStore.getState().floorFields[TEST_FLOOR_ID], fieldPrimitive: "point" },
      },
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(commits).toHaveLength(0);
  });

  it("cancels an in-progress polygon with Escape", () => {
    const { controller, commits, previewClear } = makeController();
    click(controller, 45, -45);
    click(controller, 125, -45);
    click(controller, 125, -125);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));

    expect(commits).toHaveLength(0);
    expect(previewClear).toHaveBeenCalled();
  });
});

describe("FieldEditController parallelogram interaction", () => {
  beforeEach(() => {
    useMazeStore.getState().setFieldPrimitive("parallelogram");
  });

  it("commits after three clicks and draws every side of the closed outline", () => {
    const { controller, updates, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 205, -45);
    controller.onPointerMove(60, -125);
    expect(lastPolygon(updates)).toMatchObject({ closed: true, vertexCount: 2 });
    expect(lastPolygon(updates).points).toHaveLength(4);

    click(controller, 45, -125);

    expect(commits).toHaveLength(1);
    expect(commits[0].cells.length).toBeGreaterThan(0);
    expect(commits[0].button).toBe(0);
  });

  it("previews the base as a two-point line with both ends marked while dragging", () => {
    const { controller, updates, commits } = makeController();
    controller.onPointerDown(45, -45, 0);
    controller.onPointerMove(205, -45);

    expect(lastPolygon(updates)).toMatchObject({ vertexCount: 2, closed: false });
    expect(lastPolygon(updates).points).toHaveLength(2);

    controller.onPointerUp();
    click(controller, 45, -125);
    expect(commits).toHaveLength(1);
  });

  it("treats a short press as a single point, not a drag", () => {
    const { controller, commits } = makeController();
    controller.onPointerDown(45, -45, 0);
    controller.onPointerMove(46, -45);
    controller.onPointerUp();
    click(controller, 205, -45);
    expect(commits).toHaveLength(0);
    click(controller, 45, -125);
    expect(commits).toHaveLength(1);
  });

  it("keeps the operation of the first click when the last click uses the other button", () => {
    const { controller, commits } = makeController();
    click(controller, 45, -45, 0);
    click(controller, 205, -45, 0);
    click(controller, 45, -125, 2);

    expect(commits).toHaveLength(1);
    expect(commits[0].button).toBe(0);
  });

  it("snaps the second side to a grid axis and lets Shift keep it free", () => {
    const { controller, updates } = makeController();
    click(controller, 45, -45);
    click(controller, 205, -45);
    controller.onPointerMove(63, -125);
    expect(lastPolygon(updates).points[3].x).toBeCloseTo(lastPolygon(updates).points[0].x, 6);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    controller.onPointerMove(63, -125);
    expect(lastPolygon(updates).points[3].x).toBeCloseTo(63, 6);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
  });

  it("commits the previewed outline with Enter", () => {
    const { controller, commits } = makeController();
    click(controller, 45, -45);
    click(controller, 205, -45);
    controller.onPointerMove(45, -125);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(commits).toHaveLength(1);
  });

  it("cancels pending points with Escape", () => {
    const { controller, commits, previewClear } = makeController();
    click(controller, 45, -45);
    click(controller, 205, -45);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    click(controller, 45, -125);

    expect(commits).toHaveLength(0);
    expect(previewClear).toHaveBeenCalled();
  });
});

describe("FieldEditController select interaction", () => {
  it("keeps the existing cells selected and draws their boundary contour on polygon release", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "polygon",
          fieldOperation: "select",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
          fieldPoints: new Set([
            encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1), encodePoint(1, 1), encodePoint(2, 0),
          ]),
        }),
      },
    });
    const { controller, updates, previewCells, commits, selectionMoves } = makeController();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    click(controller, 5, -10);
    click(controller, 85, -10);
    click(controller, 85, -90);
    click(controller, 5, -90);
    expect(previewCells.at(-1)).toEqual(expect.arrayContaining([[0, 0], [1, 0], [0, 1], [1, 1]]));
    expect(previewCells.at(-1)).toHaveLength(4);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(updates.at(-1)).toMatchObject({ kind: "boundary" });
    const released = updates.at(-1);
    if (released?.kind !== "boundary") throw new Error("expected boundary geometry");
    expect(released.components).toHaveLength(released.segments.length);
    expect(previewCells.at(-1)).toEqual([]);
    expect(commits).toHaveLength(0);

    controller.onPointerDown(5, -10, 0);
    controller.onPointerMove(85, -10, 0);
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(selectionMoves).toHaveLength(1);
    expect(selectionMoves[0]).toMatchObject({ vector: [2, 0] });
    expect(selectionMoves[0].cells).toEqual(expect.arrayContaining([[0, 0], [1, 0], [0, 1], [1, 1]]));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("polygon");
  });

  it("selects only existing cells with the point tool and does not mutate the field", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        }),
      },
    });
    const { controller, updates, previewCells, commits } = makeController();
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(100, -20, 0);
    controller.onPointerUp();

    expect(previewCells.at(-1)).toEqual([]);
    expect(updates.at(-1)).toMatchObject({ kind: "boundary" });
    expect(commits).toHaveLength(0);
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(
      new Set([encodePoint(0, 0), encodePoint(1, 0)]),
    );
  });

  it("shows point selections in white until pointerup, then enters drag mode", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        }),
      },
    });
    const { controller, updates, previewCells, selectionMoves, selectionMovePreviews } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 0);
    expect(previewCells.at(-1)).toEqual(expect.arrayContaining([[0, 0], [1, 0]]));
    expect(updates.at(-1)).toMatchObject({ kind: "boundary", cellColor: 0xffffff });

    controller.onPointerMove(100, -20, 0);
    expect(previewCells.at(-1)).toEqual(expect.arrayContaining([[0, 0], [1, 0], [2, 0]]));

    controller.onPointerUp();
    expect(previewCells.at(-1)).toEqual([]);
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(100, -20, 0);
    expect(previewCells.at(-1)).toEqual([]);
    expect(selectionMovePreviews.at(-1)).toEqual({
      source: [[0, 0], [1, 0]],
      temporary: [[2, 0], [3, 0]],
    });
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(selectionMoves).toEqual([{ cells: [[0, 0], [1, 0]], vector: [2, 0] }]);
    expect(controller.hasSelectionPreview()).toBe(false);
    expect(controller.isGestureActive()).toBe(false);
  });

  it("switches field operations with +, -, and 0", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom" }),
      },
    });
    const { controller } = makeController();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "=", code: "Equal" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldOperation).toBe("add");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", code: "Minus" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldOperation).toBe("remove");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", code: "Digit0" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldOperation).toBe("select");

    controller.destroy();
  });

  it("adds a second point selection zone while Shift is held", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldPoints: new Set([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([x, y]) => encodePoint(x, y))),
        }),
      },
    });
    const { controller, selectionMoves } = makeController();

    click(controller, 20, -20);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    controller.onPointerDown(60, -20, 0);
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(20, -60, 0);
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(selectionMoves).toEqual([{ cells: [[0, 0], [1, 0]], vector: [0, 1] }]);
  });

  it("does nothing for RMB in select mode", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldPoints: new Set([encodePoint(0, 0)]),
        }),
      },
    });
    const { controller } = makeController();

    controller.onPointerDown(20, -20, 2);
    controller.onPointerUp();

    expect(controller.hasSelectionPreview()).toBe(false);
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(new Set([encodePoint(0, 0)]));
  });

  it("confirms a pending selection move with Space", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        }),
      },
    });
    const { controller, selectionMoves } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 0);
    controller.onPointerUp();
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(100, -20, 0);
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));

    expect(selectionMoves).toEqual([{ cells: [[0, 0], [1, 0]], vector: [2, 0] }]);
    expect(controller.hasSelectionPreview()).toBe(false);
  });

  it("confirms a pending selection move when clicking outside it", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        }),
      },
    });
    const { controller, selectionMoves } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 0);
    controller.onPointerUp();
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(100, -20, 0);
    controller.onPointerUp();
    controller.onPointerDown(200, -200, 0);

    expect(selectionMoves).toEqual([{ cells: [[0, 0], [1, 0]], vector: [2, 0] }]);
    expect(controller.hasSelectionPreview()).toBe(false);
  });

  it("deletes the selected cells with Delete", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
          fieldPoints: new Set([encodePoint(0, 0)]),
        }),
      },
    });
    const { controller, commits } = makeController();
    click(controller, 20, -20);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Delete" }));

    expect(commits).toEqual([{ cells: [[0, 0]], button: 2 }]);
  });
});

describe("FieldEditController symmetry interaction", () => {
  it("allows dragging either defining axis point", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 20, y: 20 }, { x: 20, y: 100 }],
      symmetryScope: "everything",
      floorFields: {
        [TEST_FLOOR_ID]: { ...useMazeStore.getState().floorFields[TEST_FLOOR_ID], fieldPrimitive: "symmetry" },
      },
    });
    const { controller, symmetryUpdates } = makeController();
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 1);
    controller.onPointerUp();

    expect(useMazeStore.getState().symmetryAxisPoints).toEqual([{ x: 60, y: 20 }, { x: 20, y: 100 }]);
    expect(symmetryUpdates.at(-1)?.axis).toEqual([{ x: 60, y: 20 }, { x: 20, y: 100 }]);
  });

  it("finishes a processing polygon with Enter", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 20, y: 0 }, { x: 20, y: 100 }],
      symmetryScope: "polygon",
      symmetryPolygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 40, y: 80 }],
      symmetryPolygonFinished: false,
      floorFields: {
        [TEST_FLOOR_ID]: { ...useMazeStore.getState().floorFields[TEST_FLOOR_ID], fieldPrimitive: "symmetry" },
      },
    });
    const { controller } = makeController();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(useMazeStore.getState().symmetryPolygonFinished).toBe(true);
    controller.destroy();
  });

  it("applies a ready symmetry with Enter", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 20, y: 0 }, { x: 20, y: 100 }],
      symmetryScope: "everything",
      floorFields: {
        [TEST_FLOOR_ID]: {
          ...useMazeStore.getState().floorFields[TEST_FLOOR_ID],
          fieldPrimitive: "symmetry",
          fieldPoints: new Set([encodePoint(0, 0)]),
        },
      },
    });
    const { controller } = makeController();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("point");
    expect(useMazeStore.getState().symmetryAxisPoints).toEqual([]);
    controller.destroy();
  });

  it("allows dragging a finished processing polygon vertex", () => {
    useMazeStore.setState({
      symmetryAxisPoints: [{ x: 20, y: 0 }, { x: 20, y: 100 }],
      symmetryScope: "polygon",
      symmetrySnapMode: "free",
      symmetryPolygon: [{ x: 40, y: 40 }, { x: 80, y: 40 }, { x: 40, y: 80 }],
      symmetryPolygonFinished: true,
      floorFields: {
        [TEST_FLOOR_ID]: { ...useMazeStore.getState().floorFields[TEST_FLOOR_ID], fieldPrimitive: "symmetry" },
      },
    });
    const { controller } = makeController();
    controller.onPointerDown(40, -40, 0);
    controller.onPointerMove(80, -80, 1);
    controller.onPointerUp();

    expect(useMazeStore.getState().symmetryPolygon[0]).toEqual({ x: 80, y: 80 });
  });
});

describe("FieldEditController point interaction", () => {
  it("ignores editing gestures and shortcuts while an auto-fill preview is active", () => {
    const originalPoints = new Set([encodePoint(0, 0)]);
    useMazeStore.setState({
      backgroundAutoFillPreview: new Set([encodePoint(3, 3)]),
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "add",
          fieldPoints: originalPoints,
        }),
      },
    });
    const { controller, commits } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 1);
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code: "Equal" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(originalPoints);
    expect(commits).toHaveLength(0);
    expect(controller.getHoverCell(20, -20)).toBeNull();
  });

  it("explains ignored canvas clicks during an auto-fill preview with a notice", () => {
    useMazeStore.setState({ backgroundAutoFillPreview: new Set([encodePoint(3, 3)]) });
    const { controller } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerUp();
    controller.onPointerDown(20, -20, 0);
    controller.onPointerUp();

    const notices = useNotificationStore.getState().notices;
    expect(notices.map((n) => n.code)).toEqual([AUTO_FILL_PREVIEW_ACTIVE]);
  });

  it("does not show the auto-fill notice for pan gestures during a preview", () => {
    useMazeStore.setState({ backgroundAutoFillPreview: new Set([encodePoint(3, 3)]) });
    const { controller } = makeController();

    controller.onPointerDown(20, -20, 1);
    controller.onPointerUp();

    expect(useNotificationStore.getState().notices).toHaveLength(0);
  });

  it("does not show the auto-fill notice for clicks without a preview", () => {
    const { controller } = makeController();
    click(controller, 20, -20);

    expect(useNotificationStore.getState().notices).toHaveLength(0);
  });

  it("inverts add/remove with RMB", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "add",
          fieldPoints: new Set([encodePoint(0, 0)]),
        }),
      },
    });
    const { controller } = makeController();

    controller.onPointerDown(20, -20, 2);
    controller.onPointerUp();
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(new Set());

    useMazeStore.getState().setFieldOperation("remove");
    controller.onPointerDown(20, -20, 2);
    controller.onPointerUp();
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(new Set([encodePoint(0, 0)]));
  });

  it("paints every new cell reached during a left-button drag", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
        }),
      },
    });
    const { controller } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 1);
    controller.onPointerMove(100, -20, 1);
    controller.onPointerUp();

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(
      new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(2, 0)]),
    );
  });
});

describe("FieldEditController magic wand interaction", () => {
  it("adds a bounded empty component", () => {
    const occupied = new Set<number>();
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        if (x !== 1 || y !== 1) occupied.add(encodePoint(x, y));
      }
    }
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "magic_wand",
          fieldOperation: "add",
          fieldPoints: occupied,
        }),
      },
    });
    const { controller, commits } = makeController();

    click(controller, 60, -60);

    expect(commits).toEqual([{ cells: [[1, 1]], button: 0 }]);
  });

  it("removes the connected occupied component", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "magic_wand",
          fieldOperation: "remove",
          fieldPoints: new Set([
            encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1), encodePoint(4, 4),
          ]),
        }),
      },
    });
    const { controller, commits } = makeController();

    click(controller, 20, -20);

    expect(commits).toEqual([{
      cells: expect.arrayContaining([[0, 0], [1, 0], [0, 1]]),
      button: 2,
    }]);
    expect(commits[0].cells).toHaveLength(3);
  });

  it("inverts Add to Remove with RMB", () => {
    const occupied = new Set<number>();
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        if (x !== 1 || y !== 1) occupied.add(encodePoint(x, y));
      }
    }
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "magic_wand",
          fieldOperation: "add",
          fieldPoints: occupied,
        }),
      },
    });
    const { controller, commits } = makeController();

    click(controller, 20, -20, 2);

    expect(commits).toEqual([{ cells: expect.arrayContaining([[0, 0]]), button: 2 }]);
  });

  it("selects the connected occupied component without mutating the field", () => {
    const fieldPoints = new Set([
      encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1), encodePoint(4, 4),
    ]);
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "magic_wand",
          fieldOperation: "select",
          fieldPoints,
        }),
      },
    });
    const { controller, previewCells, commits } = makeController();

    click(controller, 20, -20);

    expect(commits).toHaveLength(0);
    expect(previewCells.at(-1)).toEqual([]);
    expect(controller.hasSelectionPreview()).toBe(true);
    controller.destroy();
  });

  it("does nothing when Add targets the unbounded empty area", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "magic_wand",
          fieldOperation: "add",
          fieldPoints: new Set([encodePoint(0, 0)]),
        }),
      },
    });
    const { controller, commits } = makeController();

    click(controller, 100, -20);

    expect(commits).toHaveLength(0);
  });

  it("previews the full area before clicking", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "magic_wand",
          fieldOperation: "remove",
          fieldPoints: new Set([
            encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1), encodePoint(4, 4),
          ]),
        }),
      },
    });
    const { controller } = makeController();

    expect(controller.getMagicWandPreview(20, -20)).toEqual(
      expect.arrayContaining([[0, 0], [1, 0], [0, 1]]),
    );
  });
});

describe("FieldEditController size readout", () => {
  it("reports the selection size, then clears it when the selection is cancelled", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          fieldOperation: "select",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        }),
      },
    });
    const { controller, readouts } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 0);
    expect(readouts.at(-1)).toEqual({ selection: { width: 2, height: 1, count: 2 }, shape: null });

    controller.onPointerUp();
    expect(readouts.at(-1)?.selection).toEqual({ width: 2, height: 1, count: 2 });

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(readouts.at(-1)).toEqual({ selection: null, shape: null });
  });

  it("reports the stretched shape size and clears it on commit", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "rectangle",
          fieldOperation: "add",
          fieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
        }),
      },
    });
    const { controller, readouts } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(100, -60, 0);
    const shape = readouts.at(-1)?.shape;
    expect(shape).not.toBeNull();
    expect(shape!.primitive).toBe("rectangle");
    expect(shape!.width * shape!.height).toBeGreaterThanOrEqual(shape!.count);
    expect(shape!.count).toBeGreaterThan(1);

    controller.onPointerUp();
    expect(readouts.at(-1)).toEqual({ selection: null, shape: null });
  });

  it("reports the polygon size while it is being built", () => {
    const { controller, readouts } = makeController();

    controller.onPointerDown(20, -20, 0);
    controller.onPointerUp();
    controller.onPointerDown(180, -20, 0);
    controller.onPointerUp();
    controller.onPointerDown(180, -140, 0);
    controller.onPointerUp();

    const shape = readouts.at(-1)?.shape;
    expect(shape?.primitive).toBe("polygon");
    expect(shape!.count).toBeGreaterThan(0);
  });
});
