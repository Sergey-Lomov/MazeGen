import { useMazeStore } from "../../store/mazeStore";
import { ToggleRow } from "../ToggleRow";
import { Button } from "../Button";
import { bringSidePanelToFront } from "../SidePanel";
import { Stack } from "../Layout";
import { ZonesPanel } from "./ZonesPanel";
import * as m from "~/paraglide/messages";

export function ZonesFeature() {
  const showAutoZones = useMazeStore((s) => s.showAutoZones);
  const showManualZones = useMazeStore((s) => s.showManualZones);
  const setShowAutoZones = useMazeStore((s) => s.setShowAutoZones);
  const setShowManualZones = useMazeStore((s) => s.setShowManualZones);
  const zonesPanelOpen = useMazeStore((s) => s.zonesPanelOpen);
  const setZonesPanelOpen = useMazeStore((s) => s.setZonesPanelOpen);

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
      {zonesPanelOpen && <ZonesPanel onClose={() => setZonesPanelOpen(false)} />}
    </Stack>
  );
}
