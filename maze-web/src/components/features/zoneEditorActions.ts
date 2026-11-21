import { useMazeStore } from "../../store/mazeStore";

/** "Add zone" of the zones feature card and of the manual zones list: opens the manual list and the editor of a
 *  new zone over it. A new zone that is still being edited is kept (`addManualZone` changes nothing then); the store
 *  raises the editor over the list again, so the button works whichever panel is on top. */
export function startNewZone(): void {
  const s = useMazeStore.getState();
  s.setZonesListMode("manual");
  s.setZonesPanelOpen(true);
  s.addManualZone();
}

/** "Add group" of the groups list: opens the editor of a new group over the list. A new group that is still being
 *  edited is kept (`addZoneGroup` changes nothing then); the store raises its editor over the list again. */
export function startNewGroup(): void {
  useMazeStore.getState().addZoneGroup();
}
