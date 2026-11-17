import { useState } from "react";
import { SectionHeader } from "./SectionHeader";
import { ExportWarningBubble } from "./features/ExportWarningBubble";
import { resolveExportWarningsSectionTitle } from "./features/exportWarningsI18n";
import type { ExportWarning } from "../pixi/selectors/exportWarnings";
import { ui, typography, spacing, indent } from "../styles/theme";
import * as m from "~/paraglide/messages";
import type React from "react";

/** Collapsible "Warnings (N)" section shared by the color and font pickers: the export warnings that
 *  concern the value being edited, in the export panel's bubble style without the details modal.
 *  Starts collapsed, stays visible with `N = 0` and takes the attention color when `N > 0`. */
export function PickerWarningsSection({ warnings, testId }: { warnings: ExportWarning[]; testId: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-testid={testId}>
      <SectionHeader
        label={<span className={warnings.length > 0 ? "problem-section-attention" : undefined}>
          {resolveExportWarningsSectionTitle(warnings.length)}
        </span>}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && <div style={styles.block}>
        {warnings.length === 0
          ? <span style={styles.empty}>{m["picker.no_export_warnings"]()}</span>
          : warnings.map((warning) => <ExportWarningBubble key={warning.key} warning={warning} interactive={false} />)}
      </div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree, marginTop: spacing.itemGap },
  empty: { ...typography.body, color: ui.text.secondary },
};
