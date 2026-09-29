import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldEditController } from "../pixi/FieldEditController";
import { makeProjection } from "../pixi/tessellationProjection";
import { useMazeStore } from "../store/mazeStore";
import { baseFloorFieldConfig, baseStoreState, TEST_FLOOR_ID } from "./storeTestHelpers";
import type { PrimitiveWorldGeometry } from "../pixi/primitiveGeometry";

const activeControllers: FieldEditController[] = [];

function makeController() {
  const updates: PrimitiveWorldGeometry[] = [];
  const commits: { cells: [number, number][]; button: number }[] = [];
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
      onPreviewUpdate: (_cells, _button, _kind, _cfg, geometry) => updates.push(geometry),
      onPreviewClear: previewClear,
      onPrimitiveCommit: (cells, button) => commits.push({ cells, button }),
    },
  );
  activeControllers.push(controller);
  return { controller, updates, commits, previewClear };
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
