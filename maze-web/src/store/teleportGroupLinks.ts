import type { TeleportGroupOverride, TeleportGroupRole } from "../pixi/renderers/types";
import type { MarkerSettings } from "./storeTypes";
import type { ParamLink } from "./parameterLinks";
import { applyLinkChain } from "./slices/parameterLinksEngine";

/** Group-scoped parameter links (GitHub issue #729). A teleport group's shape / fill / border inherit
 *  the incoming link of the matching common marker parameter, rebound to the group's own parameters:
 *  when the link's source is itself a per-group parameter (e.g. common border ← common fill, −15 L),
 *  the group's border follows the *group's* fill. Nothing is copied into the links list — group keys
 *  are unstable, so the links are resolved here at read time from the common marker's links.
 *
 *  Value priority per group role: explicit override → link-derived value → common value. A role in
 *  `linkBroken` skips the link-derived step. Renderers and the settings panel both go through
 *  `resolveGroupOverrides` so they resolve identically. */

export const TELEPORT_GROUP_ROLES: readonly TeleportGroupRole[] = ["fillColor", "borderColor", "shape"];

const ROLE_PATH: Record<TeleportGroupRole, string> = {
  fillColor: "teleportMarker.fillColor",
  borderColor: "teleportMarker.borderColor",
  shape: "teleportMarker.shape",
};
const PATH_ROLE: Record<string, TeleportGroupRole> = {
  "teleportMarker.fillColor": "fillColor",
  "teleportMarker.borderColor": "borderColor",
  "teleportMarker.shape": "shape",
};

/** Virtual path of a group's own `role` parameter, used only to display group links
 *  (`buildGroupLinks`) — never stored. */
export function groupRolePath(role: TeleportGroupRole): string {
  return `group.${role}`;
}

/** The links one group effectively follows, for display: the common marker parameters' incoming links
 *  (disabled ones skipped — a disabled common link is no inheritance at all) with every source that
 *  is itself a group role rebound to `groupRolePath`. A role whose common parameter has no such link
 *  follows the common parameter itself: a plain equality link `teleportMarker.<role> -> group role`.
 *  `enabled` is false for a role whose link is broken or overridden for this group. */
export function buildGroupLinks(links: ParamLink<string>[], override: TeleportGroupOverride | undefined): ParamLink<string>[] {
  const out: ParamLink<string>[] = [];
  for (const role of TELEPORT_GROUP_ROLES) {
    const link = commonRoleLink(links, role);
    const enabled = isGroupRoleLinked(override, role);
    if (link === null) {
      out.push({ id: `group-${role}`, source: ROLE_PATH[role], target: groupRolePath(role), enabled });
      continue;
    }
    const sourceRole = PATH_ROLE[link.source];
    out.push({
      ...link,
      source: sourceRole === undefined ? link.source : groupRolePath(sourceRole),
      target: groupRolePath(role),
      enabled,
    });
  }
  return out;
}

/** What the group resolution reads from a mode's settings. */
export type GroupLinkSettings = {
  teleportMarker: MarkerSettings;
  links: ParamLink<string>[];
  teleportGroupOverrides: Record<string, TeleportGroupOverride>;
};

/** The enabled link driving the common marker parameter of `role`, if any. */
export function commonRoleLink(links: ParamLink<string>[], role: TeleportGroupRole): ParamLink<string> | null {
  return links.find((l) => l.target === ROLE_PATH[role] && l.enabled) ?? null;
}

/** True if `role` of a group currently follows its inherited source — the common marker parameter's
 *  incoming link rebound to the group, or the common parameter itself when it has no link — i.e. the
 *  role is neither broken nor explicitly overridden for this group. */
export function isGroupRoleLinked(override: TeleportGroupOverride | undefined, role: TeleportGroupRole): boolean {
  return override?.linkBroken?.[role] !== true && override?.[role] === undefined;
}

type RoleValue = number | MarkerShape;
type MarkerShape = MarkerSettings["shape"];

function resolveRole(
  role: TeleportGroupRole,
  marker: MarkerSettings,
  links: ParamLink<string>[],
  override: TeleportGroupOverride | undefined,
  depth: number,
): RoleValue {
  const explicit = override?.[role];
  if (explicit !== undefined) return explicit;
  const common = marker[role];
  if (depth > TELEPORT_GROUP_ROLES.length || override?.linkBroken?.[role] === true) return common;
  const link = commonRoleLink(links, role);
  if (link === null) return common;
  const sourceRole = PATH_ROLE[link.source];
  if (sourceRole === undefined) return common;
  return applyLinkChain(link, resolveRole(sourceRole, marker, links, override, depth + 1)) as RoleValue;
}

/** Effective override of one group: every role with an explicit value or a value that differs from
 *  the common marker's. `linkBroken` is dropped (it only steers resolution). */
export function resolveGroupOverride(
  marker: MarkerSettings,
  links: ParamLink<string>[],
  override: TeleportGroupOverride | undefined,
): TeleportGroupOverride {
  const out: TeleportGroupOverride = {};
  for (const role of TELEPORT_GROUP_ROLES) {
    const value = resolveRole(role, marker, links, override, 0);
    if (override?.[role] !== undefined || value !== marker[role]) (out as Record<string, RoleValue>)[role] = value;
  }
  return out;
}

/** `resolveGroupOverride` over every stored group override. Returns `overrides` itself when empty. */
export function resolveGroupOverrides(
  settings: GroupLinkSettings,
): Record<string, TeleportGroupOverride> {
  const { teleportMarker, links, teleportGroupOverrides } = settings;
  const keys = Object.keys(teleportGroupOverrides);
  if (keys.length === 0) return teleportGroupOverrides;
  const out: Record<string, TeleportGroupOverride> = {};
  for (const key of keys) out[key] = resolveGroupOverride(teleportMarker, links, teleportGroupOverrides[key]);
  return out;
}

/** Merges `patch` into a group's stored override. A role set to a value becomes explicit and breaks
 *  its link for this group; a role present but `undefined` is cleared and its link restored. A
 *  `linkBroken` entry in the patch is applied last, key by key (`false` removes the flag). Returns
 *  `null` when nothing is left, so the caller can drop the entry. */
export function mergeGroupOverridePatch(prev: TeleportGroupOverride | undefined, patch: TeleportGroupOverride): TeleportGroupOverride | null {
  const { linkBroken: patchBroken, ...patchFields } = patch;
  const { linkBroken: prevBroken, ...prevFields } = prev ?? {};
  const out: TeleportGroupOverride = { ...prevFields, ...patchFields };
  const broken: Partial<Record<TeleportGroupRole, boolean>> = { ...prevBroken };
  for (const role of TELEPORT_GROUP_ROLES) {
    if (!(role in patchFields)) continue;
    if (patchFields[role] !== undefined) broken[role] = true;
    else {
      delete out[role];
      delete broken[role];
    }
  }
  for (const [role, flag] of Object.entries(patchBroken ?? {})) {
    if (flag) broken[role as TeleportGroupRole] = true;
    else delete broken[role as TeleportGroupRole];
  }
  if (Object.keys(broken).length > 0) out.linkBroken = broken;
  return Object.keys(out).length > 0 ? out : null;
}

/** `settings` with `teleportGroupOverrides` replaced by the resolved (effective) overrides — the
 *  one entry point for consumers that read group colors/shapes (renderers, warnings, picker). */
export function withResolvedGroupOverrides<S extends GroupLinkSettings>(settings: S): S {
  const resolved = resolveGroupOverrides(settings);
  return resolved === settings.teleportGroupOverrides ? settings : { ...settings, teleportGroupOverrides: resolved };
}
