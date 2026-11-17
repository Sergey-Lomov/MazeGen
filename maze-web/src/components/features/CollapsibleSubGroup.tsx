import type * as React from "react";
import { indent, spacing } from "../../styles/theme";
import { SectionHeader } from "../SectionHeader";

/** One collapsible sub-group: a header plus an indented body shown only while `id` is expanded.
 *  `isExpanded`/`onToggle` read and flip the caller's own generic sections-expanded record by id
 *  (same convention as `MarkerSettingsGroup` and `MarkerIndexSection`). */
export function CollapsibleSubGroup({ id, label, isExpanded, onToggle, children }: {
  id: string;
  label: string;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.wrap}>
      <SectionHeader label={label} expanded={isExpanded(id)} onToggle={() => onToggle(id)} />
      {isExpanded(id) && <div style={styles.body}>{children}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  body: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
