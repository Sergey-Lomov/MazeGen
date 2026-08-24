import { describe, it, expect } from "vitest";
import { computeElevatorBadgePositions, elevatorBadgesOverlap, elevatorBadgesTooMany, formatElevatorBadgeLabel, slotsPerRow } from "../pixi/renderers/elevatorBadgeLayout";
import { TILE_SIZE } from "../pixi/constants";

describe("slotsPerRow", () => {
  it("floor((TILE_SIZE + gap) / (2*radius + gap)), minimum 1", () => {
    expect(slotsPerRow(5, 0)).toBe(Math.floor(TILE_SIZE / 10));
    expect(slotsPerRow(TILE_SIZE, 0)).toBe(1);
    expect(slotsPerRow(TILE_SIZE * 10, 0)).toBe(1);
  });

  it("accounts for gap between badges, not just their own width", () => {
    const noGap = slotsPerRow(10, 0);
    const withGap = slotsPerRow(10, 10);
    expect(withGap).toBeLessThanOrEqual(noGap);
  });
});

describe("computeElevatorBadgePositions", () => {
  it("returns an empty array for count <= 0", () => {
    expect(computeElevatorBadgePositions(0, 0, 10, 0, 5, 4, 0, "left_right", true)).toEqual([]);
  });

  it("left_right places a single badge to the left of the marker (leading/extra half on odd counts), offset by markerRadius+distance+radius", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 1, 5, 4, 0, "left_right", true);
    expect(positions).toEqual([{ x: -19, y: 0 }]);
  });

  it("right_left places a single badge to the right of the marker — mirrors left_right", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 1, 5, 4, 0, "right_left", true);
    expect(positions).toEqual([{ x: 19, y: 0 }]);
  });

  it("left_right (evenDistribution) splits count in half between left (extra on odd) and right sides", () => {
    // capacity is large (small radius/gap relative to TILE_SIZE), so each side lays out as one
    // sub-row: 2 badges -> 1 left + 1 right; 3 badges -> 2 left + 1 right.
    const two = computeElevatorBadgePositions(0, 0, 10, 2, 2, 4, 0, "left_right", true);
    expect(two).toHaveLength(2);
    expect(two[0].x).toBe(-16);
    expect(two[1].x).toBe(16);

    const three = computeElevatorBadgePositions(0, 0, 10, 3, 2, 4, 0, "left_right", true);
    expect(three).toHaveLength(3);
    expect(three.filter((p) => p.x < 0)).toHaveLength(2);
    expect(three.filter((p) => p.x > 0)).toHaveLength(1);
  });

  it("top_bottom splits count in half between top (extra on odd) and bottom sides", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 3, 2, 4, 0, "top_bottom", true);
    expect(positions.filter((p) => p.y < 0)).toHaveLength(2);
    expect(positions.filter((p) => p.y > 0)).toHaveLength(1);
  });

  it("bottom_top splits count in half between bottom (extra on odd) and top sides", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 3, 2, 4, 0, "bottom_top", true);
    expect(positions.filter((p) => p.y > 0)).toHaveLength(2);
    expect(positions.filter((p) => p.y < 0)).toHaveLength(1);
  });

  it("evenDistribution off: leading side fills up to capacity before the other side gets any, ascending order preserved", () => {
    const radius = 2;
    const gap = 4;
    const capacity = slotsPerRow(radius, gap);
    expect(capacity).toBeGreaterThan(1);
    const count = capacity + 1;
    const positions = computeElevatorBadgePositions(0, 0, 10, count, radius, 4, gap, "left_right", false);
    expect(positions).toHaveLength(count);
    expect(positions.filter((p) => p.x < 0)).toHaveLength(capacity);
    expect(positions.filter((p) => p.x > 0)).toHaveLength(1);
  });

  it("never wraps to a second sub-row — a side's badges always draw in a single row even past slotsPerRow capacity", () => {
    const radius = 20;
    const gap = 20;
    expect(slotsPerRow(radius, gap)).toBe(1);
    // 4 badges -> 2 left + 2 right; each side's 2 badges draw as one row of 2 at the same near
    // offset, not split into near/far sub-rows.
    const positions = computeElevatorBadgePositions(0, 0, 10, 4, radius, 4, gap, "left_right", true);
    expect(positions).toHaveLength(4);
    const nearOffset = 10 + 4 + radius;
    for (const p of positions) expect(Math.abs(p.x)).toBe(nearOffset);
    expect(positions.filter((p) => p.x < 0)).toHaveLength(2);
    expect(positions.filter((p) => p.x > 0)).toHaveLength(2);
  });

  it("full_circle (evenDistribution) spreads badges evenly on a ring, starting at 12 o'clock going clockwise", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 4, 5, 4, 0, "full_circle", true);
    expect(positions).toHaveLength(4);
    const ring = 10 + 4 + 5;
    expect(positions[0].x).toBeCloseTo(0);
    expect(positions[0].y).toBeCloseTo(-ring);
    expect(positions[1].x).toBeCloseTo(ring);
    expect(positions[1].y).toBeCloseTo(0);
  });

  it("full_circle (evenDistribution off) lays badges out as a contiguous arc centered on 12 o'clock, gap apart", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 2, 5, 4, 6, "full_circle", false);
    expect(positions).toHaveLength(2);
    // Even count of 2: centered on 12 o'clock means the gap between the two middle (only) badges
    // sits at 12 o'clock — symmetric around x=0, both at the same y.
    expect(positions[0].x).toBeCloseTo(-positions[1].x);
    expect(positions[0].y).toBeCloseTo(positions[1].y);
    expect(positions[0].y).toBeLessThan(0);
  });

  it("full_circle (evenDistribution off), odd count centers the middle badge exactly at 12 o'clock", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 3, 5, 4, 6, "full_circle", false);
    expect(positions).toHaveLength(3);
    const ring = 10 + 4 + 5;
    expect(positions[1].x).toBeCloseTo(0);
    expect(positions[1].y).toBeCloseTo(-ring);
  });

  it("evenDistribution off: two-sided placement falls back to an even split once count exceeds 2*capacity (round-4 point 2)", () => {
    const radius = 20;
    const gap = 20;
    const capacity = slotsPerRow(radius, gap);
    expect(capacity).toBe(1);
    const count = capacity * 2 + 1; // 3 — leading-side-fill would put 1 left + 2 right, overflowing
    const positions = computeElevatorBadgePositions(0, 0, 10, count, radius, 4, gap, "left_right", false);
    expect(positions).toHaveLength(count);
    // Even split of 3 -> ceil=2 left, floor=1 right.
    expect(positions.filter((p) => p.x < 0)).toHaveLength(2);
    expect(positions.filter((p) => p.x > 0)).toHaveLength(1);
  });

  it("evenDistribution off: full_circle falls back to an even ring once the contiguous arc would wrap past 360° (round-4 point 1)", () => {
    // Large radius/gap relative to a small ring -> angleStep close to/over the wrap threshold.
    const positions = computeElevatorBadgePositions(0, 0, 1, 6, 5, 0, 8, "full_circle", false);
    expect(positions).toHaveLength(6);
    const ring = 1 + 0 + 5;
    // Even-ring layout starts exactly at 12 o'clock (x≈0, y≈-ring) — the arc-fallback layout
    // would not, since with evenDistribution off it centers on 12 o'clock symmetrically instead.
    expect(positions[0].x).toBeCloseTo(0);
    expect(positions[0].y).toBeCloseTo(-ring);
    expect(positions[3].x).toBeCloseTo(0);
    expect(positions[3].y).toBeCloseTo(ring);
  });
});

describe("elevatorBadgesOverlap", () => {
  it("false for fewer than two badges", () => {
    expect(elevatorBadgesOverlap([], 5)).toBe(false);
    expect(elevatorBadgesOverlap([{ x: 0, y: 0 }], 5)).toBe(false);
  });

  it("false when badges are exactly touching (not overlapping)", () => {
    expect(elevatorBadgesOverlap([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5)).toBe(false);
  });

  it("true when two badges' centers are closer than 2*radius", () => {
    expect(elevatorBadgesOverlap([{ x: 0, y: 0 }, { x: 9, y: 0 }], 5)).toBe(true);
  });
});

describe("elevatorBadgesTooMany", () => {
  it("false for full_circle regardless of count or evenDistribution", () => {
    expect(elevatorBadgesTooMany(100, 20, 20, "full_circle", true)).toBe(false);
    expect(elevatorBadgesTooMany(100, 20, 20, "full_circle", false)).toBe(false);
  });

  it("false for count <= 0", () => {
    expect(elevatorBadgesTooMany(0, 20, 20, "left_right", true)).toBe(false);
  });

  it("evenDistribution on: true when either split half exceeds slotsPerRow capacity", () => {
    const radius = 20;
    const gap = 20;
    expect(slotsPerRow(radius, gap)).toBe(1);
    expect(elevatorBadgesTooMany(3, radius, gap, "left_right", true)).toBe(true);
    expect(elevatorBadgesTooMany(2, radius, gap, "left_right", true)).toBe(false);
  });

  it("false when both split halves fit within capacity", () => {
    expect(elevatorBadgesTooMany(2, 2, 0, "left_right", true)).toBe(false);
  });

  it("evenDistribution off: true once the leading side alone exceeds capacity", () => {
    const radius = 2;
    const gap = 4;
    const capacity = slotsPerRow(radius, gap);
    expect(elevatorBadgesTooMany(capacity, radius, gap, "left_right", false)).toBe(false);
    expect(elevatorBadgesTooMany(capacity + 1, radius, gap, "left_right", false)).toBe(false);
    // Once the *other* side (the remainder) also exceeds capacity, it flags too.
    expect(elevatorBadgesTooMany(capacity * 2 + 1, radius, gap, "left_right", false)).toBe(true);
  });
});

describe("formatElevatorBadgeLabel", () => {
  it("arabic: floorIndex 0 -> \"1\"", () => {
    expect(formatElevatorBadgeLabel(0, "arabic")).toBe("1");
    expect(formatElevatorBadgeLabel(4, "arabic")).toBe("5");
  });

  it("roman: floorIndex 0 -> \"I\", covers subtractive forms", () => {
    expect(formatElevatorBadgeLabel(0, "roman")).toBe("I");
    expect(formatElevatorBadgeLabel(3, "roman")).toBe("IV");
    expect(formatElevatorBadgeLabel(8, "roman")).toBe("IX");
  });

  it("letters: floorIndex 0 -> \"A\", wraps past Z into AA", () => {
    expect(formatElevatorBadgeLabel(0, "letters")).toBe("A");
    expect(formatElevatorBadgeLabel(25, "letters")).toBe("Z");
    expect(formatElevatorBadgeLabel(26, "letters")).toBe("AA");
  });
});
