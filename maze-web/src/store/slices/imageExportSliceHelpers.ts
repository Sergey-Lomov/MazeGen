import type {
  VectorByWallsSettings,
  VectorByCorridorsSettings,
  VectorByWallsSharedStyle,
  VectorByCorridorsSharedStyle,
  VectorByWallsSharedStyleOverrides,
  VectorByCorridorsSharedStyleOverrides,
  SharedStyleField,
} from "../storeTypes";
import type { TeleportCornerStyle } from "../../pixi/renderers/types";

/** `"sharp"` maps to the `"round" | "miter"` join enum's `"miter"`, `"round"` to its own `"round"` —
 *  the two enums mean the same visual intent despite different value spellings (GitHub issue #322,
 *  see `VectorByWallsSharedStyle`'s own doc comment). */
function cornerStyleToJoin(style: TeleportCornerStyle): "round" | "miter" {
  return style === "sharp" ? "miter" : "round";
}

/** Fields every "Shared style" group touches identically in both render modes (`startMarker`/
 *  `finishMarker`/every `teleportLine*`/`teleportEdge*`/`teleportConnector*` field) — factored out
 *  of `applyVectorByWallsSharedStyle`/`applyVectorByCorridorsSharedStyle` since only the two modes'
 *  own extra fields differ (`wallJoin` vs. `join`, and corridors' own `splitGapWidth`). Mutates
 *  `next` (a working copy already spread off `settings` by the caller) in place field-by-field
 *  rather than returning a new object per group, so the two callers can layer their own extra-field
 *  writes into the same `next` without re-spreading it. */
function applySharedCommonFields<
  S extends { startMarker: VectorByWallsSettings["startMarker"]; finishMarker: VectorByWallsSettings["finishMarker"] } & TeleportSharedFields,
>(next: S, shared: VectorByWallsSharedStyle | VectorByCorridorsSharedStyle, groups: SharedStyleGroupName[]): S {
  const overrides = shared.overrides;

  if (groups.includes("cornerStyle")) {
    const o = overrides.cornerStyle;
    next = {
      ...next,
      startMarker: o?.startMarker ? next.startMarker : { ...next.startMarker, cornerStyle: shared.cornerStyle },
      finishMarker: o?.finishMarker ? next.finishMarker : { ...next.finishMarker, cornerStyle: shared.cornerStyle },
      teleportLineCornerStyle: o?.teleportLine ? next.teleportLineCornerStyle : shared.cornerStyle,
    };
  }
  if (groups.includes("markerSize")) {
    const o = overrides.markerSize;
    next = {
      ...next,
      startMarker: o?.startMarker ? next.startMarker : { ...next.startMarker, size: shared.markerSize },
      finishMarker: o?.finishMarker ? next.finishMarker : { ...next.finishMarker, size: shared.markerSize },
      teleportLineSize: o?.teleportLine ? next.teleportLineSize : shared.markerSize,
    };
  }
  if (groups.includes("markerBorderWidth")) {
    const o = overrides.markerBorderWidth;
    next = {
      ...next,
      startMarker: o?.startMarker ? next.startMarker : { ...next.startMarker, borderWidth: shared.markerBorderWidth },
      finishMarker: o?.finishMarker ? next.finishMarker : { ...next.finishMarker, borderWidth: shared.markerBorderWidth },
      teleportEdgeBorderWidth: o?.teleportEdge ? next.teleportEdgeBorderWidth : shared.markerBorderWidth,
    };
  }
  if (groups.includes("gapWidth")) {
    const o = overrides.gapWidth;
    next = {
      ...next,
      startMarker: o?.startMarker ? next.startMarker : { ...next.startMarker, gapWidth: shared.gapWidth },
      finishMarker: o?.finishMarker ? next.finishMarker : { ...next.finishMarker, gapWidth: shared.gapWidth },
      teleportEdgeGapWidth: o?.teleportEdge ? next.teleportEdgeGapWidth : shared.gapWidth,
      teleportConnectorGapWidth: o?.teleportConnector ? next.teleportConnectorGapWidth : shared.gapWidth,
    };
  }
  return next;
}

type SharedStyleGroupName = "cornerStyle" | "markerSize" | "markerBorderWidth" | "gapWidth";
type TeleportSharedFields = {
  teleportLineCornerStyle: VectorByWallsSettings["teleportLineCornerStyle"];
  teleportLineSize: number;
  teleportEdgeBorderWidth: number;
  teleportEdgeGapWidth: number;
  teleportConnectorGapWidth: number;
};

/** Applies `settings.sharedStyle`'s current values to every dependent field not marked as
 *  overridden in `sharedStyle.overrides` — used both after a shared-value change (only that one
 *  group's fields) and by "Force shared style" (every group, after clearing all overrides first).
 *  Delegates the fields common to both modes to `applySharedCommonFields`, then layers this mode's
 *  own extra `cornerStyle`-group field (`wallJoin`) on top. */
export function applyVectorByWallsSharedStyle(
  settings: VectorByWallsSettings,
  groups: (keyof VectorByWallsSharedStyleOverrides)[],
): VectorByWallsSettings {
  const shared = settings.sharedStyle;
  let next = applySharedCommonFields(settings, shared, groups);
  if (groups.includes("cornerStyle")) {
    const join = cornerStyleToJoin(shared.cornerStyle);
    next = {
      ...next,
      wallJoin: shared.overrides.cornerStyle?.wallJoin ? next.wallJoin : join,
      oneWayJoin: shared.overrides.cornerStyle?.oneWayJoin ? next.oneWayJoin : join,
    };
  }
  return next;
}

/** Same role as `applyVectorByWallsSharedStyle`, for "Vector by corridors" — see that function's
 *  own doc comment. Layers `join` (not `wallJoin` — corridors has no wall) and `splitGapWidth`
 *  (corridors' own extra `gapWidth`-group field) on top of the common fields. */
export function applyVectorByCorridorsSharedStyle(
  settings: VectorByCorridorsSettings,
  groups: (keyof VectorByCorridorsSharedStyleOverrides)[],
): VectorByCorridorsSettings {
  const shared = settings.sharedStyle;
  let next = applySharedCommonFields(settings, shared, groups);
  if (groups.includes("cornerStyle")) {
    const join = cornerStyleToJoin(shared.cornerStyle);
    next = {
      ...next,
      join: shared.overrides.cornerStyle?.join ? next.join : join,
      oneWayJoin: shared.overrides.cornerStyle?.oneWayJoin ? next.oneWayJoin : join,
    };
  }
  if (groups.includes("gapWidth")) {
    next = { ...next, splitGapWidth: shared.overrides.gapWidth?.split ? next.splitGapWidth : shared.gapWidth };
  }
  return next;
}

const ALL_WALLS_GROUPS: (keyof VectorByWallsSharedStyleOverrides)[] = ["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"];
const ALL_CORRIDORS_GROUPS: (keyof VectorByCorridorsSharedStyleOverrides)[] = ["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"];

/** "Force shared style" — clears every override then re-applies every group's shared value to
 *  every dependent field. */
export function forceVectorByWallsSharedStyle(settings: VectorByWallsSettings): VectorByWallsSettings {
  const cleared: VectorByWallsSharedStyle = { ...settings.sharedStyle, overrides: {} };
  return applyVectorByWallsSharedStyle({ ...settings, sharedStyle: cleared }, ALL_WALLS_GROUPS);
}

/** Same role as `forceVectorByWallsSharedStyle`, for "Vector by corridors". */
export function forceVectorByCorridorsSharedStyle(settings: VectorByCorridorsSettings): VectorByCorridorsSettings {
  const cleared: VectorByCorridorsSharedStyle = { ...settings.sharedStyle, overrides: {} };
  return applyVectorByCorridorsSharedStyle({ ...settings, sharedStyle: cleared }, ALL_CORRIDORS_GROUPS);
}

/** The fields `reconcileVectorByWallsSharedStyle`/`reconcileVectorByCorridorsSharedStyle` check
 *  identically in both modes — same "which fields does every group touch" set as
 *  `applySharedCommonFields`, minus each mode's own extra field (`wallJoin`/`join`,
 *  `splitGapWidth`), which the two callers check on top of this. Mutates and returns `overrides`
 *  rather than a full settings object, since both callers still need to fold their own extra-field
 *  checks into the same `overrides` value before rebuilding `settings`. */
function reconcileSharedCommonFields<O extends SharedStyleOverrides>(
  settings: TeleportSharedFields & { startMarker: VectorByWallsSettings["startMarker"]; finishMarker: VectorByWallsSettings["finishMarker"] },
  shared: { cornerStyle: TeleportCornerStyle; markerSize: number; markerBorderWidth: number; gapWidth: number },
  overrides: O,
): O {
  // Local wrapper so the 13 checks below read as plain `group`/`field` pairs — `O` is abstract
  // here (this helper serves both modes' differently-shaped `overrides`), so TS can't itself prove
  // e.g. `"cornerStyle"` is one of `O`'s keys; the cast is hand-verified once, here, instead of
  // repeated at each call site.
  const mark = (group: keyof SharedStyleOverrides, field: string) => {
    overrides = withOverride(overrides, group as keyof O, field as SharedStyleField<O, keyof O>);
  };
  if (settings.startMarker.cornerStyle !== shared.cornerStyle) mark("cornerStyle", "startMarker");
  if (settings.finishMarker.cornerStyle !== shared.cornerStyle) mark("cornerStyle", "finishMarker");
  if (settings.teleportLineCornerStyle !== shared.cornerStyle) mark("cornerStyle", "teleportLine");
  if (settings.startMarker.size !== shared.markerSize) mark("markerSize", "startMarker");
  if (settings.finishMarker.size !== shared.markerSize) mark("markerSize", "finishMarker");
  if (settings.teleportLineSize !== shared.markerSize) mark("markerSize", "teleportLine");
  if (settings.startMarker.borderWidth !== shared.markerBorderWidth) mark("markerBorderWidth", "startMarker");
  if (settings.finishMarker.borderWidth !== shared.markerBorderWidth) mark("markerBorderWidth", "finishMarker");
  if (settings.teleportEdgeBorderWidth !== shared.markerBorderWidth) mark("markerBorderWidth", "teleportEdge");
  if (settings.startMarker.gapWidth !== shared.gapWidth) mark("gapWidth", "startMarker");
  if (settings.finishMarker.gapWidth !== shared.gapWidth) mark("gapWidth", "finishMarker");
  if (settings.teleportEdgeGapWidth !== shared.gapWidth) mark("gapWidth", "teleportEdge");
  if (settings.teleportConnectorGapWidth !== shared.gapWidth) mark("gapWidth", "teleportConnector");
  return overrides;
}

/** After loading a project file, a dependent field's actual value and `sharedStyle`'s own value can
 *  disagree with no override recorded — either an old file saved before "Shared style" existed
 *  (GitHub issue #322), or a hand-edited file. Left as-is, that field reads correctly right after
 *  load (its own value shows) but silently snaps to the shared value the next time *any* field in
 *  its group changes, since nothing marked it overridden. Called once right after validation
 *  assembles the full settings object, this marks every dependent field whose current value
 *  doesn't match its group's shared value as overridden — never touches the field's own value,
 *  only which fields the four shared values are allowed to still drive. */
export function reconcileVectorByWallsSharedStyle(settings: VectorByWallsSettings): VectorByWallsSettings {
  const shared = settings.sharedStyle;
  let overrides = reconcileSharedCommonFields(settings, shared, shared.overrides);
  const join = cornerStyleToJoin(shared.cornerStyle);
  if (settings.wallJoin !== join) overrides = withOverride(overrides, "cornerStyle", "wallJoin");
  if (settings.oneWayJoin !== join) overrides = withOverride(overrides, "cornerStyle", "oneWayJoin");
  return { ...settings, sharedStyle: { ...shared, overrides } };
}

/** Same role as `reconcileVectorByWallsSharedStyle`, for "Vector by corridors" (also covers
 *  `splitGapWidth`, that mode's own extra `gapWidth`-group field). */
export function reconcileVectorByCorridorsSharedStyle(settings: VectorByCorridorsSettings): VectorByCorridorsSettings {
  const shared = settings.sharedStyle;
  let overrides = reconcileSharedCommonFields(settings, shared, shared.overrides);
  const join = cornerStyleToJoin(shared.cornerStyle);
  if (settings.join !== join) overrides = withOverride(overrides, "cornerStyle", "join");
  if (settings.oneWayJoin !== join) overrides = withOverride(overrides, "cornerStyle", "oneWayJoin");
  if (settings.splitGapWidth !== shared.gapWidth) overrides = withOverride(overrides, "gapWidth", "split");
  return { ...settings, sharedStyle: { ...shared, overrides } };
}

type SharedStyleOverrides = VectorByWallsSharedStyleOverrides | VectorByCorridorsSharedStyleOverrides;

/** Marks one dependent field of one shared-style group as overridden — called by that field's own
 *  per-mode setter (e.g. `setVectorByWallsStartMarkerSize`) before writing the user's value, so it
 *  stops following the shared value until reset. Generic over the two modes' differently-shaped
 *  `overrides` records (both are `Partial<Record<string, Partial<Record<string, true>>>>`-shaped) —
 *  cast through `Record<string, ...>` since neither declares an index signature of its own. */
export function withOverride<O extends SharedStyleOverrides, G extends keyof O>(overrides: O, group: G, field: SharedStyleField<O, G>): O {
  const rec = overrides as Record<string, Record<string, true> | undefined>;
  const key = group as string;
  return { ...rec, [key]: { ...rec[key], [field]: true } } as unknown as O;
}

/** Clears one dependent field's override flag — the settings panel's own per-field reset button,
 *  before re-applying that group's shared value to the now-unoverridden field. */
export function withoutOverride<O extends SharedStyleOverrides, G extends keyof O>(overrides: O, group: G, field: SharedStyleField<O, G>): O {
  const rec = overrides as Record<string, Record<string, true> | undefined>;
  const key = group as string;
  const groupOverrides = { ...rec[key] };
  delete groupOverrides[field];
  return { ...rec, [key]: groupOverrides } as unknown as O;
}
