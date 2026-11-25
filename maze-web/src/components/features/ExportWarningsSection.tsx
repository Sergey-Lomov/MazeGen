import React, { useState } from "react";
import { SectionHeader } from "../SectionHeader";
import { ExportWarningBubble } from "./ExportWarningBubble";
import { resolveExportWarningsSectionTitle } from "./exportWarningsI18n";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { indent, spacing, ui } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { WarningBubble } from "../WarningBubble";
import { ExportOverrideConflictModal, addressOf } from "./ExportOverrideConflictModal";
import { ZoneTargetBadges } from "./ZoneTargetBadges";
import { useMazeStore } from "../../store/mazeStore";
import { exportParamConflicts } from "../../store/exportZoneOverrides";
import type { ExportZoneOverride } from "../../store/zonesTypes";
import { ExportZoneProblemBubble } from "./ExportZoneProblemBubble";
import { overrideProblem, emptyParamTargets } from "../../domain/zoneOverrides";
import { ZoneIdChips } from "./ZoneProblemChips";
import * as m from "~/paraglide/messages";

/** The bottom "Warnings" section both `VectorByWallsSettingsPanel` and
 *  `VectorByCorridorsSettingsPanel` render identically (GitHub issue #313 follow-up factoring out
 *  the exact copy-pasted divider+header+bubble-list block) — hidden entirely when `warnings` is
 *  empty, collapsible like every other section (`expanded`/`onToggle`), title shows the warning
 *  count via `resolveExportWarningsSectionTitle`. Each warning renders as its own
 *  `ExportWarningBubble`, which itself drives `hoveredExportWarningKey` on hover — the panel only
 *  needs to pass the already-computed `warnings` list, not know anything about highlighting. */
export function ExportWarningsSection({
  warnings,
  zoneWarnings,
  expanded,
  onToggle,
  showColorWarnings,
  onShowColorWarningsChange,
}: {
  warnings: ExportWarning[];
  /** The warnings of each zone override (GitHub issue #1040), by override; absent for a mode without a zone context. */
  zoneWarnings?: { override: ExportZoneOverride; warnings: ExportWarning[] }[];
  expanded: boolean;
  onToggle: () => void;
  showColorWarnings: boolean;
  onShowColorWarningsChange: (show: boolean) => void;
}) {
  const visibleWarnings = showColorWarnings ? warnings : warnings.filter((warning) => !warning.id.includes("low_contrast"));
  const showZoneProblems = useMazeStore((s) => s.showZoneProblems);
  const setShowZoneProblems = useMazeStore((s) => s.setShowZoneProblems);
  // A zone's own problem is one the list above does not already show: what the zone shares with the global settings is not its.
  const shown = new Set(warnings.map((warning) => warning.id));
  const zoneProblems = (zoneWarnings ?? []).flatMap(({ override, warnings: list }) => list
    .filter((warning) => !shown.has(warning.id) && (showColorWarnings || !warning.id.includes("low_contrast")))
    .map((warning) => ({ override, warning })));
  // Zone overrides of the export parameters (GitHub issue #1040): one without zones, and values set differently on shared cells.
  const overrides = useMazeStore((s) => s.exportZoneOverrides);
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const [conflictInfoOpen, setConflictInfoOpen] = useState(false);
  // The "show zone problems" switch hides every zone warning: the override ones (missing, empty, overlapping) as well.
  const missingZones = showZoneProblems && overrides.some((o) => overrideProblem(o, zones, groups) === "missing");
  const emptyParams = showZoneProblems ? emptyParamTargets(overrides, zones, groups, (o, path) => `${o.mode}:${path}`) : [];
  const conflicts = showZoneProblems ? exportParamConflicts(overrides, zones, groups) : [];
  const conflicting = conflicts.length;
  const warningCount = visibleWarnings.length + zoneProblems.length + (missingZones ? 1 : 0) + emptyParams.length + conflicting;
  return (
    <>
      <SectionHeader
        label={
          <span className={warningCount > 0 ? "problem-section-attention" : undefined}>
            {resolveExportWarningsSectionTitle(warningCount)}
          </span>
        }
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded && (
        <div style={styles.settingsBlock}>
          <ToggleRow label={m["image_export.warning.show_color_warnings"]()} checked={showColorWarnings} onChange={onShowColorWarningsChange} />
          {zoneWarnings !== undefined && <ToggleRow label={m["image_export.warning.show_zone_problems"]()} checked={showZoneProblems} onChange={setShowZoneProblems} />}
        </div>
      )}
      {expanded && warningCount > 0 && (
        <div style={styles.warningsBlock}>
          {missingZones && <WarningBubble message={m["image_export.zone_overrides.no_zones_warning"]()} />}
          {emptyParams.map(({ key, path, sample, zoneIds, groupIds }) => (
            <WarningBubble key={key} message={m["image_export.zone_overrides.empty_warning"]({ param: addressOf(sample.mode, path) })}>
              <div style={styles.zoneBadges}><ZoneIdChips zoneIds={zoneIds} groupIds={groupIds} /></div>
            </WarningBubble>
          ))}
          {conflicts.map((conflict) => (
            <WarningBubble key={`${conflict.mode}:${conflict.path}`} message={m["image_export.zone_overrides.conflict_param"]({ param: addressOf(conflict.mode, conflict.path) })} onInfo={() => setConflictInfoOpen(true)}>
              <div style={styles.zoneBadges}>
                <ZoneTargetBadges target={{ zoneIds: conflict.zoneIds, groupIds: conflict.groupIds }} />
              </div>
            </WarningBubble>
          ))}
          {visibleWarnings.map((w) => (
            <ExportWarningBubble key={w.key} warning={w} />
          ))}
          {zoneProblems.map(({ override, warning }) => (
            <ExportZoneProblemBubble key={`${override.id}:${warning.key}`} override={override} warning={warning} />
          ))}
        </div>
      )}
      {conflictInfoOpen && conflicting > 0 && <ExportOverrideConflictModal onClose={() => setConflictInfoOpen(false)} />}
      <div style={styles.divider} />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  settingsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: indent.tree },
  warningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: indent.tree },
  zoneBadges: { display: "flex", flexWrap: "wrap", gap: spacing.itemGap / 2 },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
