import type { MazeStore } from "./storeTypes";
import type { ExportOverrideMode, ExportOverrideValue, ZoneOverrideTarget } from "./zonesTypes";
import { exportOverrideOf, isExportOverridable, linkEnabledPath, withExportOverrideParams, withZoneParams } from "./exportZoneOverrides";
import type { ParamLink } from "./parameterLinks";
import { getParamValue } from "./slices/parameterLinksEngine";

type WallsSettings = MazeStore["vectorByWallsSettings"];
type CorridorsSettings = MazeStore["vectorByCorridorsSettings"];
type Update = Partial<MazeStore>;

/** The store key of the settings each zone aware render mode edits. */
const SETTINGS_KEY = { walls: "vectorByWallsSettings", corridors: "vectorByCorridorsSettings" } as const;

/** The render mode whose settings the zone context edits: the open panel's, walls while none is chosen yet. */
export function activeZoneMode(s: Pick<MazeStore, "activeRenderMode">): ExportOverrideMode {
  return s.activeRenderMode === "vector_by_corridors" ? "corridors" : "walls";
}

const settingsOf = (s: MazeStore, mode: ExportOverrideMode): WallsSettings | CorridorsSettings => s[SETTINGS_KEY[mode]];

/** The zone or group whose settings the "Vector by walls" panel shows and edits (GitHub issue #1040), or `null` while it
 *  works on the global settings. Switched off together with the zone context switch of the Settings section. */
export function activeExportContext(s: Pick<MazeStore, "showZoneOverrideButtons" | "exportOverrideContext">): ZoneOverrideTarget | null {
  return s.showZoneOverrideButtons ? s.exportOverrideContext : null;
}

/** The global walls settings with the zone's own parameters on top (only those the image draws) and their links followed. */
export function settingsInContext<S extends { links: ParamLink[] }>(settings: S, overrides: MazeStore["exportZoneOverrides"], target: ZoneOverrideTarget, mode: ExportOverrideMode = "walls"): S {
  const override = exportOverrideOf(overrides, mode, target);
  const params = Object.fromEntries(Object.entries(override?.params ?? {}).filter(([path]) => isExportOverridable(mode, path, settings.links)));
  return withZoneParams(settings, params);
}

/** The settings the panel works with: the global ones, or the zone context's own on top of them. */
export function effectiveWallsSettings(s: MazeStore): WallsSettings {
  const target = activeExportContext(s);
  return target === null ? s.vectorByWallsSettings : settingsInContext(s.vectorByWallsSettings, s.exportZoneOverrides, target, "walls");
}

/** `effectiveWallsSettings` for the corridors mode. */
export function effectiveCorridorsSettings(s: MazeStore): CorridorsSettings {
  const target = activeExportContext(s);
  return target === null ? s.vectorByCorridorsSettings : settingsInContext(s.vectorByCorridorsSettings, s.exportZoneOverrides, target, "corridors");
}

const effectiveSettings = (s: MazeStore, mode: ExportOverrideMode): WallsSettings | CorridorsSettings => (mode === "walls" ? effectiveWallsSettings(s) : effectiveCorridorsSettings(s));

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Paths of the leaves that differ between two settings objects; an array or a keyed record that differs is one leaf. */
function changedLeaves(before: unknown, after: unknown, path: string, out: string[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) changedLeaves(before[key], after[key], path === "" ? key : `${path}.${key}`, out);
    return;
  }
  if (Object.is(before, after)) return;
  if (typeof before === "object" && typeof after === "object" && JSON.stringify(before) === JSON.stringify(after)) return;
  out.push(path);
}

const isOverrideValue = (v: unknown): v is ExportOverrideValue => typeof v === "number" || typeof v === "boolean" || typeof v === "string";

/** An update that a settings action built for the zone context's settings, turned into changes of that zone's override:
 *  what the edit changed and a link did not carry over, set as the zone's own values. A value equal to the global one
 *  stays an override until the user resets it (a slider dragged across the global value must not lose it). Changes the image does not draw, and the links themselves, are dropped. */
function zoneChanges(mode: ExportOverrideMode, effective: { links: ParamLink[] }, next: { links: ParamLink[] }): Record<string, ExportOverrideValue | null> {
  const changed: string[] = [];
  changedLeaves(effective, next, "", changed);
  const changedSet = new Set(changed);
  const changes: Record<string, ExportOverrideValue | null> = {};
  for (const path of changed) {
    if (path === "links" || path.startsWith("links.")) continue;
    if (!isExportOverridable(mode, path, effective.links)) continue;
    const value = getParamValue(next, path);
    if (!isOverrideValue(value)) continue;
    // A link into the path that is still on and follows a changed source made this change: it is not the user's own.
    if (next.links.some((link) => link.enabled && link.target === path && changedSet.has(link.source))) continue;
    changes[path] = value;
  }
  return changes;
}

/** The changes of the zone context's override that turn the link driving `linkTarget` on or off for the zone. A state equal to
 *  the global one takes the zone's flag out. Turning on also drops the target's own value so it follows its source; turning
 *  off keeps the value the target shows now, as a global edit of a linked field does. */
export function zoneLinkToggleChanges(s: MazeStore, linkTarget: string, enabled: boolean, mode: ExportOverrideMode = "walls"): Record<string, ExportOverrideValue | null> {
  const global = settingsOf(s, mode);
  const globalLink = global.links.find((link) => link.target === linkTarget);
  if (globalLink === undefined) return {};
  const changes: Record<string, ExportOverrideValue | null> = { [linkEnabledPath(linkTarget)]: enabled === globalLink.enabled ? null : enabled };
  if (enabled) {
    changes[linkTarget] = null;
  } else {
    const shown = getParamValue(effectiveSettings(s, mode), linkTarget);
    const inherited = getParamValue(global, linkTarget);
    if (isOverrideValue(shown) && !Object.is(shown, inherited)) changes[linkTarget] = shown;
  }
  return changes;
}

/** Builds a store update; while a zone is the panel's context, a change to the walls settings goes to that zone's override
 *  instead of the global settings. The action is built against the zone's effective settings, so it reads and links the
 *  values the panel shows. */
export function redirectZoneEdit(s: MazeStore, build: (s: MazeStore) => Update): Update {
  const target = activeExportContext(s);
  const mode = activeZoneMode(s);
  if (target === null) return build(s);
  const key = SETTINGS_KEY[mode];
  const effective = effectiveSettings(s, mode);
  const built = build({ ...s, [key]: effective }) as Record<string, unknown>;
  const { [key]: next, ...rest } = built;
  if (next === undefined) return rest as Update;
  const changes = zoneChanges(mode, effective, next as { links: ParamLink[] });
  return Object.keys(changes).length === 0 ? (rest as Update) : { ...(rest as Update), ...withExportOverrideParams(s, mode, target, changes) };
}

/** `set` of a store slice that edits the walls settings, made zone aware. */
export function zoneAwareSet<U extends Update>(set: (partial: Update | ((s: MazeStore) => Update)) => void): (partial: U | ((s: MazeStore) => U)) => void {
  return (partial) => set((s) => redirectZoneEdit(s, typeof partial === "function" ? partial : () => partial));
}
