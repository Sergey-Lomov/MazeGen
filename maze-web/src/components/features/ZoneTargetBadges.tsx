import { Bubble } from "../Bubble";
import { useMazeStore } from "../../store/mazeStore";
import type { ZoneOverride } from "../../store/zonesTypes";
import { useOverrideTargets } from "../ZoneOverridesSection";

/** The zones and groups of an export override as badges (GitHub issue #1040), for a warning they belong to. Hovering one lights
 *  it up on the canvas; a click makes it the settings context and clears the highlight. */
export function ZoneTargetBadges({ target }: { target: Pick<ZoneOverride, "zoneIds" | "groupIds"> }) {
  const { targets, showTarget, hover } = useOverrideTargets();
  const setContext = useMazeStore((s) => s.setExportOverrideContext);
  const setShowButtons = useMazeStore((s) => s.setShowZoneOverrideButtons);
  return (
    <>
      {targets(target).map((t) => (
        <Bubble
          key={t.key}
          data-testid="export-zone-problem-target"
          colors={t.colors}
          interactive
          onMouseEnter={() => hover(t.target)}
          onMouseLeave={() => hover(null)}
          onClick={(event) => {
            event.stopPropagation();
            setShowButtons(true);
            setContext(t.target);
            showTarget(t.target);
            // The pointer leaves with the click, so the zone's highlight is cleared here.
            hover(null);
          }}
        >
          {t.label}
        </Bubble>
      ))}
    </>
  );
}
