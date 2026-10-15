import type { PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "./fieldEditUtils";
import { getCellCenter, nearestCellCoord } from "./tessellationGeometry";
import { presetEndpointScreenPos } from "./selectors/presetSelectors";
import { withoutLevel, type PresetEndpoint } from "./presetEndpoint";
import type { FieldConfig } from "../fieldConfig";
import type { TeleportEdge, VerticalConnectionMarker } from "./renderers/types";
import { resolveCrossFloorBadgeCells, type CrossFloorBadgePair } from "./selectors/mazeSelectors/teleport";

/** Per-floor cells that draw a *center* marker in the preset editor (GitHub issue #480) — the preset
 *  analogue of `buildTeleportBadgeBlockedCells`, so a cross-floor teleport badge is relocated off any
 *  start/finish, split-junction, vertical-passage/elevator or teleport-endpoint cell the same way it
 *  is in the generation/post-edit views. All inputs are the full maze-wide preset lists (not the
 *  active-floor-filtered ones), keyed by `PresetEndpoint.level ?? 0`. One-way passage markers are
 *  excluded (cell edges, not centers). */
export function buildPresetTeleportBadgeBlockedCells(
  presetStart: PresetEndpoint | null,
  presetFinish: PresetEndpoint | null,
  presetSplitPointsByLevel: Map<number, [number, number][]>,
  verticalPassages: PresetVerticalPassageEntry[],
  elevators: PresetElevatorEntry[],
  teleports: PresetTeleportEntry[],
): Map<number, [number, number][]> {
  const perFloor = new Map<number, Set<string>>();
  const add = (level: number, x: number, y: number) => {
    let set = perFloor.get(level);
    if (!set) { set = new Set(); perFloor.set(level, set); }
    set.add(`${x},${y}`);
  };
  const addEndpoint = (ep: PresetEndpoint) => add(ep.level ?? 0, ep.point[0], ep.point[1]);

  if (presetStart) addEndpoint(presetStart);
  if (presetFinish) addEndpoint(presetFinish);
  for (const [level, cells] of presetSplitPointsByLevel) {
    for (const [x, y] of cells) add(level, x, y);
  }
  for (const p of verticalPassages) { addEndpoint(p.from); addEndpoint(p.to); }
  for (const e of elevators) for (const f of e.floors) addEndpoint(f);
  for (const t of teleports) { addEndpoint(t.from); addEndpoint(t.to); }

  const out = new Map<number, [number, number][]>();
  for (const [level, set] of perFloor) {
    out.set(level, [...set].map((k) => k.split(",").map(Number) as [number, number]));
  }
  return out;
}

/** The one node-anchor map every preset marker/edge selector resolves endpoints against — built
 *  by `buildPresetNodePositions` in the renderer, threaded through each `build*` call here. An
 *  empty map means "no split points", so every endpoint falls back to its plain tile center. */
type PresetNodePositions = Map<string, { x: number; y: number }>;

/** `teleports` is expected already filtered to entries with at least one endpoint on `activeLevel`
 *  (either `t.from` or `t.to`). Mirrors `mazeSelectors.ts`'s own `buildTeleportEdges` cross-floor
 *  handling exactly (GitHub issue #337/#357 follow-up) — a preset teleport must read identically to
 *  a generation-time one: when exactly one endpoint is on-floor, `to` is replaced with the grid-
 *  snapped midpoint between the on-floor cell and the real (off-image) off-floor cell, and `toFloor`
 *  is set so `TeleportRenderer` draws a floor-number badge there instead of an ordinary marker — the
 *  on-floor endpoint itself still draws as a real marker, connected to that badge by an ordinary
 *  connector, exactly like the generation view.
 *
 *  Cross-floor badge collision relocation (GitHub issue #480) matches the generation view too: pass
 *  `allTeleports` (the *unfiltered* maze-wide list) and `blockedCellsByFloor`
 *  (`buildPresetTeleportBadgeBlockedCells`) and every cross-floor badge is moved off any marker cell
 *  or another badge, floor-independently, via the shared `resolveCrossFloorBadgeCells`. Omit both for
 *  the pre-#480 behavior (badge left exactly on its snapped midpoint). `fieldCells` + `allowOutOfField`
 *  are forwarded straight through — the preset editor always passes `allowOutOfField: true`. */
export function buildPresetTeleportEdges(
  teleports: PresetTeleportEntry[],
  cfg: FieldConfig,
  activeLevel: number | undefined,
  nodePositions: PresetNodePositions = new Map(),
  spread?: {
    allTeleports: PresetTeleportEntry[];
    blockedCellsByFloor?: Map<number, [number, number][]>;
    allowOutOfField?: boolean;
    fieldCells?: [number, number][];
  },
): TeleportEdge[] {
  const active = activeLevel ?? 0;
  // `nodePositions` (`buildPresetNodePositions`) keys split-point nodes WITHOUT a `level` suffix —
  // it's built once per active-floor redraw from that floor's own already level-filtered
  // `presetSplitPoints`/`presetConnections` (see `redrawGenSource`'s doc comment in
  // `PresetConnectionsRenderer.ts` for the same convention). `ep` still carries its real `.level`,
  // so strip it before the lookup or a split slot on any non-zero floor silently falls back to the
  // plain cell center instead of its real anchor.
  const endpointPos = (ep: PresetEndpoint) => {
    const [x, y] = presetEndpointScreenPos(withoutLevel(ep), cfg, nodePositions);
    return { x, y };
  };

  const edges: TeleportEdge[] = teleports.map((t): TeleportEdge => {
    // `t.from`/`t.to` are the two click points in placement order — the actual passage direction
    // for "backward" runs the other way (mirrors PresetConnectionState::TeleportBackward on the
    // Rust side, which builds the edge to→from): `fromIsDeparture` says whether `t.from` (not
    // `t.to`) is the filled/departure end.
    const fromIsDeparture = t.direction !== "backward";
    const fromOnActive = (t.from.level ?? 0) === active;
    const toOnActive = (t.to.level ?? 0) === active;
    const oneWay = t.direction !== "two_way";

    if (fromOnActive && toOnActive) {
      const fromPos = endpointPos(t.from);
      const toPos = endpointPos(t.to);
      return fromIsDeparture
        ? { from: [fromPos.x, fromPos.y], to: [toPos.x, toPos.y], oneWay }
        : { from: [toPos.x, toPos.y], to: [fromPos.x, fromPos.y], oneWay };
    }

    // Exactly one of `t.from`/`t.to` is on-floor (the filter above guarantees at least one is; the
    // both-on-floor case is handled above).
    const onFloorEndpoint = fromOnActive ? t.from : t.to;
    const offFloorEndpoint = fromOnActive ? t.to : t.from;
    const onFloorIsDeparture = fromOnActive ? fromIsDeparture : !fromIsDeparture;
    const onPos = endpointPos(onFloorEndpoint);

    const onCenter = getCellCenter(onFloorEndpoint.point[0], onFloorEndpoint.point[1], cfg);
    const offCenter = getCellCenter(offFloorEndpoint.point[0], offFloorEndpoint.point[1], cfg);
    const midX = (onCenter.x + offCenter.x) / 2;
    const midY = (onCenter.y + offCenter.y) / 2;
    const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
    const snapped = getCellCenter(snapX, snapY, cfg);

    const onFinal: [number, number] = [onPos.x, onPos.y];
    const badgeFinal: [number, number] = [snapped.x, snapped.y];
    // Departure is always `from`, arrival always `to` (matches the both-on-floor branch above and
    // makes the arrow, which always points `from`→`to`, read correctly either way) — the badge sits
    // wherever the off-floor endpoint's role puts it: `toFloor` when it's the arrival end (the
    // on-floor marker is `from`/departure), `fromFloor` when it's the departure end (the on-floor
    // marker is `to`/arrival) — see `TeleportEdge.fromFloor`'s own doc comment.
    return onFloorIsDeparture
      ? { from: onFinal, to: badgeFinal, oneWay, toFloor: offFloorEndpoint.level ?? 0 }
      : { from: badgeFinal, to: onFinal, oneWay, fromFloor: offFloorEndpoint.level ?? 0 };
  });

  if (spread) {
    // Floor-independent cross-floor badge relocation, shared with the generation view (GitHub issue
    // #480). Pairs are keyed by preset teleport id; `endA`/`endB` are the two real endpoint cells.
    const pairs: CrossFloorBadgePair[] = [];
    for (const t of spread.allTeleports) {
      const fromLevel = t.from.level ?? 0;
      const toLevel = t.to.level ?? 0;
      if (fromLevel === toLevel) continue;
      pairs.push({
        key: String(t.id),
        floors: [fromLevel, toLevel],
        endA: [t.from.point[0], t.from.point[1]],
        endB: [t.to.point[0], t.to.point[1]],
      });
    }
    const posByPair = resolveCrossFloorBadgeCells(
      pairs, cfg, spread.blockedCellsByFloor, spread.allowOutOfField ?? true, spread.fieldCells,
    );
    edges.forEach((edge, i) => {
      if (edge.fromFloor === undefined && edge.toFloor === undefined) return;
      const pos = posByPair.get(String(teleports[i].id));
      if (!pos) return;
      if (edge.fromFloor !== undefined) edge.from = [pos[0], pos[1]];
      else edge.to = [pos[0], pos[1]];
    });
  }

  return edges;
}

/** Preset `VerticalPassage`/`Elevator` links (GitHub issue #357), on the active floor, converted to
 *  `VerticalConnectionMarker`s for `VerticalConnectionRenderer` reuse — the same marker primitive
 *  `GenerationRenderer` uses for the resolved edges after generation, so a preset reads identically
 *  to its own generated result (not like a teleport, which `TeleportRenderer` — the earlier,
 *  replaced approach — visually resembles). One marker per endpoint that lands on the active floor;
 *  `direction`/`targetFloorIndex` only need to resolve against this call's own known endpoints, not
 *  aggregate across several unrelated edges the way `mazeSelectors.ts`'s own
 *  `buildVerticalConnectionMarkers` must (a resolved graph's `Elevator` fan is several separate
 *  edges sharing a `from`; here one `PresetElevatorEntry` already holds every floor directly). */
export function buildPresetVerticalMarkers(
  passages: PresetVerticalPassageEntry[],
  elevators: PresetElevatorEntry[],
  cfg: FieldConfig,
  activeLevel: number | undefined,
  nodePositions: PresetNodePositions = new Map(),
): VerticalConnectionMarker[] {
  const result: VerticalConnectionMarker[] = [];
  const active = activeLevel ?? 0;

  for (const p of passages) {
    // `from`/`to` are the two click points in placement order; the actual passage direction for
    // "backward" runs the other way (mirrors the preset teleport convention above) — entry is the
    // departure end (filled, solid arrow), exit is the arrival end (empty, outline arrow) for a
    // one-way passage. A two-way passage's active-floor endpoint always draws filled regardless of
    // which click-order end it is.
    const [entryCell, exitCell] = p.direction === "backward" ? [p.to, p.from] : [p.from, p.to];
    const onEntry = (entryCell.level ?? 0) === active;
    const onExit = (exitCell.level ?? 0) === active;
    if (!onEntry && !onExit) continue;
    const own = onEntry ? entryCell : exitCell;
    const other = onEntry ? exitCell : entryCell;
    // `nodePositions` (`buildPresetNodePositions`) keys split-point nodes WITHOUT a `level` suffix
    // (it's built once per active-floor redraw from that floor's own already level-filtered
    // `presetSplitPoints`/`presetConnections` — see `redrawGenSource`'s doc comment for the same
    // convention). `own` still carries its real `.level` (0 for the active floor when it's floor 0,
    // but the actual floor index otherwise), so looking it up as-is only ever matched by accident on
    // floor 0 (`level: undefined` → no suffix either way); on any other floor the keyed lookup missed
    // and silently fell back to the plain cell center, ignoring the split slot entirely.
    const [posX, posY] = presetEndpointScreenPos(withoutLevel(own), cfg, nodePositions);
    const isOneWay = p.direction !== "two_way";
    // A one-way passage's marker is always empty (`filled: false`) at *both* ends — only the
    // arrow tells departure and arrival apart (solid on entry, outline on exit), same as
    // `mazeSelectors.ts`'s own `buildVerticalConnectionMarkers` for the resolved graph. A two-way
    // passage's marker is always filled, regardless of click-order end.
    result.push({
      pos: [posX, posY],
      fromNode: 0,
      kind: "vertical_passage",
      direction: (other.level ?? 0) > active ? "up" : "down",
      targetFloorIndex: other.level ?? 0,
      filled: !isOneWay,
      arrowFilled: !isOneWay || onEntry,
    });
  }

  for (const e of elevators) {
    const onFloor = e.floors.filter((f) => (f.level ?? 0) === active);
    if (onFloor.length === 0) continue;
    const ownEndpoint = onFloor[0];
    // Same level-suffix mismatch as the vertical-passage loop above — strip `.level` before the
    // `nodePositions` lookup so a split slot on any non-zero floor resolves to its real anchor
    // instead of silently falling back to the plain cell center.
    const [posX, posY] = presetEndpointScreenPos(withoutLevel(ownEndpoint), cfg, nodePositions);
    const others = e.floors.filter((f) => (f.level ?? 0) !== active);
    const sawUp = others.some((f) => (f.level ?? 0) > active);
    const sawDown = others.some((f) => (f.level ?? 0) < active);
    result.push({
      pos: [posX, posY],
      fromNode: 0,
      kind: "elevator",
      direction: sawUp && sawDown ? "both" : sawUp ? "up" : "down",
      filled: true,
      arrowFilled: true,
    });
  }

  return result;
}
