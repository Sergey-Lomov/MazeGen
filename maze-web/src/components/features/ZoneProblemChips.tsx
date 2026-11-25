import { useEffect, useMemo, useRef } from "react";
import { useMazeStore } from "../../store/mazeStore";
import type { ZoneGroup } from "../../store/zonesTypes";
import type { Zone } from "../../wasm/mazeService";
import { useCoordinateWarningHover } from "../useCoordinateWarningHover";
import { invalidCellsWarning, type InvalidZone } from "../../domain/zoneProblems";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import { zoneChipColors, zoneColors, zoneDisplayName, zoneFloors, zoneGroupDisplayName } from "../../domain/selectors/zoneSelectors";
import { Bubble } from "../Bubble";
import { Tooltip } from "../Tooltip";
import { cssColor } from "../EntityColorSwatch";
import { spacing } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Goes to the lowest of `floors` unless the active floor is one of them (or there is none). */
function useGoToFloors() {
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  return (on: number[]) => {
    if (on.length > 0 && !on.includes(floors.findIndex((f) => f.id === activeFloorId))) navigateToFloor(on[0]);
  };
}

/** Clears the hover this chip set when it unmounts while hovered (no mouse-leave then). */
function useHoverRelease(release: () => void) {
  const hovering = useRef(false);
  const latest = useRef(release);
  latest.current = release;
  useEffect(() => () => {
    if (hovering.current) latest.current();
  }, []);
  return hovering;
}

/** A zone in a warning (GitHub issue #1034), in the zone's own colours: a click goes to its lowest floor unless the active
 *  floor already holds a cell of it, hovering lights it on the canvas. */
function ZoneChip({ zone, invalidCells }: { zone: Zone; invalidCells?: Zone["cells"] }) {
  const zones = useMazeStore((s) => s.zones);
  const floors = useMazeStore((s) => s.floors);
  const overrides = useMazeStore((s) => s.zoneColorOverrides);
  const setHover = useMazeStore((s) => s.setHoveredZone);
  const goTo = useGoToFloors();
  const hovering = useHoverRelease(() => setHover(null));
  // A zone beyond the field also lights its own cells outside it, merged into contours.
  const cellsHover = useCoordinateWarningHover(useMemo(() => invalidCellsWarning(invalidCells ? [{ zone, cells: invalidCells }] : []), [zone, invalidCells]));
  const chip = zoneChipColors(zoneColors(zones, overrides)[zones.findIndex((z) => z.id === zone.id)]);
  return (
    <Tooltip content={zoneFloors(zone).length > 0 ? m["zones.go_to_floor"]() : ""}>
      <Bubble
        data-testid="zone-problem-chip"
        colors={{ bg: cssColor(chip.bg), text: cssColor(chip.text) }}
        interactive
        onClick={() => goTo(zoneFloors(zone))}
        onMouseEnter={() => { hovering.current = true; setHover(zone.id); if (invalidCells) cellsHover.onMouseEnter(); }}
        onMouseLeave={() => { hovering.current = false; setHover(null); if (invalidCells) cellsHover.onMouseLeave(); }}
      >
        {zoneDisplayName(zone, floors)}
      </Bubble>
    </Tooltip>
  );
}

/** A group in a warning, a neutral (blue) bubble prefixed "Group: ": a click goes to the lowest floor of its zones unless the
 *  active floor holds one, hovering lights its zones. */
function GroupChip({ group }: { group: ZoneGroup }) {
  const zones = useMazeStore((s) => s.zones);
  const setHover = useMazeStore((s) => s.setHoveredZoneGroup);
  const goTo = useGoToFloors();
  const hovering = useHoverRelease(() => setHover(null));
  const on = [...new Set(zones.filter((z) => group.zoneIds.includes(z.id)).flatMap(zoneFloors))].sort((a, b) => a - b);
  return (
    <Tooltip content={on.length > 0 ? m["zone_groups.go_to_floor"]() : ""}>
      <Bubble
        data-testid="zone-problem-chip"
        interactive
        onClick={() => goTo(on)}
        onMouseEnter={() => { hovering.current = true; setHover(group.id); }}
        onMouseLeave={() => { hovering.current = false; setHover(null); }}
      >
        {m["zone_groups.bubble_label"]({ name: zoneGroupDisplayName(group) })}
      </Bubble>
    </Tooltip>
  );
}

/** `ZoneProblemChips` of the zones and groups with these ids; an id that names none is skipped. */
export function ZoneIdChips({ zoneIds, groupIds }: { zoneIds: readonly number[]; groupIds: readonly number[] }) {
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  return <ZoneProblemChips zones={zones.filter((z) => zoneIds.includes(z.id))} groups={groups.filter((g) => groupIds.includes(g.id))} />;
}

/** The zones and groups a warning names, as bubbles under its message. */
export function ZoneProblemChips({ zones = [], groups = [], invalid = [] }: { zones?: Zone[]; groups?: ZoneGroup[]; invalid?: InvalidZone[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.itemGap }}>
      {invalid.map(({ zone, cells }) => <ZoneChip key={zone.id} zone={zone} invalidCells={cells} />)}
      {zones.map((zone) => <ZoneChip key={zone.id} zone={zone} />)}
      {groups.map((group) => <GroupChip key={group.id} group={group} />)}
    </div>
  );
}
