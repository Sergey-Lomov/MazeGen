import { describe, it, expect } from "vitest";
import { computeElevatorBadgeLayout, computeElevatorBadgePositions, elevatorBadgesOverlap, elevatorBadgesTooMany, formatElevatorBadgeLabel, slotsPerRow } from "../pixi/renderers/elevatorBadgeLayout";
import { TILE_SIZE } from "../pixi/constants";
import { circleOverlapsRoundedRect } from "../pixi/renderers/verticalConnectionGeometry";
import { markerIndexPlateBox, markerIndexPlateFootprint, type MarkerIndexLabel } from "../pixi/selectors/mazeSelectors/markerIndex";
import { DEFAULT_MARKER_INDEX_SETTINGS } from "../store/slices/imageExportDefaults";

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

  it("full_circle rotates its starting point clockwise by startAngle", () => {
    const positions = computeElevatorBadgePositions(0, 0, 10, 4, 5, 4, 0, "full_circle", true, undefined, 90);
    const ring = 10 + 4 + 5;
    expect(positions[0].x).toBeCloseTo(ring);
    expect(positions[0].y).toBeCloseTo(0);
  });

  it("full_circle even distribution keeps floor-slot order when the start angle leaves zero", () => {
    const input = { cx: 0, cy: 0, markerRadius: 10, count: 4, radius: 5, distance: 4, gap: 0, placement: "full_circle" as const, evenDistribution: true };
    const atZero = computeElevatorBadgeLayout({ ...input, startAngle: 0 }).positions;
    const atOne = computeElevatorBadgeLayout({ ...input, startAngle: 1 }).positions;
    const turn = Math.PI / 180;
    for (let i = 0; i < input.count; i++) {
      expect(atOne[i].x).toBeCloseTo(atZero[i].x * Math.cos(turn) - atZero[i].y * Math.sin(turn), 6);
      expect(atOne[i].y).toBeCloseTo(atZero[i].x * Math.sin(turn) + atZero[i].y * Math.cos(turn), 6);
    }
  });

  it("full_circle even distribution keeps its ordered slots continuous at zero around an obstacle", () => {
    const input = { cx: 0, cy: 0, markerRadius: 10, count: 4, radius: 5, distance: 4, gap: 0, placement: "full_circle" as const, evenDistribution: true };
    const plate = { x: -40, y: 12, w: 80, h: 30, radius: 4 };
    const atZero = computeElevatorBadgeLayout({ ...input, startAngle: 0, obstacles: [plate] }).positions;
    const atOne = computeElevatorBadgeLayout({ ...input, startAngle: 1, obstacles: [plate] }).positions;
    for (let i = 0; i < input.count; i++) {
      expect(Math.hypot(atOne[i].x - atZero[i].x, atOne[i].y - atZero[i].y)).toBeLessThan(1);
    }
  });

  it("full_circle advances through every start angle even while that angle faces a blocked arc", () => {
    const input = { cx: 0, cy: 0, markerRadius: 10, count: 4, radius: 5, distance: 4, gap: 0, placement: "full_circle" as const, evenDistribution: true };
    const plate = { x: -40, y: 12, w: 80, h: 30, radius: 4 };
    const firstBadgeAt = (startAngle: number) => computeElevatorBadgeLayout({ ...input, startAngle, obstacles: [plate] }).positions[0];
    const at135 = firstBadgeAt(135);
    const at180 = firstBadgeAt(180);
    const at225 = firstBadgeAt(225);
    expect(Math.hypot(at180.x - at135.x, at180.y - at135.y)).toBeGreaterThan(1);
    expect(Math.hypot(at225.x - at180.x, at225.y - at180.y)).toBeGreaterThan(1);
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
    expect(computeElevatorBadgeLayout({ cx: 0, cy: 0, markerRadius: 1, count: 6, radius: 5, distance: 0, gap: 8, placement: "full_circle", evenDistribution: false }).usedEvenDistributionFallback).toBe(true);
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

describe("computeElevatorBadgeLayout with obstacles (GitHub issue #964)", () => {
  const radius = 5;
  const base = { cx: 0, cy: 0, markerRadius: 10, radius, distance: 4, gap: 2 } as const;
  // A marker-index plate right below the marker, covering the whole bottom side.
  const plate = { x: -40, y: 12, w: 80, h: 30, radius: 4 };
  const clear = (positions: { x: number; y: number }[]) => positions.every((p) => !circleOverlapsRoundedRect(p.x, p.y, radius, plate));

  it("no obstacles: same positions as computeElevatorBadgePositions", () => {
    const input = { ...base, count: 3, placement: "top_bottom", evenDistribution: true } as const;
    expect(computeElevatorBadgeLayout(input).positions).toEqual(computeElevatorBadgePositions(0, 0, 10, 3, radius, 4, 2, "top_bottom", true));
    expect(computeElevatorBadgeLayout({ ...input, obstacles: [] }).positions).toEqual(computeElevatorBadgeLayout(input).positions);
  });

  it("an obstacle far from every slot changes nothing", () => {
    const input = { ...base, count: 3, placement: "left_right", evenDistribution: true } as const;
    const far = { x: 500, y: 500, w: 10, h: 10, radius: 0 };
    expect(computeElevatorBadgeLayout({ ...input, obstacles: [far] })).toEqual(computeElevatorBadgeLayout(input));
  });

  it.each(["left_right", "right_left", "top_bottom", "bottom_top", "full_circle"] as const)("%s: no badge overlaps the plate and every floor keeps a badge", (placement) => {
    for (const evenDistribution of [true, false]) {
      for (const count of [1, 2, 3, 4]) {
        const { positions } = computeElevatorBadgeLayout({ ...base, count, placement, evenDistribution, obstacles: [plate] });
        expect(positions).toHaveLength(count);
        expect(clear(positions)).toBe(true);
      }
    }
  });

  it("bottom_top: a badge whose slot is under the plate moves to the free opposite side", () => {
    const free = computeElevatorBadgeLayout({ ...base, count: 1, placement: "bottom_top", evenDistribution: true }).positions[0];
    expect(circleOverlapsRoundedRect(free.x, free.y, radius, plate)).toBe(true);
    const { positions } = computeElevatorBadgeLayout({ ...base, count: 1, placement: "bottom_top", evenDistribution: true, obstacles: [plate] });
    expect(positions[0].y).toBe(-free.y);
    expect(positions[0].x).toBe(free.x);
  });

  it("two-sided: a blocked leading side spills onto the free side when evenDistribution is off", () => {
    const wide = { x: -200, y: 12, w: 400, h: 60, radius: 0 };
    const { positions, overflow } = computeElevatorBadgeLayout({ ...base, count: 2, placement: "bottom_top", evenDistribution: false, obstacles: [wide] });
    expect(overflow).toBe(false);
    expect(positions.every((p) => p.y < 0)).toBe(true);
  });

  it("overflow: a side whose free slots are fewer than its badges reports too many", () => {
    // Plate covers all of the bottom row except its edges, so 3 badges per side cannot fit.
    const input = { ...base, count: 6, placement: "top_bottom", evenDistribution: true } as const;
    expect(computeElevatorBadgeLayout(input).overflow).toBe(false);
    const blockingBottom = { x: -200, y: 12, w: 400, h: 60, radius: 0 };
    expect(computeElevatorBadgeLayout({ ...input, obstacles: [blockingBottom] }).overflow).toBe(true);
  });

  it("full_circle: stays on the ring and skips the blocked arc", () => {
    const ring = 10 + 4 + radius;
    const { positions, overflow } = computeElevatorBadgeLayout({ ...base, count: 4, placement: "full_circle", evenDistribution: true, obstacles: [plate] });
    expect(overflow).toBe(false);
    for (const p of positions) expect(Math.hypot(p.x, p.y)).toBeCloseTo(ring);
    expect(clear(positions)).toBe(true);
  });

  it.each([true, false])("full_circle (evenDistribution %s): badges stay mirror-symmetric around the vertical axis", (evenDistribution) => {
    for (const count of [1, 2, 3, 4, 5, 6, 7]) {
      const { positions } = computeElevatorBadgeLayout({ ...base, count, placement: "full_circle", evenDistribution, obstacles: [plate] });
      const left = positions.filter((p) => p.x < -1e-6).length;
      const right = positions.filter((p) => p.x > 1e-6).length;
      expect(left).toBe(right);
    }
  });

  it("two-sided even split: a side with fewer free slots passes its surplus to the other side instead of spreading out", () => {
    // Many small badges: the unobstructed split is 4 + 4; a plate under the marker takes slots of the bottom row.
    const small = { ...base, radius: 2, gap: 1, distance: 2 } as const;
    const bottomPlate = { x: -14, y: 12, w: 28, h: 20, radius: 0 };
    const plain = computeElevatorBadgeLayout({ ...small, count: 8, placement: "top_bottom", evenDistribution: true });
    expect(plain.positions.filter((p) => p.y < 0)).toHaveLength(4);
    const withPlate = computeElevatorBadgeLayout({ ...small, count: 8, placement: "top_bottom", evenDistribution: true, obstacles: [bottomPlate] });
    const top = withPlate.positions.filter((p) => p.y < 0).length;
    const bottom = withPlate.positions.filter((p) => p.y > 0).length;
    expect(top + bottom).toBe(8);
    expect(top).toBeGreaterThan(bottom);
    // No spreading: the bottom row stays inside the cell.
    for (const p of withPlate.positions.filter((q) => q.y > 0)) expect(Math.abs(p.x) + 2).toBeLessThanOrEqual(TILE_SIZE / 2 + 1e-6);
  });

  it("full_circle: a fully blocked ring falls back to the plain layout", () => {
    const everything = { x: -500, y: -500, w: 1000, h: 1000, radius: 0 };
    const plain = computeElevatorBadgeLayout({ ...base, count: 3, placement: "full_circle", evenDistribution: true }).positions;
    expect(computeElevatorBadgeLayout({ ...base, count: 3, placement: "full_circle", evenDistribution: true, obstacles: [everything] }).positions).toEqual(plain);
  });
});

describe("circleOverlapsRoundedRect", () => {
  const rect = { x: 0, y: 0, w: 10, h: 10, radius: 0 };
  it("false when only touching, true when overlapping", () => {
    expect(circleOverlapsRoundedRect(15, 5, 5, rect)).toBe(false);
    expect(circleOverlapsRoundedRect(14, 5, 5, rect)).toBe(true);
  });
  it("respects rounded corners", () => {
    const round = { ...rect, radius: 5 };
    expect(circleOverlapsRoundedRect(13, 13, 5, rect)).toBe(true);
    expect(circleOverlapsRoundedRect(13, 13, 5, round)).toBe(false);
  });
});

describe("ring layout ignores obstacles out of reach", () => {
  it("a far plate leaves the ring identical to the obstacle-free one", () => {
    const base = { cx: 100, cy: 100, markerRadius: 10, count: 5, radius: 6, distance: 4, gap: 2, placement: "full_circle" as const, evenDistribution: true };
    const far = { x: 5000, y: 5000, w: 40, h: 20, radius: 4 };
    expect(computeElevatorBadgeLayout({ ...base, obstacles: [far] })).toEqual(computeElevatorBadgeLayout(base));
  });
});

describe("ring blocked all around", () => {
  it("draws as if free instead of dropping badges", () => {
    const base = { cx: 0, cy: 0, markerRadius: 10, count: 4, radius: 6, distance: 4, gap: 2, placement: "full_circle" as const, evenDistribution: true };
    const cover = { x: -500, y: -500, w: 1000, h: 1000, radius: 0 };
    const blocked = computeElevatorBadgeLayout({ ...base, obstacles: [cover] });
    expect(blocked.positions).toHaveLength(4);
    expect(blocked).toEqual(computeElevatorBadgeLayout(base));
  });
});

describe("markerIndexPlateFootprint (GitHub issue #964)", () => {
  it("is the plate body inflated by the border on every side", () => {
    const style = { ...DEFAULT_MARKER_INDEX_SETTINGS, borderWidthFromMarker: false, borderWidth: 3 };
    const label = { pos: [50, 40], markerOuterRadius: 8 } as unknown as MarkerIndexLabel;
    const box = markerIndexPlateBox(label, style);
    const foot = markerIndexPlateFootprint(label, style);
    expect(foot).toEqual({ x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6, radius: box.cornerRadius + 3 });
  });
});
