import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { resolveIssueLabel, resolveIssueDescription, resolveIssueSection, resolveIssueShortLabel } from "./qualityI18n";
import { ui, radius, typography, disabled, spacing, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onSelect: (kind: string) => void;
  onClose: () => void;
}

/** Fixed display order for issue kinds in `IssueSelectDialog`: groups kinds into sections
 * (Waypoints, One-ways, Teleports, Loops, Regions), each internally ordered add → validate →
 * validate groups. `ItemSelectDialog` groups by contiguous `section` runs, so this order is
 * what makes each section's items land together. Kinds absent here sort after all of these. */
const ISSUE_KIND_ORDER = [
  "missing_endpoints", "unreachable_finish",
  "missing_one_ways", "invalid_one_way", "invalid_one_way_group",
  "missing_teleports", "invalid_teleport", "invalid_teleport_group",
  "missing_loops", "invalid_loop", "invalid_loop_group",
  "missing_regions", "region_needs_expansion", "region_needs_shrink", "excessive_scc_count",
];

/** Step 1 of "Add new rule": pick the issue kind first, narrowing the check list shown in
 * step 2 (CheckSelectDialog with a `kind` filter) to checks of that kind. */
export function IssueSelectDialog({ onSelect, onClose }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);

  const kinds = Array.from(new Set(availableChecks.map((c) => c.issue_kinds[0]))).sort((a, b) => {
    const ia = ISSUE_KIND_ORDER.indexOf(a);
    const ib = ISSUE_KIND_ORDER.indexOf(b);
    return (ia === -1 ? ISSUE_KIND_ORDER.length : ia) - (ib === -1 ? ISSUE_KIND_ORDER.length : ib);
  });
  const [selectedKind, setSelectedKind] = useState<string>(kinds[0] ?? "");

  const items = kinds.map((kind) => ({
    id: kind,
    label: resolveIssueShortLabel(kind),
    section: resolveIssueSection(kind),
  }));

  const rightPanel = selectedKind ? (
    <>
      <div style={styles.label}>{resolveIssueLabel(selectedKind)}</div>
      <div style={styles.description}>{resolveIssueDescription(selectedKind)}</div>
    </>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const footer = (
    <>
      <button className="hoverable" style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        className={selectedKind ? "hoverable-accent" : undefined}
        style={{ ...styles.btnPrimary, ...(!selectedKind ? styles.btnDisabled : {}) }}
        disabled={!selectedKind}
        onClick={() => selectedKind && onSelect(selectedKind)}
      >
        {m["common.select"]()}
      </button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.select_issue_title"]()}
      items={items}
      selectedId={selectedKind}
      onSelectId={setSelectedKind}
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: {
    ...typography.body,
    marginTop: spacing.groupGap,
  },
  description: {
    ...typography.body,
    lineHeight: 1.6,
  },
  empty: {
    ...disabled(typography.caption),
  },
  btnPrimary: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
