import type { PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "./fieldEditUtils";
import { getCellCenter, nearestCellCoord } from "./tessellationGeometry";
import { presetEndpointScreenPos } from "./selectors/presetSelectors";
import type { PresetEndpoint } from "./presetEndpoint";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { TeleportEdge, VerticalConnectionMarker } from "./renderers/types";

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
 *  connector, exactly like the generation view. */
export function buildPresetTeleportEdges(
  teleports: PresetTeleportEntry[],
  cfg: TessellationConfig,
  activeLevel: number | undefined,
  nodePositions: PresetNodePositions = new Map(),
): TeleportEdge[] {
  const active = activeLevel ?? 0;
  const endpointPos = (ep: PresetEndpoint) => {
    const [x, y] = presetEndpointScreenPos(ep, cfg, nodePositions);
    return { x, y };
  };

  return teleports.map((t) => {
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
  cfg: TessellationConfig,
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
    const [posX, posY] = presetEndpointScreenPos(own, cfg, nodePositions);
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
    const [posX, posY] = presetEndpointScreenPos(ownEndpoint, cfg, nodePositions);
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
