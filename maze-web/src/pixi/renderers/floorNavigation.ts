import { useMazeStore } from "../../store/mazeStore";

/** Switches `activeFloorId` to the floor at `floorIndex` (`levels_ordered()` position, same
 *  convention as `NodeDto.level`/`VerticalConnectionMarker.targetFloorIndex`/`TeleportEdge.toFloor`)
 *  — shared by every floor-aware renderer wiring a click-to-switch-floor marker (GitHub issue #337
 *  follow-up: `VerticalConnectionRenderer`'s vertical-passage marker, `TeleportRenderer`'s
 *  cross-floor badge), so each one calls this instead of re-deriving `floors[index].id` and calling
 *  `setActiveFloorId` itself. No-op if `floorIndex` doesn't resolve to a current floor (index out of
 *  range — `floors` may have changed since the marker was drawn). */
export function navigateToFloor(floorIndex: number): void {
  const { floors, setActiveFloorId } = useMazeStore.getState();
  const floor = floors[floorIndex];
  if (floor) setActiveFloorId(floor.id);
}
