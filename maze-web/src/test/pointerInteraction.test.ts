import { describe, expect, it, vi } from "vitest";
import {
  cancelPendingPointerAction,
  isPointerModalOpen,
  pickNearestPointerHit,
  PointerDragTracker,
  pointerCellAt,
  pointerCellAtConfig,
  resetPointerHover,
  toViewportCoordinates,
} from "../pixi/pointerInteraction";

describe("pointer interaction primitives", () => {
  it("converts canvas coordinates through viewport position and scale", () => {
    expect(toViewportCoordinates(140, 80, { x: 20, y: 20, scale: { x: 2, y: 4 } })).toEqual({ x: 60, y: 15 });
  });

  it("looks up a cell through the tessellation projection", () => {
    expect(pointerCellAtConfig({ type: "square", width: 4, height: 4 }, 70, -90)).toEqual([1, 2]);
    expect(pointerCellAt({ screenToGrid: () => ({ x: -2, y: 3 }) } as never, 0, 0)).toEqual([-2, 3]);
  });

  it("returns the nearest candidate that passes the hit predicate", () => {
    const candidates = [{ id: "missing", x: 0 }, { id: "far", x: 3 }, { id: "near", x: 1 }];
    const position = (candidate: (typeof candidates)[number]) => candidate.id === "missing" ? null : { x: candidate.x, y: 0 };
    expect(pickNearestPointerHit(0, 0, candidates, position)).toEqual({ id: "near", x: 1 });
    expect(pickNearestPointerHit(0, 0, candidates, position, (_candidate, distanceSq) => distanceSq < 1)).toBeNull();
  });

  it("resets all supplied hover targets without knowing a renderer type", () => {
    const updateHover = vi.fn();
    const updateCellHover = vi.fn();
    const updateTeleportPreview = vi.fn();
    resetPointerHover({ updateHover, updateCellHover, updateTeleportPreview });
    expect(updateHover).toHaveBeenCalledWith(null);
    expect(updateCellHover).toHaveBeenCalledWith(null);
    expect(updateTeleportPreview).toHaveBeenCalledWith(null, 0, 0);
    resetPointerHover({ updateHover });
    expect(updateHover).toHaveBeenCalledTimes(2);
  });

  it("treats any open modal as a pointer guard and cancels pending work once", () => {
    expect(isPointerModalOpen(false, true, false)).toBe(true);
    const cancel = vi.fn();
    const clearPreview = vi.fn();
    expect(cancelPendingPointerAction("pending", cancel, clearPreview)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(clearPreview).toHaveBeenCalledOnce();
    expect(cancelPendingPointerAction(null, cancel, clearPreview)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelPendingPointerAction("pending", cancel)).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("dispatches each drag target once and keeps the gesture kind fixed", () => {
    const tracker = new PointerDragTracker();
    const seen: string[] = [];
    tracker.begin("edge", "first");
    tracker.dispatch("edge", "first", "first", (value) => seen.push(value));
    tracker.dispatch("edge", "second", "second", (value) => seen.push(value));
    tracker.dispatch("edge", "second", "second", (value) => seen.push(value));
    tracker.dispatch("cell", "cell", "cell", (value) => seen.push(value));
    expect(seen).toEqual(["second"]);
    expect(tracker.active).toBe(true);
    expect(tracker.isEdge).toBe(true);
    tracker.end();
    expect(tracker.active).toBe(false);
    tracker.begin("cell", "cell");
    expect(tracker.isCell).toBe(true);
    tracker.end();
    tracker.dispatch("cell", "cell", "after-end", (value) => seen.push(value));
    expect(seen).toEqual(["second"]);
  });
});
