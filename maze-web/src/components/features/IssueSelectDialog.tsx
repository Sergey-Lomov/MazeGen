import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { Button } from "../Button";
import { isEntityVisible } from "./ParamFields";
import { resolveIssueLabel, resolveIssueDescription, resolveIssueSection, resolveIssueShortLabel } from "./qualityI18n";
import { radius, typography, disabled, spacing, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onSelect: (kind: string) => void;
  onClose: () => void;
}

/** Fixed display order for issue kinds in `IssueSelectDialog`: General rules first (the
 * cross-element multi-type proximity checks, GitHub issue #376), then kinds grouped into
 * sections (Waypoints, One-ways, Teleports, Loops, Regions, Splits, Vertical Passages,
 * Elevators), each internally ordered add → validate → validate groups (Splits has extra
 * validate-node/validate-node-connection/validate-route steps between validate-tile and the
 * group checks; Elevators has an extra add-stops step right after add, before validation).
 * `ItemSelectDialog` groups by contiguous `section` runs, so every kind sharing a section must
 * be listed together here — a kind left out sorts after all of these and can split its section
 * into two non-contiguous runs, which renders as duplicate React keys. Kinds absent here sort
 * after all of these. */
const ISSUE_KIND_ORDER = [
  "invalid_cross_element_group",
  "missing_endpoints", "unreachable_finish",
  "missing_one_ways", "invalid_one_way", "invalid_one_way_group",
  "missing_teleports", "invalid_teleport", "invalid_teleport_group",
  "missing_loops", "invalid_loop", "invalid_loop_group",
  "missing_regions", "region_needs_expansion", "region_needs_shrink", "excessive_scc_count",
  "missing_split_tiles", "invalid_split_tile", "invalid_split_node", "invalid_split_node_connection",
  "invalid_split_route", "invalid_split_tile_group", "invalid_split_node_group", "invalid_split_node_connection_group",
  "missing_vertical_passages", "invalid_vertical_passage", "invalid_vertical_passage_group",
  "missing_elevators", "area_missing_elevator_stops", "missing_elevator_stop_count", "missing_elevator_height", "excessive_elevator_stop_gap",
  "invalid_elevator", "invalid_elevator_group", "invalid_elevator_stop", "invalid_elevator_stop_group",
];

/** Step 1 of "Add new rule": pick the issue kind first, narrowing the check list shown in
 * step 2 (CheckSelectDialog with a `kind` filter) to checks of that kind. */
export function IssueSelectDialog({ onSelect, onClose }: Props) {
  const allChecks = useMazeStore((s) => s.availableChecks);
  const floorCount = useMazeStore((s) => s.floors.length);
  // A kind survives here if at least one check offering it is currently visible -- a kind whose
  // every check is `MultiFloorOnly` (e.g. vertical-passage/elevator kinds on a single floor)
  // disappears entirely rather than leading to an empty step-2 dialog.
  const availableChecks = allChecks.filter((c) => isEntityVisible(c.visibility, floorCount));

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
      <Button variant="secondary" dialogAction layoutStyle={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</Button>
      <Button
        variant="primary"
        dialogAction
        layoutStyle={styles.btnPrimary}
        disabled={!selectedKind}
        onClick={() => selectedKind && onSelect(selectedKind)}
      >
        {m["common.select"]()}
      </Button>
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
      onConfirm={selectedKind ? () => onSelect(selectedKind) : undefined}
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
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
