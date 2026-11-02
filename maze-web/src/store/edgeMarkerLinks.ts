import type { EdgeMarkerOverride, EdgeMarkerRole, EdgeMarkerStyle, FloorEdgeMarkerStyle } from "./imageExportTypes";
import type { ParamLink } from "./parameterLinks";
import { applyLinkChain } from "./slices/parameterLinksEngine";

/** Marker-scoped parameter links (GitHub issue #902), the model of `teleportGroupLinks.ts`. A marker's shape and colour
 *  inherit the incoming link of the matching shared parameter (`edgeMarkers.shape` / `edgeMarkers.color`), rebound to the
 *  marker's own parameters; nothing is copied into the links list, since marker keys come from the geometry.
 *
 *  Value priority per marker role: explicit override -> link-derived value -> shared value. A role in `linkBroken` skips the
 *  link-derived step. */

export const EDGE_MARKER_ROLES: readonly EdgeMarkerRole[] = ["color", "shape"];

const ROLE_PATH: Record<EdgeMarkerRole, string> = { color: "edgeMarkers.color", shape: "edgeMarkers.shape" };
const PATH_ROLE: Record<string, EdgeMarkerRole> = { "edgeMarkers.color": "color", "edgeMarkers.shape": "shape" };

/** Virtual path of a marker's own `role` parameter, used only to display marker links (`buildEdgeMarkerLinks`), never stored. */
export function markerRolePath(role: EdgeMarkerRole): string {
  return `marker.${role}`;
}

/** The enabled link driving the shared parameter of `role`, if any. */
function sharedRoleLink(links: ParamLink<string>[], role: EdgeMarkerRole): ParamLink<string> | null {
  return links.find((l) => l.target === ROLE_PATH[role] && l.enabled) ?? null;
}

/** True if `role` of a marker follows its inherited source: neither broken nor overridden for this marker. */
export function isMarkerRoleLinked(override: EdgeMarkerOverride | undefined, role: EdgeMarkerRole): boolean {
  return override?.linkBroken?.[role] !== true && override?.[role] === undefined;
}

/** The links one marker effectively follows, for display: the shared parameters' incoming links with every source that is
 *  itself a marker role rebound to `markerRolePath`; a role whose shared parameter has no such link follows the shared
 *  parameter itself. `enabled` is false for a role whose link is broken or overridden for this marker. */
export function buildEdgeMarkerLinks(links: ParamLink<string>[], override: EdgeMarkerOverride | undefined): ParamLink<string>[] {
  return EDGE_MARKER_ROLES.map((role) => {
    const link = sharedRoleLink(links, role);
    const enabled = isMarkerRoleLinked(override, role);
    if (link === null) return { id: `marker-${role}`, source: ROLE_PATH[role], target: markerRolePath(role), enabled };
    const sourceRole = PATH_ROLE[link.source];
    return { ...link, source: sourceRole === undefined ? link.source : markerRolePath(sourceRole), target: markerRolePath(role), enabled };
  });
}

type RoleValue = number | EdgeMarkerStyle["shape"];

const NO_OVERRIDES: Record<string, EdgeMarkerOverride> = Object.freeze({});

function resolveRole(role: EdgeMarkerRole, style: EdgeMarkerStyle, links: ParamLink<string>[], override: EdgeMarkerOverride | undefined, depth: number): RoleValue {
  const explicit = override?.[role];
  if (explicit !== undefined) return explicit;
  const shared = style[role];
  if (depth > EDGE_MARKER_ROLES.length || override?.linkBroken?.[role] === true) return shared;
  const link = sharedRoleLink(links, role);
  if (link === null) return shared;
  const sourceRole = PATH_ROLE[link.source];
  if (sourceRole === undefined) return shared;
  return applyLinkChain(link, resolveRole(sourceRole, style, links, override, depth + 1)) as RoleValue;
}

/** The overrides with every one replaced by the effective one (explicit, else link-derived, else unset = shared). */
function resolveOverrides(style: EdgeMarkerStyle, links: ParamLink<string>[], overrides: Record<string, EdgeMarkerOverride>): Record<string, EdgeMarkerOverride> {
  const resolved: Record<string, EdgeMarkerOverride> = {};
  for (const [key, override] of Object.entries(overrides)) {
    const out: EdgeMarkerOverride = {};
    for (const role of EDGE_MARKER_ROLES) {
      const value = resolveRole(role, style, links, override, 0);
      if (override[role] !== undefined || value !== style[role]) (out as Record<string, RoleValue>)[role] = value;
    }
    resolved[key] = out;
  }
  return resolved;
}

/** The style as `floorId` sees it, its overrides replaced by what each marker actually draws: what the export, the overlay
 *  and the warnings read. */
export function withResolvedEdgeMarkers(style: EdgeMarkerStyle, links: ParamLink<string>[], floorId: string): FloorEdgeMarkerStyle {
  const overrides = style.overrides[floorId];
  if (!overrides) return { ...style, overrides: NO_OVERRIDES };
  return { ...style, overrides: resolveOverrides(style, links, overrides) };
}

/** The same resolution for every floor, keeping the per-floor shape (the project colour fields read all floors). */
export function withResolvedEdgeMarkerFloors(style: EdgeMarkerStyle, links: ParamLink<string>[]): EdgeMarkerStyle {
  const floors = Object.keys(style.overrides);
  if (floors.length === 0) return style;
  return { ...style, overrides: Object.fromEntries(floors.map((floorId) => [floorId, resolveOverrides(style, links, style.overrides[floorId])])) };
}

/** Merges `patch` into a marker's stored override. A role set to a value becomes explicit and breaks its link for this
 *  marker; a role present but `undefined` is cleared and its link restored. Returns `null` when nothing is left. */
export function mergeEdgeMarkerOverridePatch(prev: EdgeMarkerOverride | undefined, patch: EdgeMarkerOverride): EdgeMarkerOverride | null {
  const { linkBroken: patchBroken, ...patchFields } = patch;
  const { linkBroken: prevBroken, ...prevFields } = prev ?? {};
  const out: EdgeMarkerOverride = { ...prevFields, ...patchFields };
  const broken: Partial<Record<EdgeMarkerRole, boolean>> = { ...prevBroken };
  for (const role of EDGE_MARKER_ROLES) {
    if (!(role in patchFields)) continue;
    if (patchFields[role] !== undefined) broken[role] = true;
    else {
      delete out[role];
      delete broken[role];
    }
  }
  for (const [role, flag] of Object.entries(patchBroken ?? {})) {
    if (flag) broken[role as EdgeMarkerRole] = true;
    else delete broken[role as EdgeMarkerRole];
  }
  if (Object.keys(broken).length > 0) out.linkBroken = broken;
  return Object.keys(out).length > 0 ? out : null;
}
