import { useMazeStore } from "../../store/mazeStore";
import { bringSidePanelToFront } from "../SidePanel";

/** "Add zone" of the zones feature card and of the manual zones list: opens the manual list and the editor of a
 *  new zone over it. A new zone that is still being edited is kept (`addManualZone` changes nothing then), but the
 *  editor is raised over the list again, so the button works whichever panel is on top. */
export function startNewZone(): void {
  const s = useMazeStore.getState();
  bringSidePanelToFront("zones");
  bringSidePanelToFront("zone-edit");
  s.setZonesListMode("manual");
  s.setZonesPanelOpen(true);
  s.addManualZone();
}

/** "Add group" of the groups list: opens the editor of a new group over the list. A new group that is still being
 *  edited is kept (`addZoneGroup` changes nothing then), but its editor is raised over the list again. */
export function startNewGroup(): void {
  bringSidePanelToFront("zone-group-edit");
  useMazeStore.getState().addZoneGroup();
}
