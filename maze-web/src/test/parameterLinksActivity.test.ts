import { describe, it, expect } from "vitest";
import { isPathActive, computeActivePaths, type ParamActivityContext, type ParamActivitySettings } from "../store/parameterLinksActivity";
import type { ParamDescriptor } from "../store/parameterLinks";

type P =
  | "teleportMarker.fillColor"
  | "teleportFloorBadge.enabled"
  | "oneWayColor"
  | "replaceTwoFloorElevatorsWithStairs"
  | "gridColor"
  | "innerGridColor"
  | "verticalCornerStyle"
  | "verticalSize"
  | "verticalArrowSize"
  | "verticalDecorativeSize"
  | "verticalDecorativeArrowSize"
  | "twoWayArrowColor"
  | "decorativeStairsArrowColor"
  | "oneWayArrowColor"
  | "decorativeStairsOneWayArrowColor"
  | "elevatorArrowColor"
  | "decorativeElevator.fillColor"
  | "elevatorBadges.enabled"
  | "elevatorBadges.cornerStyle"
  | "elevatorBadges.fillColor"
  | "markerIndex.enabled"
  | "markerIndex.fillColor"
  | "backgroundColor";

const registry: Record<P, ParamDescriptor> = Object.fromEntries(
  [
    "teleportMarker.fillColor", "teleportFloorBadge.enabled", "oneWayColor", "replaceTwoFloorElevatorsWithStairs",
    "gridColor", "innerGridColor", "verticalCornerStyle", "verticalSize", "verticalArrowSize",
    "verticalDecorativeSize", "verticalDecorativeArrowSize",
    "twoWayArrowColor", "decorativeStairsArrowColor", "oneWayArrowColor",
    "decorativeStairsOneWayArrowColor", "elevatorArrowColor", "decorativeElevator.fillColor",
    "elevatorBadges.enabled", "elevatorBadges.cornerStyle", "elevatorBadges.fillColor",
    "markerIndex.enabled", "markerIndex.fillColor", "backgroundColor",
  ].map((p) => [p, { type: "color", equals: Object.is, label: p, group: [], format: String }]),
) as unknown as Record<P, ParamDescriptor>;

const baseCtx: ParamActivityContext = {
  hasOneWays: false,
  hasTeleports: false,
  hasCrossFloorTeleports: false,
  hasTwoWayPassages: false,
  hasOneWayPassages: false,
  hasElevators: false,
  hasVerticalSection: false,
};

function active(path: P, ctx: Partial<ParamActivityContext> = {}, settings: ParamActivitySettings = {}): boolean {
  return isPathActive(path, registry, { ...baseCtx, ...ctx }, settings);
}

describe("isPathActive", () => {
  it("hides teleport fields when the maze has no teleports", () => {
    expect(active("teleportMarker.fillColor", { hasTeleports: false })).toBe(false);
  });

  it("shows teleport fields when the maze has teleports", () => {
    expect(active("teleportMarker.fillColor", { hasTeleports: true })).toBe(true);
  });

  it("hides cross-floor teleport badge fields even with teleports, unless cross-floor ones exist", () => {
    expect(active("teleportFloorBadge.enabled", { hasTeleports: true, hasCrossFloorTeleports: false })).toBe(false);
    expect(active("teleportFloorBadge.enabled", { hasTeleports: true, hasCrossFloorTeleports: true })).toBe(true);
  });

  it("gates one-way fields on hasOneWays", () => {
    expect(active("oneWayColor", { hasOneWays: false })).toBe(false);
    expect(active("oneWayColor", { hasOneWays: true })).toBe(true);
  });

  it("gates replaceTwoFloorElevatorsWithStairs on hasElevators", () => {
    expect(active("replaceTwoFloorElevatorsWithStairs", { hasElevators: false })).toBe(false);
    expect(active("replaceTwoFloorElevatorsWithStairs", { hasElevators: true })).toBe(true);
  });

  it("hides gridColor only when showGrid is explicitly false", () => {
    expect(active("gridColor", {}, {})).toBe(true);
    expect(active("gridColor", {}, { showGrid: true })).toBe(true);
    expect(active("gridColor", {}, { showGrid: false })).toBe(false);
  });

  it("hides innerGridColor when either showGrid or showInnerGrid is false", () => {
    expect(active("innerGridColor", {}, {})).toBe(true);
    expect(active("innerGridColor", {}, { showGrid: false })).toBe(false);
    expect(active("innerGridColor", {}, { showGrid: true, showInnerGrid: false })).toBe(false);
    expect(active("innerGridColor", {}, { showGrid: true, showInnerGrid: true })).toBe(true);
  });

  it("gates vertical shared-style fields on hasVerticalSection, abstract/decorative split by verticalStyle", () => {
    expect(active("verticalCornerStyle", { hasVerticalSection: false }, { verticalStyle: "abstract" })).toBe(false);
    expect(active("verticalSize", { hasVerticalSection: true }, { verticalStyle: "abstract" })).toBe(true);
    expect(active("verticalSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("verticalArrowSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("verticalDecorativeSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("verticalDecorativeSize", { hasVerticalSection: true }, { verticalStyle: "abstract" })).toBe(false);
    expect(active("verticalDecorativeArrowSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(true);
    // Corridors mode has no `verticalStyle` (undefined) — abstract-only fields stay active there.
    expect(active("verticalSize", { hasVerticalSection: true }, {})).toBe(true);
    expect(active("verticalCornerStyle", { hasVerticalSection: true }, {})).toBe(true);
  });

  it("shows two-way abstract fields only when hasTwoWayPassages and verticalStyle isn't decorative", () => {
    expect(active("twoWayArrowColor", { hasTwoWayPassages: false }, { verticalStyle: "abstract" })).toBe(false);
    expect(active("twoWayArrowColor", { hasTwoWayPassages: true }, { verticalStyle: "abstract" })).toBe(true);
    expect(active("twoWayArrowColor", { hasTwoWayPassages: true }, { verticalStyle: "decorative" })).toBe(false);
  });

  it("shows two-way decorative fields only when hasTwoWayPassages and verticalStyle is decorative", () => {
    expect(active("decorativeStairsArrowColor", { hasTwoWayPassages: true }, { verticalStyle: "abstract" })).toBe(false);
    expect(active("decorativeStairsArrowColor", { hasTwoWayPassages: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("decorativeStairsArrowColor", { hasTwoWayPassages: false }, { verticalStyle: "decorative" })).toBe(false);
  });

  it("shows one-way-passage abstract/decorative fields mirroring the two-way split", () => {
    expect(active("oneWayArrowColor", { hasOneWayPassages: true }, { verticalStyle: "abstract" })).toBe(true);
    expect(active("oneWayArrowColor", { hasOneWayPassages: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("decorativeStairsOneWayArrowColor", { hasOneWayPassages: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("decorativeStairsOneWayArrowColor", { hasOneWayPassages: false }, { verticalStyle: "decorative" })).toBe(false);
  });

  it("shows elevator abstract/decorative fields mirroring the same split", () => {
    expect(active("elevatorArrowColor", { hasElevators: true }, { verticalStyle: "abstract" })).toBe(true);
    expect(active("elevatorArrowColor", { hasElevators: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("decorativeElevator.fillColor", { hasElevators: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("decorativeElevator.fillColor", { hasElevators: false }, { verticalStyle: "decorative" })).toBe(false);
  });

  it("gates elevatorBadges.* on hasElevators only, regardless of verticalStyle (the subsection renders in both modes)", () => {
    expect(active("elevatorBadges.enabled", { hasElevators: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("elevatorBadges.cornerStyle", { hasElevators: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("elevatorBadges.enabled", { hasElevators: false }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("elevatorBadges.enabled", { hasElevators: true }, { verticalStyle: "abstract" })).toBe(true);
  });

  it("gates other elevatorBadges.* subfields additionally on elevatorBadges.enabled", () => {
    expect(active("elevatorBadges.fillColor", { hasElevators: true }, { verticalStyle: "decorative", elevatorBadges: { enabled: true } })).toBe(true);
    expect(active("elevatorBadges.fillColor", { hasElevators: true }, { verticalStyle: "decorative", elevatorBadges: { enabled: false } })).toBe(false);
  });

  it("markerIndex.enabled is always active; other markerIndex.* subfields follow markerIndex.enabled", () => {
    expect(active("markerIndex.enabled", {}, { markerIndex: { enabled: false } })).toBe(true);
    expect(active("markerIndex.fillColor", {}, { markerIndex: { enabled: true } })).toBe(true);
    expect(active("markerIndex.fillColor", {}, { markerIndex: { enabled: false } })).toBe(false);
    expect(active("markerIndex.fillColor", {}, {})).toBe(true);
  });

  it("defaults unrecognized paths to active", () => {
    expect(active("backgroundColor")).toBe(true);
  });
});

describe("computeActivePaths", () => {
  it("returns exactly the set of paths isPathActive accepts for the given context", () => {
    const ctx: ParamActivityContext = { ...baseCtx, hasTeleports: true, hasOneWays: true };
    const settings: ParamActivitySettings = { showGrid: false };
    const result = computeActivePaths(registry, ctx, settings);
    expect(result.has("teleportMarker.fillColor")).toBe(true);
    expect(result.has("oneWayColor")).toBe(true);
    expect(result.has("gridColor")).toBe(false);
    expect(result.has("backgroundColor")).toBe(true);
  });
});
