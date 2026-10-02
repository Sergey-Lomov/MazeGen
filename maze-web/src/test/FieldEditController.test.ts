import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldEditController } from "../pixi/FieldEditController";
import { encodePoint, makeProjection } from "../pixi/tessellationProjection";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import type { PrimitiveWorldGeometry } from "../pixi/primitiveGeometry";

const activeControllers: FieldEditController[] = [];

function makeController() {
  const updates: PrimitiveWorldGeometry[] = [];
  const previewCells: [number, number][][] = [];
  const symmetryUpdates: { axis: { x: number; y: number }[]; polygon: { x: number; y: number }[] }[] = [];
  const commits: { cells: [number, number][]; button: number }[] = [];
  const moves: { cells: [number, number][]; dx: number; dy: number }[] = [];
  const movePreviews: [number, number][][] = [];
  const moveTemporaryPreviews: [number, number][][] = [];
  const moveComplete = vi.fn();
  const previewClear = vi.fn();
  const canvas = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLCanvasElement;
  const viewport = { x: 0, y: 0, scale: { x: 1, y: 1 } } as never;
  const controller = new FieldEditController(
    canvas,
    () => makeProjection({ type: "square", width: 10, height: 10 }),
    () => viewport,
    { startPan: vi.fn(), movePan: vi.fn(), endPan: vi.fn() },
    {
      onPreviewUpdate: (cells, _button, _kind, _cfg, geometry) => {
        previewCells.push(cells);
        updates.push(geometry);
      },
      onPreviewClear: previewClear,
      onPrimitiveCommit: (cells, button) => commits.push({ cells, button }),
      onMoveCommit: (cells, dx, dy) => {
        moves.push({ cells, dx, dy });
        return true;
      },
      onMovePreview: (cells, temporaryCells) => {
        movePreviews.push(cells);
        moveTemporaryPreviews.push(temporaryCells);
      },
      onMoveComplete: moveComplete,
      onSymmetryPreviewUpdate: (axis, polygon) => symmetryUpdates.push({ axis, polygon }),
    },
  );
  activeControllers.push(controller);
  return { controller, updates, previewCells, movePreviews, moveTemporaryPreviews, symmetryUpdates, commits, moves, moveComplete, previewClear };
}

function click(controller: FieldEditController, x: number, y: number): void {
  controller.onPointerDown(x, y, 0);
  controller.onPointerUp();
}

function lastPolygon(updates: PrimitiveWorldGeometry[]): Extract<PrimitiveWorldGeometry, { kind: "polygon" }> {
  const geometry = updates.at(-1);
  if (!geometry || geometry.kind !== "polygon") throw new Error("Expected polygon preview geometry");
  return geometry;
}

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    openCard: "field_setup",
    floorFields: {
      [TEST_FLOOR_ID]: baseFloorFieldConfig({
        fieldEditMode: "custom",
        fieldPrimitive: "polygon",
        tessellationConfig: { type: "square", width: 10, height: 10 },
      }),
    },
  });
});

afterEach(() => {
  for (const controller of activeControllers) controller.destroy();
  activeControllers.length = 0;
});

describe("FieldEditController polygon interaction", () => {
  it("updates the preview on pointer movement and marks the closing segment dashed", () => {
    const { controller, updates } = makeController();
    click(controller, 40, -40);
    click(controller, 120, -40);
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
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);

    controller.onPointerDown(140, -60, 0);
    controller.onPointerMove(165, -165);
    controller.onPointerUp();

    expect(lastPolygon(updates).points[1]).toEqual({ x: 180, y: 180 });
    expect(lastPolygon(updates).dashedClosing).toBe(true);
  });

  it("allows a dragged vertex to move freely while Shift is held", () => {
    const { controller, updates } = makeController();
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    controller.onPointerDown(140, -60, 0);
    controller.onPointerMove(165, -165);
    controller.onPointerUp();

    expect(lastPolygon(updates).points[1]).toEqual({ x: 165, y: 165 });
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
  });

  it("commits when a new vertex is double-clicked", () => {
    const { controller, commits } = makeController();
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);
    click(controller, 200, -120);
    controller.onDoubleClick(200, -120);

    expect(commits).toHaveLength(1);
  });

  it("commits when the last installed vertex is double-clicked", () => {
    const { controller, commits } = makeController();
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);
    controller.onDoubleClick(140, -140);

    expect(commits).toHaveLength(1);
  });

  it("commits a polygon with the remove operation", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "polygon",
          polygonOperation: "remove",
          tessellationConfig: { type: "square", width: 10, height: 10 },
        }),
      },
    });
    const { controller, commits } = makeController();
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));

    expect(commits).toHaveLength(1);
    expect(commits[0].button).toBe(2);
  });

  it("does not commit a stale polygon after the tool changes", () => {
    const { controller, commits } = makeController();
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);
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
    click(controller, 40, -40);
    click(controller, 120, -40);
    click(controller, 120, -120);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));

    expect(commits).toHaveLength(0);
    expect(previewClear).toHaveBeenCalled();
  });
});

describe("FieldEditController move interaction", () => {
  it("selects existing cells with a polygon and moves them as one drag", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "move",
          tessellationConfig: { type: "square", width: 10, height: 10 },
          fieldPoints: new Set([
            encodePoint(0, 0), encodePoint(1, 0), encodePoint(0, 1), encodePoint(1, 1), encodePoint(2, 0),
          ]),
        }),
      },
    });
    const { controller, moves, moveComplete, movePreviews, moveTemporaryPreviews, updates, previewCells } = makeController();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    click(controller, 0, -10);
    click(controller, 80, -10);
    click(controller, 80, -90);
    click(controller, 0, -90);
    expect(previewCells.at(-1)).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
    expect(lastPolygon(updates)).toMatchObject({ cellColor: 0xffffff });
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(updates.at(-1)).toMatchObject({ kind: "boundary" });
    expect(previewCells.at(-1)).toEqual([]);

    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 1);
    expect(moves).toHaveLength(0);
    controller.onPointerMove(100, -20, 1);
    controller.onPointerUp();
    expect(moves).toHaveLength(0);
    expect(movePreviews.at(-1)).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
    expect(moveTemporaryPreviews.at(-1)).toEqual([[2, 0], [3, 0], [2, 1], [3, 1]]);
    expect(previewCells.at(-1)).toEqual([]);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    expect(moves).toEqual([
      {
        cells: [[0, 0], [1, 0], [0, 1], [1, 1]],
        dx: 2,
        dy: 0,
      },
    ]);

    expect(moves).toHaveLength(1);
    expect(moveComplete).toHaveBeenCalledOnce();
    expect(movePreviews.at(-1)).toEqual([]);
  });

  it("keeps the field unchanged when Escape cancels a pending move", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "move",
          tessellationConfig: { type: "square", width: 10, height: 10 },
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0)]),
        }),
      },
    });
    const { controller, moves, previewClear } = makeController();
    click(controller, 0, -10);
    click(controller, 80, -10);
    click(controller, 80, -90);
    click(controller, 0, -90);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(60, -20, 1);
    controller.onPointerUp();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));

    expect(moves).toHaveLength(0);
    expect(previewClear).toHaveBeenCalled();
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints).toEqual(
      new Set([encodePoint(0, 0), encodePoint(1, 0)]),
    );
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPrimitive).toBe("point");
  });

  it("deletes an already selected piece with Delete", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "move",
          tessellationConfig: { type: "square", width: 10, height: 10 },
          fieldPoints: new Set([encodePoint(0, 0), encodePoint(1, 0), encodePoint(3, 0)]),
        }),
      },
    });
    const { controller, commits, moveComplete } = makeController();
    click(controller, 0, -10);
    click(controller, 80, -10);
    click(controller, 80, -90);
    click(controller, 0, -90);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Delete" }));

    expect(commits).toEqual([{ cells: [[0, 0], [1, 0]], button: 2 }]);
    expect(moveComplete).toHaveBeenCalledOnce();
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
  it("paints every new cell reached during a left-button drag", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          fieldPrimitive: "point",
          tessellationConfig: { type: "square", width: 10, height: 10 },
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
