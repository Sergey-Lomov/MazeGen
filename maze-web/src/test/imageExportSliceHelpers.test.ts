import { describe, it, expect } from "vitest";
import {
  applyVectorByWallsSharedStyle,
  applyVectorByCorridorsSharedStyle,
  forceVectorByWallsSharedStyle,
  forceVectorByCorridorsSharedStyle,
  reconcileVectorByWallsSharedStyle,
  reconcileVectorByCorridorsSharedStyle,
  withOverride,
  withoutOverride,
} from "../store/slices/imageExportSliceHelpers";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";
import type { VectorByWallsSettings, VectorByCorridorsSettings } from "../store/storeTypes";

// `DEFAULT_VECTOR_BY_WALLS_SETTINGS`/`DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS` are themselves already
// produced via `applyVectorBy*SharedStyle` (GitHub issue #322) — every dependent field starts
// exactly equal to its shared value, so these fixtures are a valid "nothing overridden" baseline,
// except `VectorByWallsSettings`' own `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`
// (GitHub issue #347 follow-up), which start pre-overridden in every group by design — see
// `VERTICAL_PRE_OVERRIDDEN`.
function wallsSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, ...overrides };
}

function corridorsSettings(overrides: Partial<VectorByCorridorsSettings> = {}): VectorByCorridorsSettings {
  return { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, ...overrides };
}

describe("applyVectorByWallsSharedStyle", () => {
  it("propagates a new cornerStyle to every non-overridden dependent field, mapping sharp/round to miter/round", () => {
    const settings = wallsSettings({ sharedStyle: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle, cornerStyle: "sharp" } });
    const next = applyVectorByWallsSharedStyle(settings, ["cornerStyle"]);
    expect(next.wallJoin).toBe("miter");
    expect(next.oneWayJoin).toBe("miter");
    expect(next.startMarker.cornerStyle).toBe("sharp");
    expect(next.finishMarker.cornerStyle).toBe("sharp");
    expect(next.teleportLineCornerStyle).toBe("sharp");
  });

  it("skips a field marked overridden, leaving its own value untouched", () => {
    const settings = wallsSettings({
      wallJoin: "miter",
      sharedStyle: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle,
        cornerStyle: "round",
        overrides: { cornerStyle: { wallJoin: true } },
      },
    });
    const next = applyVectorByWallsSharedStyle(settings, ["cornerStyle"]);
    expect(next.wallJoin).toBe("miter"); // untouched — overridden
    expect(next.oneWayJoin).toBe("round"); // still follows shared
  });

  it("only touches fields in the requested groups, leaving other groups' fields alone", () => {
    const settings = wallsSettings({
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, size: 0.5, borderWidth: 7 },
      sharedStyle: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle, markerSize: 0.2, markerBorderWidth: 9 },
    });
    const next = applyVectorByWallsSharedStyle(settings, ["markerSize"]);
    expect(next.startMarker.size).toBe(0.2); // markerSize group applied
    expect(next.startMarker.borderWidth).toBe(7); // markerBorderWidth group not requested — untouched
  });

  it("propagates gapWidth to startMarker/finishMarker/teleportEdge/teleportConnector", () => {
    const settings = wallsSettings({ sharedStyle: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle, gapWidth: 6 } });
    const next = applyVectorByWallsSharedStyle(settings, ["gapWidth"]);
    expect(next.startMarker.gapWidth).toBe(6);
    expect(next.finishMarker.gapWidth).toBe(6);
    expect(next.teleportEdgeGapWidth).toBe(6);
    expect(next.teleportConnectorGapWidth).toBe(6);
  });

  it("propagates gapWidth to markerIndex.gap, and skips it when overridden", () => {
    const followed = applyVectorByWallsSharedStyle(
      wallsSettings({ sharedStyle: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle, gapWidth: 6 } }),
      ["gapWidth"],
    );
    expect(followed.markerIndex.gap).toBe(6);

    const overridden = applyVectorByWallsSharedStyle(
      wallsSettings({
        markerIndex: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex, gap: 2 },
        sharedStyle: {
          ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle,
          gapWidth: 6,
          overrides: { gapWidth: { markerIndex: true } },
        },
      }),
      ["gapWidth"],
    );
    expect(overridden.markerIndex.gap).toBe(2);
  });
});

describe("applyVectorByCorridorsSharedStyle", () => {
  it("propagates cornerStyle to join/oneWayJoin (not wallJoin — corridors has no wall join)", () => {
    const settings = corridorsSettings({ sharedStyle: { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.sharedStyle, cornerStyle: "sharp" } });
    const next = applyVectorByCorridorsSharedStyle(settings, ["cornerStyle"]);
    expect(next.join).toBe("miter");
    expect(next.oneWayJoin).toBe("miter");
  });

  it("propagates gapWidth to splitGapWidth, corridors' own extra gapWidth-group field", () => {
    const settings = corridorsSettings({ sharedStyle: { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.sharedStyle, gapWidth: 8 } });
    const next = applyVectorByCorridorsSharedStyle(settings, ["gapWidth"]);
    expect(next.splitGapWidth).toBe(8);
  });

  it("skips splitGapWidth when overridden", () => {
    const settings = corridorsSettings({
      splitGapWidth: 2,
      sharedStyle: {
        ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.sharedStyle,
        gapWidth: 8,
        overrides: { gapWidth: { split: true } },
      },
    });
    const next = applyVectorByCorridorsSharedStyle(settings, ["gapWidth"]);
    expect(next.splitGapWidth).toBe(2);
  });
});

describe("forceVectorByWallsSharedStyle / forceVectorByCorridorsSharedStyle", () => {
  it("clears every override and re-applies every group's shared value to every dependent field", () => {
    const settings = wallsSettings({
      wallJoin: "miter",
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, size: 0.9, borderWidth: 5 },
      sharedStyle: {
        cornerStyle: "round",
        markerSize: 0.16,
        markerBorderWidth: 3,
        gapWidth: 3,
        overrides: { cornerStyle: { wallJoin: true }, markerSize: { startMarker: true }, markerBorderWidth: { startMarker: true } },
      },
    });
    const next = forceVectorByWallsSharedStyle(settings);
    expect(next.sharedStyle.overrides).toEqual({});
    expect(next.wallJoin).toBe("round");
    expect(next.startMarker.size).toBe(0.16);
    expect(next.startMarker.borderWidth).toBe(3);
  });

  it("corridors variant clears every override the same way", () => {
    const settings = corridorsSettings({
      join: "miter",
      sharedStyle: { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.sharedStyle, cornerStyle: "round", overrides: { cornerStyle: { join: true } } },
    });
    const next = forceVectorByCorridorsSharedStyle(settings);
    expect(next.sharedStyle.overrides).toEqual({});
    expect(next.join).toBe("round");
  });
});

const VERTICAL_PRE_OVERRIDDEN = {
  cornerStyle: { twoWayPassage: true, oneWayPassage: true, elevator: true, elevatorBadges: true },
  markerSize: { twoWayPassage: true, oneWayPassage: true, elevator: true },
  markerBorderWidth: { twoWayPassage: true, oneWayPassage: true, elevator: true },
  gapWidth: { twoWayPassage: true, oneWayPassage: true, elevator: true },
};

describe("reconcileVectorByWallsSharedStyle", () => {
  it("marks nothing overridden beyond the vertical markers' own always-overridden defaults when every other dependent field already matches the shared values", () => {
    // `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker` intentionally default to
    // `GenerationRenderer`'s own fixed look (not the shared style), so
    // `DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle.overrides`
    // already pins them overridden — reconcile is expected to leave that as-is here.
    const next = reconcileVectorByWallsSharedStyle(wallsSettings());
    expect(next.sharedStyle.overrides).toEqual(VERTICAL_PRE_OVERRIDDEN);
  });

  it("marks a dependent field overridden when its loaded value disagrees with the shared value — the loadProject/pre-#322-file case", () => {
    // Simulates a project file saved before "Shared style" existed: sharedStyle defaults to
    // round/0.16/3/3 (nothing in the file to say otherwise) but startMarker.size was saved as 0.4
    // by the pre-#322 per-field-only settings. Without reconciliation this field would silently
    // snap to 0.16 the next time the user touches the shared "Marker size" slider.
    const settings = wallsSettings({ startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, size: 0.4 } });
    const next = reconcileVectorByWallsSharedStyle(settings);
    expect(next.sharedStyle.overrides.markerSize?.startMarker).toBe(true);
    expect(next.startMarker.size).toBe(0.4); // value itself untouched
  });

  it("does not re-mark a field already recorded as overridden (idempotent)", () => {
    const settings = wallsSettings({
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, size: 0.4 },
      sharedStyle: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle, overrides: { markerSize: { startMarker: true } } },
    });
    const next = reconcileVectorByWallsSharedStyle(settings);
    // The vertical markers' own `size` still mismatches the shared style here too (its default
    // doesn't follow it, unlike `cornerStyle`/`gapWidth`, which happen to match the shared
    // default's own round/3 values) — reconcile marks that on top of the caller's own `markerSize`.
    // `borderWidth` (GitHub issue #347 sixth/seventh follow-up: all three vertical passage
    // markers' own default raised 2 -> 3) now matches the shared style's own default `3` for
    // `twoWayPassage`/`oneWayPassage`/`elevator`, so no `markerBorderWidth` mismatch remains.
    expect(next.sharedStyle.overrides).toEqual({
      markerSize: { startMarker: true, twoWayPassage: true, oneWayPassage: true, elevator: true },
    });
  });

  it("detects a wallJoin/oneWayJoin mismatch via the sharp/round <-> miter/round mapping", () => {
    const settings = wallsSettings({ wallJoin: "miter" }); // shared cornerStyle stays "round"
    const next = reconcileVectorByWallsSharedStyle(settings);
    expect(next.sharedStyle.overrides.cornerStyle?.wallJoin).toBe(true);
    expect(next.sharedStyle.overrides.cornerStyle?.oneWayJoin).toBeUndefined();
  });

  it("detects mismatches across all four groups independently in one pass", () => {
    const settings = wallsSettings({
      teleportLineCornerStyle: "sharp",
      teleportLineSize: 0.9,
      teleportEdgeBorderWidth: 9,
      teleportConnectorGapWidth: 9,
    });
    const next = reconcileVectorByWallsSharedStyle(settings);
    expect(next.sharedStyle.overrides.cornerStyle?.teleportLine).toBe(true);
    expect(next.sharedStyle.overrides.markerSize?.teleportLine).toBe(true);
    expect(next.sharedStyle.overrides.markerBorderWidth?.teleportEdge).toBe(true);
    expect(next.sharedStyle.overrides.gapWidth?.teleportConnector).toBe(true);
  });

  it("detects startMarker/finishMarker mismatches independently for cornerStyle/size/borderWidth/gapWidth", () => {
    const settings = wallsSettings({
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, cornerStyle: "sharp", borderWidth: 9, gapWidth: 9 },
      finishMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.finishMarker, cornerStyle: "sharp", borderWidth: 9, gapWidth: 9 },
    });
    const next = reconcileVectorByWallsSharedStyle(settings);
    expect(next.sharedStyle.overrides.cornerStyle?.startMarker).toBe(true);
    expect(next.sharedStyle.overrides.cornerStyle?.finishMarker).toBe(true);
    expect(next.sharedStyle.overrides.markerBorderWidth?.startMarker).toBe(true);
    expect(next.sharedStyle.overrides.markerBorderWidth?.finishMarker).toBe(true);
    expect(next.sharedStyle.overrides.gapWidth?.startMarker).toBe(true);
    expect(next.sharedStyle.overrides.gapWidth?.finishMarker).toBe(true);
  });

  it("detects a markerIndex.gap mismatch against the shared gapWidth", () => {
    const settings = wallsSettings({ markerIndex: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.markerIndex, gap: 9 } });
    const next = reconcileVectorByWallsSharedStyle(settings);
    expect(next.sharedStyle.overrides.gapWidth?.markerIndex).toBe(true);
    expect(next.markerIndex.gap).toBe(9);
  });

});

describe("reconcileVectorByCorridorsSharedStyle", () => {
  it("marks nothing overridden beyond the vertical markers' own always-overridden defaults when every other dependent field already matches the shared values", () => {
    // Same rationale as `reconcileVectorByWallsSharedStyle`'s own analogous test above —
    // `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker` default to the fixed
    // `DEFAULT_VERTICAL_STYLE` look, not the shared style, so `DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.
    // sharedStyle.overrides` already pins them overridden.
    const next = reconcileVectorByCorridorsSharedStyle(corridorsSettings());
    expect(next.sharedStyle.overrides).toEqual(VERTICAL_PRE_OVERRIDDEN);
  });

  it("detects a splitGapWidth mismatch — corridors' own extra gapWidth-group field", () => {
    const settings = corridorsSettings({ splitGapWidth: 9 });
    const next = reconcileVectorByCorridorsSharedStyle(settings);
    expect(next.sharedStyle.overrides.gapWidth?.split).toBe(true);
  });

  it("detects a join mismatch via the sharp/round <-> miter/round mapping (join, not wallJoin)", () => {
    const settings = corridorsSettings({ join: "miter" });
    const next = reconcileVectorByCorridorsSharedStyle(settings);
    expect(next.sharedStyle.overrides.cornerStyle?.join).toBe(true);
  });
});

describe("withOverride / withoutOverride", () => {
  // Uses an empty-overrides base (not `DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle.overrides`,
  // which starts with the vertical markers' own always-overridden `cornerStyle` group pre-populated
  // — see `VERTICAL_PRE_OVERRIDDEN`) so these assertions only exercise `startMarker`/`finishMarker`.
  const emptyOverrides: typeof DEFAULT_VECTOR_BY_WALLS_SETTINGS.sharedStyle.overrides = {};

  it("withOverride marks a field true without disturbing other fields in the same group", () => {
    const overrides = withOverride(emptyOverrides, "cornerStyle", "startMarker");
    const overrides2 = withOverride(overrides, "cornerStyle", "finishMarker");
    expect(overrides2.cornerStyle).toEqual({ startMarker: true, finishMarker: true });
  });

  it("withoutOverride clears one field, leaving sibling fields in the same group intact", () => {
    const overrides = withOverride(
      withOverride(emptyOverrides, "cornerStyle", "startMarker"),
      "cornerStyle",
      "finishMarker",
    );
    const cleared = withoutOverride(overrides, "cornerStyle", "startMarker");
    expect(cleared.cornerStyle).toEqual({ finishMarker: true });
  });

  it("withoutOverride on a field that was never set is a no-op", () => {
    const cleared = withoutOverride(emptyOverrides, "cornerStyle", "startMarker");
    expect(cleared.cornerStyle).toEqual({});
  });
});
