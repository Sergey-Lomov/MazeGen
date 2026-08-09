import type React from "react";
import { SectionHeader } from "../SectionHeader";
import { ExportWarningBubble } from "./ExportWarningBubble";
import { resolveExportWarningsSectionTitle } from "./exportWarningsI18n";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { spacing, ui } from "../../styles/theme";

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
}: {
  warnings: ExportWarning[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (warnings.length === 0) return null;

  return (
    <>
      <div style={styles.divider} />

      <SectionHeader
        label={resolveExportWarningsSectionTitle(warnings.length)}
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded && (
        <div style={styles.warningsBlock}>
          {warnings.map((w) => (
            <ExportWarningBubble key={w.key} warning={w} />
          ))}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  warningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.itemGap}px 0` },
};
