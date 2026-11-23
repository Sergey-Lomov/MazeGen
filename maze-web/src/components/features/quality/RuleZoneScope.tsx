import type React from "react";
import { useMazeStore } from "../../../store/mazeStore";
import { Bubble } from "../../Bubble";
import { cssColor } from "../../EntityColorSwatch";
import { zoneChipColors, zoneColors, zoneDisplayName, zoneGroupDisplayName } from "../../../domain/selectors/zoneSelectors";
import { indent, muted, spacing, typography, ui } from "../../../styles/theme";
import * as m from "~/paraglide/messages";

/** The zone or group a QC rule is bound to (GitHub issue #1039), in the rule card header, a grid cell under the title text and indented by `indent.tree`: a caption naming
 *  the kind of binding, then a bubble with the zone in its own colour or the group in the info blue. A zone or
 *  group deleted since shows as missing, next to the rule's warning. */
export function RuleZoneScope({ ruleId }: { ruleId: string }) {
  const target = useMazeStore((s) => s.rules.find((r) => r.id === ruleId)?.zoneScope);
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const floors = useMazeStore((s) => s.floors);
  const colorOverrides = useMazeStore((s) => s.zoneColorOverrides);
  if (!target) return null;

  let label: string = m["quality.zone_scope_missing"]();
  // A target that no longer exists is a warning (see `zoneScopeHasNoZones`); a group is blue, a zone its own color.
  let colors: { bg: string; text: string } = { bg: ui.bg.warning, text: ui.text.warning };
  if (target.kind === "zone") {
    const index = zones.findIndex((z) => z.id === target.id);
    if (index >= 0) {
      const chip = zoneChipColors(zoneColors(zones, colorOverrides)[index]);
      label = zoneDisplayName(zones[index], floors);
      colors = { bg: cssColor(chip.bg), text: cssColor(chip.text) };
    }
  } else {
    const group = groups.find((g) => g.id === target.id);
    if (group) {
      label = zoneGroupDisplayName(group);
      colors = { bg: ui.bg.info, text: ui.text.info };
    }
  }
  const caption = m[target.kind === "zone" ? "quality.zone_scope_zone" : target.mode === "union" ? "quality.zone_scope_group" : "quality.zone_scope_each"]();

  return (
    <div style={styles.row} data-testid="rule-zone-scope">
      <span style={styles.caption}>{caption}</span>
      <Bubble colors={colors}>{label}</Bubble>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { gridColumn: 3, display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap, paddingLeft: indent.tree },
  caption: muted(typography.caption),
};
