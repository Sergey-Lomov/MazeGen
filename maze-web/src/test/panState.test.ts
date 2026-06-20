import { describe, it, expect } from "vitest";
import { PanState } from "../pixi/sceneTypes";

function makePan() {
  const origin = { x: 0, y: 0 };
  const pan = new PanState(
    () => ({ ...origin }),
    (x, y) => { origin.x = x; origin.y = y; },
  );
  return { pan, origin };
}

describe("PanState", () => {
  it("not_dragging_initially", () => {
    const { pan } = makePan();
    expect(pan.isDragging).toBe(false);
  });

  it("begin_sets_dragging_true", () => {
    const { pan } = makePan();
    pan.begin(10, 10);
    expect(pan.isDragging).toBe(true);
  });

  it("move_translates_origin_by_delta_from_begin", () => {
    const { pan, origin } = makePan();
    origin.x = 100;
    origin.y = 50;
    pan.begin(10, 10);
    pan.move(15, 30);
    expect(origin.x).toBe(105);
    expect(origin.y).toBe(70);
  });

  it("move_without_begin_does_nothing", () => {
    const { pan, origin } = makePan();
    pan.move(15, 30);
    expect(origin.x).toBe(0);
    expect(origin.y).toBe(0);
  });

  it("end_stops_dragging_and_further_move_is_noop", () => {
    const { pan, origin } = makePan();
    pan.begin(10, 10);
    pan.end();
    expect(pan.isDragging).toBe(false);
    pan.move(50, 50);
    expect(origin.x).toBe(0);
    expect(origin.y).toBe(0);
  });

  it("begin_again_resets_drag_origin_snapshot", () => {
    const { pan, origin } = makePan();
    pan.begin(10, 10);
    pan.move(20, 20);
    expect(origin.x).toBe(10);
    pan.begin(20, 20);
    pan.move(25, 25);
    expect(origin.x).toBe(15);
  });
});
