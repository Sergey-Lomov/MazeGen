import type { ParamDescriptor, ParamLink } from "../parameterLinks";

/** Reads `settings[path]`, where `path` may be a dot-path into one sub-object (e.g.
 *  `"startMarker.cornerStyle"`) — the only nesting depth any current registry path uses. Works with
 *  `P` as a plain string at runtime; type safety comes from the caller's per-mode `ParamPath`
 *  union. */
export function getParamValue<P extends string>(settings: object, path: P): unknown {
  const dot = path.indexOf(".");
  const rec = settings as Record<string, unknown>;
  if (dot === -1) return rec[path];
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  return (rec[head] as Record<string, unknown> | undefined)?.[tail];
}

/** Returns a new settings object with `settings[path]` set to `value`, same dot-path convention as
 *  `getParamValue`. Never mutates `settings`. */
export function setParamValue<P extends string, S extends object>(settings: S, path: P, value: unknown): S {
  const dot = path.indexOf(".");
  const rec = settings as Record<string, unknown>;
  if (dot === -1) return { ...settings, [path]: value };
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  return { ...settings, [head]: { ...(rec[head] as Record<string, unknown>), [tail]: value } };
}

/** Atomic, all-or-nothing check over the whole `links` list — accepts it entirely or throws
 *  describing every violation found, never silently drops a conflicting link (that would make the
 *  result depend on array order). Checks: every `source`/`target` exists in `registry`; source and
 *  target share the same `ParamType`; no two links share a `target` (at-most-one-incoming-link
 *  invariant); the `source -> target` graph is acyclic. In #643 this runs only over the
 *  `DEFAULT_*_LINKS` constants (a dev-time/test consistency guard) — persisted/user `links` are out
 *  of scope for #643, so there is no loaded-data path to validate yet. */
export function validateLinkGraph<P extends string>(links: ParamLink<P>[], registry: Record<string, ParamDescriptor>): void {
  const errors: string[] = [];

  for (const link of links) {
    const source = registry[link.source];
    const target = registry[link.target];
    if (!source) errors.push(`link "${link.id}": unknown source "${link.source}"`);
    if (!target) errors.push(`link "${link.id}": unknown target "${link.target}"`);
    if (source && target && source.type !== target.type) {
      errors.push(`link "${link.id}": type mismatch (${link.source}: ${source.type} vs ${link.target}: ${target.type})`);
    }
  }

  const targetCounts = new Map<string, number>();
  for (const link of links) targetCounts.set(link.target, (targetCounts.get(link.target) ?? 0) + 1);
  for (const [target, count] of targetCounts) {
    if (count > 1) errors.push(`target "${target}" has ${count} incoming links, at most 1 allowed`);
  }

  const adjacency = new Map<string, string[]>();
  for (const link of links) adjacency.set(link.source, [...(adjacency.get(link.source) ?? []), link.target]);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (node: string): void => {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) errors.push(`cycle detected involving "${next}"`);
      else if (c === WHITE) visit(next);
    }
    color.set(node, BLACK);
  };
  for (const link of links) {
    if ((color.get(link.source) ?? WHITE) === WHITE) visit(link.source);
  }

  if (errors.length > 0) throw new Error(`Invalid param link graph:\n${errors.join("\n")}`);
}

/** BFS propagation of `changedPaths` through `links`' enabled edges — for each path popped from the
 *  queue, every enabled link whose `source` is that path copies the value into `target` and enqueues
 *  `target` next, so a chain A->B->C reacts to a change at A transitively through B. The graph is
 *  guaranteed acyclic by `validateLinkGraph` over `DEFAULT_*_LINKS`, but the traversal still tracks
 *  visited paths as a safety net rather than relying on that alone. */
export function propagate<P extends string, S extends object>(settings: S, links: ParamLink<P>[], changedPaths: P[]): S {
  const bySource = new Map<P, ParamLink<P>[]>();
  for (const link of links) bySource.set(link.source, [...(bySource.get(link.source) ?? []), link]);

  let next = settings;
  const queue = [...changedPaths];
  const visited = new Set<P>(changedPaths);
  while (queue.length > 0) {
    const path = queue.shift() as P;
    for (const link of bySource.get(path) ?? []) {
      if (!link.enabled) continue;
      if (visited.has(link.target)) continue;
      next = setParamValue(next, link.target, getParamValue(next, path));
      visited.add(link.target);
      queue.push(link.target);
    }
  }
  return next;
}

/** "Force shared style" — enables every link, then propagates from every root source (a source that
 *  is not itself some other enabled link's target) in one call. Only roots are fed as `changedPaths`:
 *  `propagate` seeds its visited-set from `changedPaths` up front, so seeding a non-root (e.g. `b` in
 *  a chain `a -> b -> c`) would mark it visited before the `a -> b` edge runs and block that edge
 *  from overwriting `b`'s stale value — `c` would then inherit the stale value instead of `a`'s. */
export function forceLinks<P extends string, S extends object>(settings: S, links: ParamLink<P>[]): { settings: S; links: ParamLink<P>[] } {
  const enabled = links.map((l) => ({ ...l, enabled: true }));
  const targets = new Set(enabled.map((l) => l.target));
  const roots = enabled.map((l) => l.source).filter((source) => !targets.has(source));
  const nextSettings = propagate(settings, enabled, roots);
  return { settings: nextSettings, links: enabled };
}

/** Pure per-link classification, not propagation: for each link independently, compares the current
 *  (already-in-`settings`, no recompute) `target`/`source` values via `registry[target].equals`, and
 *  marks it `enabled: false` on mismatch. Each link only reads what's already in `settings` — no
 *  link rewrites values — so list order never affects the result (unlike `propagate`, which is a
 *  graph traversal; this is not). */
export function reconcileLinks<P extends string>(settings: object, links: ParamLink<P>[], registry: Record<string, ParamDescriptor>): ParamLink<P>[] {
  return links.map((link) => {
    const equals = registry[link.target].equals;
    const matches = equals(getParamValue(settings, link.target), getParamValue(settings, link.source));
    return matches ? link : { ...link, enabled: false };
  });
}

/** Addresses a link by its `target` (not `id` — a field's own setter always knows its own field
 *  path, never the id of whatever link points at it); lookup is unambiguous thanks to the
 *  at-most-one-incoming-link invariant (`validateLinkGraph`). No-op if no link targets `target` (the
 *  field isn't linkable). Re-enabling (`enabled: true`) immediately re-propagates from that link's
 *  `source` so the field starts following it again (mirrors the old per-field reset button);
 *  disabling does not re-propagate — the value is already whatever the caller just wrote. */
export function setLinkEnabledByTarget<P extends string, S extends object>(
  settings: S,
  links: ParamLink<P>[],
  target: P,
  enabled: boolean,
): { settings: S; links: ParamLink<P>[] } {
  const link = links.find((l) => l.target === target);
  if (!link) return { settings, links };
  const nextLinks = links.map((l) => (l === link ? { ...l, enabled } : l));
  const nextSettings = enabled ? propagate(settings, nextLinks, [link.source]) : settings;
  return { settings: nextSettings, links: nextLinks };
}
