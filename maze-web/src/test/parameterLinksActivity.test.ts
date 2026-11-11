import { describe, it, expect } from "vitest";
import { isPathActive, computeActivePaths, type ParamActivityContext, type ParamActivitySettings } from "../store/parameterLinksActivity";
import type { ParamDescriptor } from "../store/parameterLinks";
import { isSchemaPathInMode } from "../store/parameterLinkSchema";

type P =
  | "teleportMarker.fillColor"
  | "teleportFloorBadge.shape"
  | "teleportThroughSeams"
  | "teleportCurveStrength"
  | "teleportCurveDirection"
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
  | "decorativeElevator.lineColor"
  | "elevatorBadges.enabled"
  | "elevatorBadges.cornerStyle"
  | "elevatorBadges.fillColor"
  | "markerIndex.enabled"
  | "markerIndex.fillColor"
  | "background"
  | "floorLabel.labelType"
  | "trimWallsAtFaceBoundaries"
  | "showCutLines"
  | "cutLinesGlueColor"
  | "glueTabs.width"
  | "creases.lineWidth"
  | "edgeMarkers.shape";

const registry: Record<P, ParamDescriptor> = Object.fromEntries(
  [
    "teleportMarker.fillColor", "teleportFloorBadge.shape", "teleportThroughSeams", "teleportCurveStrength", "teleportCurveDirection", "oneWayColor", "replaceTwoFloorElevatorsWithStairs",
    "gridColor", "innerGridColor", "verticalCornerStyle", "verticalSize", "verticalArrowSize",
    "verticalDecorativeSize", "verticalDecorativeArrowSize",
    "twoWayArrowColor", "decorativeStairsArrowColor", "oneWayArrowColor",
    "decorativeStairsOneWayArrowColor", "elevatorArrowColor", "decorativeElevator.lineColor",
    "elevatorBadges.enabled", "elevatorBadges.cornerStyle", "elevatorBadges.fillColor",
    "markerIndex.enabled", "markerIndex.fillColor", "background", "floorLabel.labelType",
    "trimWallsAtFaceBoundaries", "showCutLines", "cutLinesGlueColor", "glueTabs.width", "creases.lineWidth", "edgeMarkers.shape",
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
  hasMarkerIndexSource: true,
  hasSplits: false,
  hasGlues: false,
  hasCreases: false,
  hasMultipleFloors: false,
  hasAreaSpread: true,
  hasSeams: true,
};

function active(path: P, ctx: Partial<ParamActivityContext> = {}, settings: ParamActivitySettings = {}): boolean {
  return isPathActive(path, "walls", { ...baseCtx, ...ctx }, settings);
}

describe("isPathActive", () => {
  it("marks the floor-label index style inactive in title mode", () => {
    const floorLabel = { enabled: true, backgroundShape: "rectangle" as const };
    expect(active("floorLabel.labelType", { hasMultipleFloors: true }, { floorLabel: { ...floorLabel, labelMode: "index" } })).toBe(true);
    expect(active("floorLabel.labelType", { hasMultipleFloors: true }, { floorLabel: { ...floorLabel, labelMode: "title" } })).toBe(false);
  });

  it("hides teleport fields when the maze has no teleports", () => {
    expect(active("teleportMarker.fillColor", { hasTeleports: false })).toBe(false);
  });

  it("shows teleport fields when the maze has teleports", () => {
    expect(active("teleportMarker.fillColor", { hasTeleports: true })).toBe(true);
  });

  it("hides cross-floor teleport badge fields even with teleports, unless cross-floor ones exist", () => {
    expect(active("teleportFloorBadge.shape", { hasTeleports: true, hasCrossFloorTeleports: false })).toBe(false);
    expect(active("teleportFloorBadge.shape", { hasTeleports: true, hasCrossFloorTeleports: true })).toBe(true);
  });

  it("shows the seam toggle only while some floor has a seam (GitHub issue #873)", () => {
    expect(active("teleportThroughSeams", { hasTeleports: true, hasSeams: false })).toBe(false);
    expect(active("teleportThroughSeams", { hasTeleports: true, hasSeams: true })).toBe(true);
  });

  it("shows the curve fields only for the curved connector style", () => {
    expect(active("teleportCurveStrength", { hasTeleports: true }, { teleportConnectorStyle: "orthogonal" })).toBe(false);
    expect(active("teleportCurveStrength", { hasTeleports: true }, { teleportConnectorStyle: "curved" })).toBe(true);
    expect(active("teleportCurveDirection", { hasTeleports: true }, { teleportConnectorStyle: "curved" })).toBe(true);
  });

  it("gates one-way fields on hasOneWays", () => {
    expect(active("oneWayColor", { hasOneWays: false })).toBe(false);
    expect(active("oneWayColor", { hasOneWays: true })).toBe(true);
  });

  it("gates replaceTwoFloorElevatorsWithStairs on hasElevators", () => {
    expect(active("replaceTwoFloorElevatorsWithStairs", { hasElevators: false })).toBe(false);
    expect(active("replaceTwoFloorElevatorsWithStairs", { hasElevators: true })).toBe(true);
  });

  it("keeps both grid colors available whatever the grid toggles say — the panel always shows them", () => {
    for (const settings of [{}, { showGrid: false }, { showGrid: true, showInnerGrid: false }, { showGrid: true, showInnerGrid: true }]) {
      expect(active("gridColor", {}, settings)).toBe(true);
      expect(active("innerGridColor", {}, settings)).toBe(true);
    }
  });

  it("gates vertical shared-style fields on hasVerticalSection, abstract/decorative split by verticalStyle", () => {
    expect(active("verticalCornerStyle", { hasVerticalSection: false }, { verticalStyle: "abstract" })).toBe(false);
    expect(active("verticalSize", { hasVerticalSection: true }, { verticalStyle: "abstract" })).toBe(true);
    expect(active("verticalBorderColor", { hasVerticalSection: true }, { verticalStyle: "abstract" })).toBe(true);
    expect(active("verticalSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("verticalBorderColor", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("verticalArrowSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(false);
    expect(active("verticalDecorativeSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("verticalDecorativeSize", { hasVerticalSection: true }, { verticalStyle: "abstract" })).toBe(false);
    expect(active("verticalDecorativeArrowSize", { hasVerticalSection: true }, { verticalStyle: "decorative" })).toBe(true);
    // Corridors mode has no `verticalStyle` (undefined) — abstract-only fields stay active there.
    expect(active("verticalSize", { hasVerticalSection: true }, {})).toBe(true);
    expect(active("verticalBorderColor", { hasVerticalSection: true }, {})).toBe(true);
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
    expect(active("decorativeElevator.lineColor", { hasElevators: true }, { verticalStyle: "decorative" })).toBe(true);
    expect(active("decorativeElevator.lineColor", { hasElevators: false }, { verticalStyle: "decorative" })).toBe(false);
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
    expect(active("markerIndex.enabled", { hasMarkerIndexSource: false }, { markerIndex: { enabled: true } })).toBe(false);
    expect(active("markerIndex.fillColor", { hasMarkerIndexSource: false }, { markerIndex: { enabled: true } })).toBe(false);
  });

  it("marks every Topology path inactive when the active floor has no glues", () => {
    const settings: ParamActivitySettings = {
      showCutLines: true,
      glueTabs: { showTabs: true, lineWidth: 1 },
      creases: { showCreases: true, mode: "lines" },
      edgeMarkers: { mode: "all" },
    };
    for (const path of ["trimWallsAtFaceBoundaries", "showCutLines", "cutLinesGlueColor", "glueTabs.width", "creases.lineWidth", "edgeMarkers.shape"] as const) {
      expect(active(path, { hasGlues: false, hasCreases: true }, settings)).toBe(false);
      expect(active(path, { hasGlues: true, hasCreases: true }, settings)).toBe(true);
    }
  });

  it("defaults unrecognized paths to active", () => {
    expect(active("background")).toBe(true);
  });
});

describe("computeActivePaths", () => {
  it("returns exactly the set of paths isPathActive accepts for the given context", () => {
    const ctx: ParamActivityContext = { ...baseCtx, hasTeleports: true, hasOneWays: true };
    const settings: ParamActivitySettings = { teleportConnectorStyle: "straight" };
    const result = computeActivePaths(registry, "walls", ctx, settings);
    expect(result.has("teleportMarker.fillColor")).toBe(true);
    expect(result.has("oneWayColor")).toBe(true);
    expect(result.has("teleportCurveStrength")).toBe(false);
    expect(result.has("background")).toBe(true);
  });
});

describe("isPathActive: size adaptation (GitHub issue #819)", () => {
  const check = (path: string, hasAreaSpread: boolean) => isPathActive(path, "walls", { ...baseCtx, hasAreaSpread }, {});

  it("deactivates every adaptation path when the cell areas have no spread", () => {
    for (const path of ["startMarker.sizeAdaptation", "teleportFloorBadge.sizeAdaptation", "markerSizeAdaptation", "verticalSizeAdaptation"]) {
      expect(check(path, false)).toBe(false);
    }
  });

  it("keeps an adaptation path active when the spread exists", () => {
    expect(check("startMarker.sizeAdaptation", true)).toBe(true);
  });
});

describe("isPathActive: color rules shared with the color registry (GitHub issue #965)", () => {
  it("hides the wall color while a random wall color mode is on, keeps it otherwise", () => {
    expect(active("wallColor" as P, {}, {})).toBe(true);
    expect(active("wallColor" as P, {}, { randomWallColorMode: "off" })).toBe(true);
    expect(active("wallColor" as P, {}, { randomWallColorMode: "per_pass" })).toBe(false);
    expect(active("wallColor" as P, {}, { randomWallColorMode: "per_segment" })).toBe(false);
  });

  it("hides the floor label border color without a background plate or at zero border width", () => {
    const label = { enabled: true, labelMode: "index" as const };
    const on = (extra: object) => active("floorLabel.borderColor" as P, { hasMultipleFloors: true }, { floorLabel: { ...label, backgroundShape: "rectangle", ...extra } as never });
    expect(on({})).toBe(true);
    expect(on({ borderWidth: 2 })).toBe(true);
    expect(on({ borderWidth: 0 })).toBe(false);
    expect(on({ backgroundShape: "none" })).toBe(false);
  });
});

describe("isSchemaPathInMode (GitHub issue #965)", () => {
  it("tells a walls-only, a corridors-only, a shared and an unknown path apart", () => {
    expect(isSchemaPathInMode("floorColor", "walls")).toBe(true);
    expect(isSchemaPathInMode("floorColor", "corridors")).toBe(false);
    expect(isSchemaPathInMode("color", "corridors")).toBe(true);
    expect(isSchemaPathInMode("color", "walls")).toBe(false);
    expect(isSchemaPathInMode("startMarker.fillColor", "walls")).toBe(true);
    expect(isSchemaPathInMode("startMarker.fillColor", "corridors")).toBe(true);
    expect(isSchemaPathInMode("no.such.path", "walls")).toBe(false);
  });
});

describe("isPathActive: start/finish marker (GitHub issue #963)", () => {
  const check = (path: string, settings: ParamActivitySettings) => isPathActive(path, "walls", baseCtx, settings);

  it("deactivates the marker look when the marker is off, keeps the toggle and the caption fields", () => {
    const off = { startMarker: { markerEnabled: false, textEnabled: true }, finishMarker: { markerEnabled: false, textEnabled: true } };
    for (const kind of ["startMarker", "finishMarker"]) {
      for (const field of ["shape", "cornerStyle", "size", "sizeAdaptation", "fillColor", "borderColor", "borderWidth", "gapWidth"]) {
        expect(check(`${kind}.${field}`, off)).toBe(false);
      }
      expect(check(`${kind}.markerEnabled`, off)).toBe(true);
      expect(check(`${kind}.textColor`, off)).toBe(true);
    }
  });

  it("keeps the marker look active when the marker is on or unset, and gates start/finish independently", () => {
    expect(check("startMarker.size", { startMarker: {} })).toBe(true);
    expect(check("startMarker.size", { startMarker: { markerEnabled: true } })).toBe(true);
    expect(check("finishMarker.fillColor", { startMarker: { markerEnabled: false }, finishMarker: { markerEnabled: true } })).toBe(true);
    expect(check("startMarker.fillColor", { startMarker: { markerEnabled: false }, finishMarker: { markerEnabled: true } })).toBe(false);
  });
});

describe("isPathActive: start/finish caption", () => {
  const check = (path: string, settings: ParamActivitySettings) => isPathActive(path, "walls", baseCtx, settings);

  it("deactivates caption style fields when the caption is off, keeps the toggle active", () => {
    const off = { startMarker: { textEnabled: false }, finishMarker: { textEnabled: false } };
    for (const kind of ["startMarker", "finishMarker"]) {
      expect(check(`${kind}.textColor`, off)).toBe(false);
      expect(check(`${kind}.textSize`, off)).toBe(false);
      expect(check(`${kind}.textFontWeight`, off)).toBe(false);
      expect(check(`${kind}.textEnabled`, off)).toBe(true);
      expect(check(`${kind}.fillColor`, off)).toBe(true);
    }
  });

  it("keeps caption style fields active when the caption is on, and gates start/finish independently", () => {
    expect(check("startMarker.textColor", { startMarker: { textEnabled: true } })).toBe(true);
    expect(check("finishMarker.textColor", { startMarker: { textEnabled: false }, finishMarker: { textEnabled: true } })).toBe(true);
    expect(check("startMarker.textColor", { startMarker: { textEnabled: false }, finishMarker: { textEnabled: true } })).toBe(false);
  });
});
