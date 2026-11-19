import { useMazeStore } from "../../store/mazeStore";
import { ToggleRow } from "../ToggleRow";
import { Button } from "../Button";
import { bringSidePanelToFront } from "../SidePanel";
import { Stack } from "../Layout";
import { ZonesPanel } from "./ZonesPanel";
import { ZoneEditPanel } from "./ZoneEditPanel";
import * as m from "~/paraglide/messages";

export function ZonesFeature() {
  const showAutoZones = useMazeStore((s) => s.showAutoZones);
  const showManualZones = useMazeStore((s) => s.showManualZones);
  const setShowAutoZones = useMazeStore((s) => s.setShowAutoZones);
  const setShowManualZones = useMazeStore((s) => s.setShowManualZones);
  const zonesPanelOpen = useMazeStore((s) => s.zonesPanelOpen);
  const setZonesPanelOpen = useMazeStore((s) => s.setZonesPanelOpen);
  const zoneEditing = useMazeStore((s) => s.zoneEditId !== null && s.zones.some((z) => z.id === s.zoneEditId));
  const setZoneEditId = useMazeStore((s) => s.setZoneEditId);
  const setZonesListMode = useMazeStore((s) => s.setZonesListMode);
  const addManualZone = useMazeStore((s) => s.addManualZone);
  const cancelZoneEdit = useMazeStore((s) => s.cancelZoneEdit);

  return (
    <Stack gap="itemGap">
      <ToggleRow label={m["zones.show_auto"]()} checked={showAutoZones} onChange={setShowAutoZones} />
      <ToggleRow label={m["zones.show_manual"]()} checked={showManualZones} onChange={setShowManualZones} />
      <Button
        variant="secondary"
        layoutStyle={{ width: "100%" }}
        onClick={() => {
          bringSidePanelToFront("zones");
          setZonesPanelOpen(true);
        }}
      >
        {m["zones.open_list"]()}
      </Button>
      <Button
        variant="primary"
        layoutStyle={{ width: "100%" }}
        onClick={() => {
          // The new zone's editor opens over the manual zones list.
          bringSidePanelToFront("zones");
          setZonesListMode("manual");
          setZonesPanelOpen(true);
          addManualZone();
        }}
      >
        {m["zones.add"]()}
      </Button>
      {zonesPanelOpen && <ZonesPanel onClose={() => setZonesPanelOpen(false)} />}
      {zonesPanelOpen && zoneEditing && <ZoneEditPanel onDone={() => setZoneEditId(null)} onCancel={cancelZoneEdit} />}
    </Stack>
  );
}
