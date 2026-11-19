import { useState } from "react";
import { SectionHeader } from "./SectionHeader";
import { WarningBubble } from "./WarningBubble";
import { spacing, indent, ui } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Standard collapsed-by-default diagnostics section. It stays available at zero warnings so a
 * changing diagnostic set never shifts the surrounding editor layout. */
export function WarningsSection({ warnings, testId }: { warnings: string[]; testId?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-testid={testId}>
      <SectionHeader
        label={<span className={warnings.length > 0 ? "problem-section-attention" : undefined}>
          {m["common.warnings"]({ count: String(warnings.length) })}
        </span>}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && warnings.length > 0 && (
        <div style={styles.list}>{warnings.map((warning, index) => <WarningBubble key={index} message={warning} />)}</div>
      )}
      <div style={styles.divider} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Diagnostics are actionable messages, not compact setting rows: give the first bubble and its
  // siblings a full group gap below the header, while the following editor section stays close to
  // the divider (its bottom margin is deliberately only one item gap).
  list: { display: "flex", flexDirection: "column", gap: spacing.groupGap, paddingLeft: indent.tree, marginTop: spacing.groupGap },
  divider: { borderTop: `1px solid ${ui.border.default}`, margin: `${spacing.groupGap}px 0 ${spacing.itemGap}px` },
};
