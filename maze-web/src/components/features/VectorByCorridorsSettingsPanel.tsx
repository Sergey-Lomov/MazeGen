import type React from "react";
import { inset, spacing } from "../../styles/theme";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";

/** "Vector by corridors" mode's own settings panel (GitHub issue #315) — empty scaffolding, filled
 * in by follow-up sub-issues. Bottom warnings section mirrors `VectorByWallsSettingsPanel`'s own
 * layout so both panels stay visually consistent; wired to an empty list here since this mode
 * doesn't draw anything yet — stays hidden until a follow-up sub-issue adds a real
 * `compute*Warnings` function for this mode. */
export function VectorByCorridorsSettingsPanel() {
  const exportWarnings: ExportWarning[] = [];

  return (
    <div style={styles.root}>
      {exportWarnings.length > 0 && (
        <div style={styles.warningsBlock} />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap, padding: `${inset.panelInsetY}px ${inset.panelInsetX}px` },
  warningsBlock: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
};
