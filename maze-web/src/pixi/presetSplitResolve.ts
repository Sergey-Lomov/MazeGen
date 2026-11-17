import { rotateFaceIndex } from "./tessellationGeometry";
import { faceIndexTo, faceNeighborCells, resolveFaceNeighbors } from "./faceNeighbors";
import type { FieldConfig } from "../fieldConfig";
import { presetEndpoint, presetEndpointsEqual, presetEndpointKey, type PresetEndpoint } from "./presetEndpoint";
import { type SplitFaceKind, canCompleteOppositePair, isFinishedSplitPair, detectSplitSpecialShapeKind } from "./splitFaceLayout";
import { splitShapeBinding } from "./splitShape";
import { selectByTiering, type PairState } from "./postEditEndpoint";
import { refusedRotation, type SplitRotationResult } from "./splitRotationResult";
import type { PresetConnectionEntry } from "./fieldEditUtils";

/** Resolves which node of `point` on `level` a preset edge-tool click currently targets — the
 * preset-stage counterpart of post-edit's `resolveActiveEndpointAt` (GitHub issue #231).
 * `activeMap[key]` if set, else the point's original node on `level`
 * (`presetEndpoint(point, undefined, level)`, no slot). `activeMap` is keyed by
 * `"x,y"`/`"x,y@level"` (GitHub issue #340, same convention `splitPointsCore.ts`'s `pointKey`
 * uses) — a point's declared split slots and which one is active are independent per floor. */
export function resolvePresetActiveEndpoint(
  point: [number, number],
  activeMap: Record<string, PresetEndpoint>,
  level?: number,
): PresetEndpoint {
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const active = activeMap[key];
  return active ?? presetEndpoint(point, undefined, level);
}

/** Resolves which node of a split `neighborPoint` genuinely connects across the face toward
 * `point` — used when wiring a face automatically (blueprint apply), where the correct partner is
 * whichever of the neighbor's nodes already has a decided (`passage`/`wall`/one-way) entry toward
 * any of `point`'s pre-blueprint nodes (`pointOldEndpoints` — `point` is about to be rebuilt by
 * its own blueprint too, so its *old* identity, not the fresh endpoint the caller is about to
 * write, is what any pre-existing neighbor entry was recorded against), not whichever node happens
 * to be the neighbor's currently active UI slot (GitHub issue #243 — picking "the" active node
 * here silently wired a connection to the wrong node while leaving the neighbor's real connecting
 * node's entry orphaned). Falls back to the active-slot resolution when no such decided entry
 * exists yet (neighbor not split, or this exact face not yet decided on any of its nodes) — mirrors
 * `buildSplitPassagesCore`'s `resolveOther`. */
export function resolvePresetPartnerAt(
  pointOldEndpoints: PresetEndpoint[],
  neighborPoint: [number, number],
  presetConnections: Map<string, PresetConnectionEntry>,
  presetSplitPoints: Record<string, number[]>,
  activeMap: Record<string, PresetEndpoint>,
  level?: number,
): PresetEndpoint {
  const candidates = allNodesAt(neighborPoint, presetSplitPoints, level).map((ep) => ({ forms: [ep], identity: ep }));
  const classifyPair = (target: PresetEndpoint, form: PresetEndpoint): PairState => {
    const entry = presetConnections.get(presetEdgeKey(form, target));
    if (!entry || entry.state === "undefined") return "none";
    if (entry.state === "wall") return "wall";
    return "decided";
  };
  const result = selectByTiering(candidates, pointOldEndpoints, classifyPair);
  return result?.identity ?? resolvePresetActiveEndpoint(neighborPoint, activeMap, level);
}

/** The `presetSplitPoints`/`presetActiveSplitNode` record key for `point`/`level` — `"x,y"` for
 * floor 0 (both `undefined` and `0` normalize to the unsuffixed key), `"x,y@level"` otherwise.
 * The one place this format is built, so every caller (`allNodesAt`, `resolvePresetSplitTargets`,
 * `presetSplitLabels.ts`'s `isPresetSplitPoint`) stays in sync with it. */
export function presetSplitPointKey(point: [number, number], level?: number): string {
  return level === undefined || level === 0 ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

/** Every node currently declared at `point` on `level` (original plus every declared slot, per
 * `presetSplitPoints`) — used both by `resolvePresetPartnerAt` (the neighbor's full candidate set)
 * and by `applyPresetSplitBlueprint` (to explicitly wall off every neighbor node the blueprint's
 * resolved partner didn't pick, so a face doesn't silently leave one of the neighbor's other nodes
 * undecided — GitHub issue #243 follow-up). */
export function allNodesAt(point: [number, number], presetSplitPoints: Record<string, number[]>, level?: number): PresetEndpoint[] {
  const slots = presetSplitPoints[presetSplitPointKey(point, level)] ?? [];
  return [presetEndpoint(point, undefined, level), ...slots.map((slotId) => presetEndpoint(point, slotId, level))];
}

/** GitHub issue #594 (parity with post-edit's `resolveDragTargets`, GitHub issue #567): resolves
 * every target of a preset vertical-passage/elevator placement OR drag against `presetSplitPoints`,
 * in `targets` order. A point with no declared slots resolves silently to its original node (`slotId:
 * undefined`), same as before this issue — its endpoint lands straight in `picks`. A point with one
 * or more declared slots needs the user to pick via `PresetSplitTargetDialog`, so it's left
 * `undefined` in `picks` and instead queued (`queue`, carrying its own `targetIndex` so
 * `applyPresetSplitTargetPick` can slot the eventual pick back into the right position once the
 * dialog resolves it). `queue` empty means every target was plain — the caller then has every
 * endpoint already in `picks` and should commit directly, no dialog. */
export function resolvePresetSplitTargets(
  targets: { point: [number, number]; level?: number }[],
  presetSplitPoints: Record<string, number[]>,
): { picks: (PresetEndpoint | undefined)[]; queue: { targetIndex: number; point: [number, number]; level?: number; slotIds: number[] }[] } {
  const picks: (PresetEndpoint | undefined)[] = [];
  const queue: { targetIndex: number; point: [number, number]; level?: number; slotIds: number[] }[] = [];
  targets.forEach((t, targetIndex) => {
    const slotIds = presetSplitPoints[presetSplitPointKey(t.point, t.level)] ?? [];
    if (slotIds.length > 0) {
      picks.push(undefined);
      queue.push({ targetIndex, point: t.point, level: t.level, slotIds });
    } else {
      picks.push(presetEndpoint(t.point, undefined, t.level));
    }
  });
  return { picks, queue };
}

/** One preset split node's kind on every one of its point's geometric faces (in `getNeighborData`
 * offset order) — a face with no in-field neighbor is `"wall"`, an undecided in-field face is
 * `"undefined"`. The neighbor's partner node is resolved per `resolvePresetPartnerAt` (its real
 * connecting node, not just its active UI slot — GitHub issue #243). Shared by
 * `PresetSplitNodesDialog`'s tile diagram and the `PresetSplitTargetDialog` / status-panel
 * special-split recognition (GitHub issue #487), so all agree on what a point's topology is. */
export function presetSplitNodeFaceKinds(
  endpoint: PresetEndpoint,
  point: [number, number],
  cfg: FieldConfig,
  inFieldCells: Set<string>,
  presetConnections: Map<string, PresetConnectionEntry>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  level?: number,
): SplitFaceKind[] {
  return resolveFaceNeighbors(cfg, point, inFieldCells).map((neighbor): SplitFaceKind => {
    if (neighbor === null) return "wall";
    const neighborPartner = resolvePresetPartnerAt(
      [endpoint], neighbor, presetConnections, presetSplitPoints, presetActiveSplitNode, level,
    );
    const entry = presetConnections.get(presetEdgeKey(endpoint, neighborPartner));
    if (!entry) return "undefined";
    if (entry.state === "wall") return "wall";
    if (entry.state === "passage") return "passage";
    if (entry.state === "undefined") return "undefined";
    // entry.from/.to are canonical-order (see presetEdgeKey) — actual direction is
    // entry.from -> entry.to for "one_way_forward", reversed for "one_way_backward".
    const endpointIsFrom = presetEndpointsEqual(entry.from, endpoint);
    const forward = entry.state === "one_way_forward";
    return endpointIsFrom === forward ? "one_way_out" : "one_way_in";
  });
}

/** Orders two preset endpoints `[from, to]` by the same canonical rule `presetEdgeKey` uses for
 * its own key ordering (lower `level`, then lower `x`, then lower `y` — GitHub issue #340 added
 * the `level` tiebreak ahead of the pre-existing point comparison) — exported so callers that need
 * to build a `PresetConnectionEntry` (which stores `from`/`to` in this same canonical order, see
 * `applyTool`/`applyPresetSplitBlueprint`) don't have to re-derive the comparison themselves. A
 * same-floor pair (the overwhelming majority — every entry until cross-floor edges exist) never
 * consults `level` at all, so this is byte-identical to the pre-#340 point-only ordering there. */
export function canonicalizePresetPair(a: PresetEndpoint, b: PresetEndpoint): [PresetEndpoint, PresetEndpoint] {
  const al = a.level ?? 0, bl = b.level ?? 0;
  if (al !== bl) return al < bl ? [a, b] : [b, a];
  return a.point[0] < b.point[0] || (a.point[0] === b.point[0] && a.point[1] < b.point[1]) ? [a, b] : [b, a];
}

/** Preset-side edge key, slot- and level-aware (GitHub issue #231/#340): for two endpoints with no
 * active slot and floor-0 level on either side, identical to `edgeKey`'s plain geometric key —
 * every existing preset entry (and the default-edge-state mechanism, which only ever targets
 * original nodes on the active floor) keeps its exact key. A slot-addressed or non-floor-0
 * endpoint on either side changes the key, so a split-targeted or other-floor preset never
 * collides with the point's plain (original-node, floor-0) preset. */
export function presetEdgeKey(a: PresetEndpoint, b: PresetEndpoint): string {
  const [fa, fb] = canonicalizePresetPair(a, b);
  return `${presetEndpointKey(fa)}-${presetEndpointKey(fb)}`;
}

/** Which of `candidatePoint`'s own geometric face indices (per `getNeighborData`'s fixed offset
 * order) already carry a **decided** connection (`passage`/`one_way_forward`/`one_way_backward`),
 * checked against any of the candidate's own forms — mirrors post-edit's own `decidedFaceIndicesOf`
 * (`postEditUtils.ts`). A `wall`/`undefined` entry does not count (see `canCompleteOppositePair`'s
 * own doc comment — only a real decided connection forms a bridge pair). */
export function presetDecidedFaceIndicesOf(
  candidatePoint: [number, number],
  candidateForms: PresetEndpoint[],
  presetConnections: Map<string, PresetConnectionEntry>,
  cfg: FieldConfig,
  presetSplitPoints: Record<string, number[]>,
): Set<number> {
  const neighbors = faceNeighborCells(cfg, candidatePoint);
  const result = new Set<number>();
  for (const form of candidateForms) {
    neighbors.forEach((neighbor, i) => {
      // Check against EVERY one of the neighbor's declared nodes (original + slots), not just its
      // original — a face's real partner across the shared edge is just as often one of the
      // neighbor's split slots (e.g. two adjacent bridge tiles), and checking only the original
      // silently missed that decided face entirely (GitHub issue #580 preset second-rotation
      // follow-up: after a first rotation re-stitches a bridge pair through both sides' slots, a
      // second rotation's geometry/safety checks read this same face as "not decided" and mis-owns
      // it back onto the neighbor's original node).
      const neighborForms = allNodesAt(neighbor, presetSplitPoints, form.level);
      const decided = neighborForms.some((nf) => {
        const entry = presetConnections.get(presetEdgeKey(form, nf));
        return entry && (entry.state === "passage" || entry.state === "one_way_forward" || entry.state === "one_way_backward");
      });
      if (decided) result.add(i);
    });
  }
  return result;
}

/** The candidate at `neighborPoint` that already has a DECIDED connection on exactly `targetFace`
 * (toward `point`), if any — mirrors post-edit's `selectExistingFaceOwner` (`postEditUtils.ts`). The
 * common case for two adjacent split points wired to each other (e.g. two neighboring "bridge"
 * tiles): rotating one moves a DIFFERENT one of its own nodes onto the face that already connects to
 * the other tile's node — the two nodes were already partners on this shared face before the
 * rotation, and remain so after, just via the rotated point's other node. Must be checked before
 * `canCompleteOppositePair`'s geometry guess: the existing partner's own `presetDecidedFaceIndicesOf`
 * already contains `targetFace`, so the geometry guard's "target face not already decided" check
 * would otherwise wrongly exclude it as "already occupied" — it isn't occupied by a THIRD party, it's
 * occupied by the very connection this rotation is re-keying. */
export function selectExistingPresetFaceOwner(
  candidates: PresetEndpoint[],
  neighborPoint: [number, number],
  targetFace: number,
  presetConnections: Map<string, PresetConnectionEntry>,
  cfg: FieldConfig,
  presetSplitPoints: Record<string, number[]>,
): PresetEndpoint | null {
  const matches = candidates.filter((c) => presetDecidedFaceIndicesOf(neighborPoint, [c], presetConnections, cfg, presetSplitPoints).has(targetFace));
  return matches.length === 1 ? matches[0] : null;
}

/** Resolves which node of a (possibly split) `newNeighbor` a preset rotate's brand-new face should
 * connect to — the preset counterpart of post-edit's `resolveFaceOwner` (`postEditUtils.ts`), same
 * priority order: an already-standing decided connection on exactly this face
 * (`selectExistingPresetFaceOwner`) first, then geometry evidence (`canCompleteOppositePair`, does
 * this candidate's OWN other decided faces complete a bridge/diagonal pair with the new face), then
 * the neighbor's active UI slot or original node, restricted to candidates that do NOT already hold a
 * finished opposite pair (`isFinishedSplitPair` — a 0/1-decided-face candidate, or the only
 * node of a plain point, is always safe to extend). `assignedThisRotation` guards the geometry tier against the same neighbor node being
 * claimed by two different new faces within one multi-move rotation, same as the post-edit side.
 *
 * Returns `null` when EVERY candidate at `newNeighbor` already holds a finished pair (e.g. rotating
 * a bridge tile onto a neighbor that's itself fully wired on both its own nodes) — there is no safe
 * node to hand the new face to, and picking "the least bad" one would still corrupt it, so the
 * caller leaves this face disconnected (wall) rather than guess. */
export function resolvePresetFaceOwner(
  point: [number, number],
  newNeighbor: [number, number],
  cfg: FieldConfig,
  presetConnections: Map<string, PresetConnectionEntry>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  assignedThisRotation: Map<string, number>,
  level: number | undefined,
): PresetEndpoint | null {
  const candidates = allNodesAt(newNeighbor, presetSplitPoints, level);
  const degree = faceNeighborCells(cfg, newNeighbor).length;
  const targetFace = faceIndexTo(cfg, newNeighbor, point);

  if (targetFace !== -1) {
    const existing = selectExistingPresetFaceOwner(candidates, newNeighbor, targetFace, presetConnections, cfg, presetSplitPoints);
    if (existing) return existing;

    const matches = candidates.filter((c) => canCompleteOppositePair(presetDecidedFaceIndicesOf(newNeighbor, [c], presetConnections, cfg, presetSplitPoints), targetFace, degree));
    if (matches.length === 1) {
      const owner = matches[0];
      const ownerKey = presetEndpointKey(owner);
      if (assignedThisRotation.get(ownerKey) === undefined) {
        assignedThisRotation.set(ownerKey, targetFace);
        return owner;
      }
    }
  }

  const safeCandidates = candidates.filter((c) => !isFinishedSplitPair(presetDecidedFaceIndicesOf(newNeighbor, [c], presetConnections, cfg, presetSplitPoints), degree, candidates.length));
  if (safeCandidates.length === 0) return null;

  const active = resolvePresetActiveEndpoint(newNeighbor, presetActiveSplitNode, level);
  const activeIsSafe = safeCandidates.some((c) => presetEndpointsEqual(c, active));
  if (activeIsSafe) return active;
  const activeMatchesUnsafe = candidates.some((c) => presetEndpointsEqual(c, active));
  return activeMatchesUnsafe ? safeCandidates[0] : active;
}

/** Rotates every geometric-face connection of a split point's nodes by one offset index
 * (clockwise/counter-clockwise, per `getNeighborData`'s fixed offset order) — a face's whole
 * state (wall/passage/one_way + direction) moves from its current neighbor to the next one around
 * the point, for every node of the point (original + every declared slot) at once. Teleports are
 * untouched — a teleport isn't tied to a geometric face/offset, only ordinary connections are.
 *
 * The OLD neighbor side of the lookup searches every one of the old neighbor's own declared nodes
 * (not just its original), preferring a decided (`passage`/one-way) entry over a `wall` one — same
 * tiering `resolvePresetPartnerAt` uses — so a connection to one of the old neighbor's SPLIT nodes
 * isn't silently missed (GitHub issue #580's preset-side counterpart). The NEW neighbor side is
 * resolved via `resolvePresetFaceOwner` (geometry evidence, then a bridge-safety-aware fallback),
 * not simply the new neighbor's original node.
 *
 * Refuses with `refusalReason: "outside_field"` if any face that currently carries a connection
 * would land on a neighbor outside the field — there'd be nowhere left to draw it. */
export function rotatePresetSplitPoint(
  presetConnections: Map<string, PresetConnectionEntry>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  level?: number,
): SplitRotationResult<Map<string, PresetConnectionEntry>> {
  const faceNeighbors = faceNeighborCells(cfg, point);
  const n = faceNeighbors.length;
  if (n === 0) return presetConnections;

  const endpoints: PresetEndpoint[] = [presetEndpoint(point, undefined, level), ...slotIds.map((slotId) => presetEndpoint(point, slotId, level))];

  type Move = { key: string; ep: PresetEndpoint; oldNeighborNode: PresetEndpoint; newNeighbor: [number, number]; entry: PresetConnectionEntry };
  const moves: Move[] = [];

  for (const ep of endpoints) {
    for (let i = 0; i < n; i++) {
      const neighbor = faceNeighbors[i];
      const oldNeighborCandidates = allNodesAt(neighbor, presetSplitPoints, level).map((c) => ({ forms: [c], identity: c }));
      const classifyPair = (target: PresetEndpoint, form: PresetEndpoint): PairState => {
        const e = presetConnections.get(presetEdgeKey(form, target));
        if (!e || e.state === "undefined") return "none";
        return e.state === "wall" ? "wall" : "decided";
      };
      const found = selectByTiering(oldNeighborCandidates, [ep], classifyPair);
      if (!found) continue;
      const oldNeighborNode = found.identity;
      const key = presetEdgeKey(ep, oldNeighborNode);
      const entry = presetConnections.get(key)!;

      const j = rotateFaceIndex(cfg, point[0], point[1], i, direction);
      const newNeighbor = faceNeighbors[j];
      if (!cellSet.has(`${newNeighbor[0]},${newNeighbor[1]}`)) {
        return refusedRotation(new Map(presetConnections), "outside_field");
      }

      moves.push({ key, ep, oldNeighborNode, newNeighbor, entry });
    }
  }

  const next = new Map(presetConnections);
  for (const { key } of moves) next.delete(key);

  // A `neighborEp` resolved via `selectExistingPresetFaceOwner` may already have a standing entry
  // toward ANY of `point`'s own forms (not necessarily the specific `ep` this move re-keys), since
  // the two points were already partners on this shared face before the rotation. Resolve every
  // move's owner and drop those standing entries FIRST, in one pass, before any rotated entry is
  // written — doing the delete inside the same loop that writes would wipe out an earlier move's
  // freshly-written entry whenever two moves resolve to the same owner (mirrors post-edit's
  // `rotateSplitPointNodes` fix for the same bug).
  const assignedThisRotation = new Map<string, number>();
  const resolvedOwners = moves.map((m) => resolvePresetFaceOwner(point, m.newNeighbor, cfg, presetConnections, presetSplitPoints, presetActiveSplitNode, assignedThisRotation, level));
  for (const neighborEp of resolvedOwners) {
    if (!neighborEp) continue;
    for (const ep of endpoints) next.delete(presetEdgeKey(neighborEp, ep));
  }

  // An old neighbor node that ISN'T picked up as `ep`'s new-face owner this rotation loses its
  // partner on the face that used to point at `point`. When that old neighbor is itself split (has
  // more than one declared node at its point), leaving the face merely absent from the map reads as
  // "undefined"/optional in the UI and silently turns one of its OTHER, unrelated decided faces into
  // part of an incomplete/broken bridge shape — so this must become an explicit wall instead. A
  // plain (non-split) old neighbor has nothing else to protect, so it keeps the old "just vanish"
  // behavior (structurally identical for a single-node point, and covered by existing tests). This
  // checks the exact (ep, oldNeighborNode) pair, not just whether oldNeighborNode is claimed by
  // SOME move — the same physical neighbor node can simultaneously lose one of point's nodes as its
  // old partner and gain a DIFFERENT one of point's nodes as its new partner within one rotation.
  const rewrittenPairKeys = new Set(moves.map(({ ep }, i) => resolvedOwners[i] && presetEdgeKey(ep, resolvedOwners[i]!)).filter((k): k is string => k !== null));
  for (const { ep, oldNeighborNode, entry } of moves) {
    if (rewrittenPairKeys.has(presetEdgeKey(ep, oldNeighborNode))) continue;
    if (allNodesAt(oldNeighborNode.point, presetSplitPoints, oldNeighborNode.level).length < 2) continue;
    const epIsLower = ep.point[0] < oldNeighborNode.point[0] || (ep.point[0] === oldNeighborNode.point[0] && ep.point[1] < oldNeighborNode.point[1]);
    const [wallFrom, wallTo] = epIsLower ? [ep, oldNeighborNode] : [oldNeighborNode, ep];
    next.set(presetEdgeKey(ep, oldNeighborNode), { from: wallFrom, to: wallTo, state: "wall", source: entry.source });
  }

  moves.forEach(({ ep, newNeighbor, entry }, i) => {
    const neighborEp = resolvedOwners[i];
    if (!neighborEp) return; // no safe node to hand this face to — leave it disconnected (wall)
    const newKey = presetEdgeKey(ep, neighborEp);
    const epIsLower = ep.point[0] < newNeighbor[0] || (ep.point[0] === newNeighbor[0] && ep.point[1] < newNeighbor[1]);
    const [newFrom, newTo] = epIsLower ? [ep, neighborEp] : [neighborEp, ep];

    // Direction is stored relative to canonical from/to, not to `ep` — re-derive it relative to
    // `ep` first (which side of the *old* entry it was, against the OLD neighbor node the
    // connection was actually found on), then rebuild against the *new* canonical order, so a
    // one-way passage keeps pointing the same way relative to `ep` even if canonical order flips
    // between the old and new neighbor.
    let state = entry.state;
    if (entry.state === "one_way_forward" || entry.state === "one_way_backward") {
      const epWasFrom = presetEndpointsEqual(entry.from, ep);
      const outOfEp = epWasFrom === (entry.state === "one_way_forward");
      const epIsNewFrom = presetEndpointsEqual(newFrom, ep);
      state = (epIsNewFrom === outOfEp) ? "one_way_forward" : "one_way_backward";
    }
    next.set(newKey, { from: newFrom, to: newTo, state, source: entry.source });
  });
  return next;
}

/** True if rotating `point`'s split nodes by `direction` would make a currently-recognized special
 * shape (bridge/diagonal/etc., `detectSplitSpecialShapeKind`) at one of `point`'s geometric
 * neighbors unrecognized (GitHub issue #588) — dry-runs the rotation (`rotatePresetSplitPoint` is
 * pure) and compares each split neighbor's own `faceKindsByNode` before/after via
 * `presetSplitNodeFaceKinds`. Only `point`'s immediate geometric neighbors can possibly be
 * affected — a rotation only ever re-keys entries touching `point`'s own nodes. A neighbor that
 * isn't itself split (fewer than 2 declared nodes), or wasn't recognized before the rotation, is
 * never a "break" regardless of what happens to it after. Mirrors post-edit's
 * `rotateSplitPointBreaksNeighborShape` (`postEditUtils.ts`). */
export function rotatePresetSplitPointBreaksNeighborShape(
  presetConnections: Map<string, PresetConnectionEntry>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  presetSplitPoints: Record<string, number[]>,
  presetActiveSplitNode: Record<string, PresetEndpoint>,
  level?: number,
): boolean {
  const after = rotatePresetSplitPoint(
    presetConnections, point, slotIds, direction, cfg, cellSet, presetSplitPoints, presetActiveSplitNode, level,
  );
  if (after.refusalReason) return false; // refused — nothing changes

  for (const neighbor of faceNeighborCells(cfg, point)) {
    const neighborEndpoints = allNodesAt(neighbor, presetSplitPoints, level);
    if (neighborEndpoints.length < 2) continue; // not split — nothing to break
    const neighborBinding = splitShapeBinding(cfg, neighbor[0], neighbor[1]);

    const before = neighborEndpoints.map((ep) => presetSplitNodeFaceKinds(
      ep, neighbor, cfg, cellSet, presetConnections, presetSplitPoints, presetActiveSplitNode, level,
    ));
    if (detectSplitSpecialShapeKind(before, neighborBinding) === null) continue; // wasn't recognized before — nothing to break

    const afterKinds = neighborEndpoints.map((ep) => presetSplitNodeFaceKinds(
      ep, neighbor, cfg, cellSet, after, presetSplitPoints, presetActiveSplitNode, level,
    ));
    if (detectSplitSpecialShapeKind(afterKinds, neighborBinding) === null) return true;
  }
  return false;
}
