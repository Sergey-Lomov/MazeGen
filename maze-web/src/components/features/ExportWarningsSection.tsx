import type React from "react";
import { SectionHeader } from "../SectionHeader";
import { ExportWarningBubble } from "./ExportWarningBubble";
import { resolveExportWarningsSectionTitle } from "./exportWarningsI18n";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { indent, spacing, ui } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
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
  expanded,
  onToggle,
  showColorWarnings,
  onShowColorWarningsChange,
}: {
  warnings: ExportWarning[];
  expanded: boolean;
  onToggle: () => void;
  showColorWarnings: boolean;
  onShowColorWarningsChange: (show: boolean) => void;
}) {
  const visibleWarnings = showColorWarnings ? warnings : warnings.filter((warning) => !warning.id.includes("low_contrast"));
  return (
    <>
      <SectionHeader
        label={
          <span className={visibleWarnings.length > 0 ? "problem-section-attention" : undefined}>
            {resolveExportWarningsSectionTitle(visibleWarnings.length)}
          </span>
        }
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded && (
        <div style={styles.settingsBlock}>
          <ToggleRow label={m["image_export.warning.show_color_warnings"]()} checked={showColorWarnings} onChange={onShowColorWarningsChange} />
        </div>
      )}
      {expanded && visibleWarnings.length > 0 && (
        <div style={styles.warningsBlock}>
          {visibleWarnings.map((w) => (
            <ExportWarningBubble key={w.key} warning={w} />
          ))}
        </div>
      )}
      <div style={styles.divider} />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  settingsBlock: { marginTop: spacing.itemGap, paddingLeft: indent.tree },
  warningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap, paddingLeft: indent.tree },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
