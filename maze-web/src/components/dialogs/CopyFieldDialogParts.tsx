import React from "react";
import { Switch } from "../Switch";
import { ui, dialogSpacing, typography, spacing, indent } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** Shared pieces of the two field-copy dialogs (`CopyFloorDialog`, `CopyFieldToFloorsDialog`, GitHub
 *  issue #1010), so they share one layout: explanation, a labeled floor list, the options, buttons. */

/** The explanation line on top, styled like the message of the confirmation dialogs. */
export function CopyDialogText({ children }: { children: React.ReactNode }) {
  return <div style={styles.text}>{children}</div>;
}

/** A dialog section: a separator above, a heading ("Copy from", "Options") and the content right
 *  under it. A section stands out by the indent of its content, not by vertical space, so the
 *  heading sits as close to the content as the content's own items sit to each other. */
export function CopyDialogSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>{label}</div>
      {children}
    </div>
  );
}

/** Style for a dialog list: the rows span the dialog's full width (their hover band) and scroll when
 *  there are many floors, while their own side padding lines the labels up with the dialog content. */
export const copyDialogListStyle: React.CSSProperties = {
  margin: `0 -${dialogSpacing.paddingX}px`,
  maxHeight: "40vh",
  overflowY: "auto",
};

/** The "Include topology" option: the switch with a one-line explanation of what it copies. */
export function CopyTopologyOption({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <CopyDialogSection label={m["field.copy_options"]()}>
      <div style={styles.option}>
        <div style={styles.optionText}>
          <span style={styles.optionLabel}>{m["field.copy_floor_include_topology"]()}</span>
          <span style={styles.optionHint}>{m["field.copy_floor_include_topology_hint"]()}</span>
        </div>
        <Switch checked={checked} onChange={onChange} ariaLabel={m["field.copy_floor_include_topology"]()} />
      </div>
    </CopyDialogSection>
  );
}

const styles: Record<string, React.CSSProperties> = {
  text: { ...typography.message, lineHeight: 1.5 },
  sectionLabel: { ...typography.control, color: ui.text.primary },
  section: {
    display: "flex",
    flexDirection: "column",
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  // One tree indent in from the section label, like the floor rows of the dialogs.
  option: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: dialogSpacing.gap, paddingLeft: indent.tree, paddingTop: 3, paddingBottom: 3 },
  optionText: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2, minWidth: 0 },
  optionLabel: { ...typography.control, color: ui.text.secondary },
  optionHint: { ...typography.caption, color: ui.text.tertiary },
};
