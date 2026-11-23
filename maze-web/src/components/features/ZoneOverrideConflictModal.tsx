import React from "react";
import { Modal } from "../Modal";
import { typography, spacing } from "../../styles/theme";
import type { ZoneOverrideParamKey } from "../../store/zonesTypes";
import * as m from "~/paraglide/messages";

/** Short parameter names repeat across categories ("Chance"), so a category-owned one is prefixed with it, as the settings panel does for its aria labels. */
const categorized = (category: "one_way" | "teleport" | "split" | "vertical", label: string): string => `${m[`generation.category.${category}`]()} ${label}`;

/** Display name of the parameter an override key sets; both elevator span bounds are one row in the settings. */
const PARAM_LABELS: Record<ZoneOverrideParamKey, () => string> = {
  corridor_chance: () => m["generation.corridor_chance"](),
  branching: () => m["generation.branching"](),
  directionality: () => m["generation.directionality"](),
  cyclicity: () => m["generation.cyclicity"](),
  one_way_chance: () => categorized("one_way", m["generation.one_way_chance_short"]()),
  teleport_chance: () => categorized("teleport", m["generation.teleport_chance_short"]()),
  teleport_one_way_chance: () => categorized("teleport", m["generation.teleport_one_way_chance_short"]()),
  cross_floor_teleport_balance: () => categorized("teleport", m["generation.cross_floor_teleport_balance_short"]()),
  split_chance: () => categorized("split", m["generation.split_chance_short"]()),
  vertical_chance: () => categorized("vertical", m["generation.vertical_chance_short"]()),
  vertical_passage_elevator_balance: () => categorized("vertical", m["generation.vertical_passage_elevator_balance_short"]()),
  one_way_vertical_passage_chance: () => categorized("vertical", m["generation.one_way_vertical_passage_chance_short"]()),
  vertical_up_down_balance: () => categorized("vertical", m["generation.vertical_up_down_balance_short"]()),
  elevator_span_min: () => categorized("vertical", m["generation.elevator_span"]()),
  elevator_span_max: () => categorized("vertical", m["generation.elevator_span"]()),
  elevator_branching: () => categorized("vertical", m["generation.elevator_branching_short"]()),
  allow_non_consecutive_elevator_floors: () => categorized("vertical", m["generation.allow_non_consecutive_elevator_floors_short"]()),
};

/** Explains the "zones with special values overlap" warning (GitHub issue #1038) and lists the affected parameters. */
export function ZoneOverrideConflictModal({ params, onClose }: { params: readonly ZoneOverrideParamKey[]; onClose: () => void }) {
  const labels = [...new Set(params.map((key) => PARAM_LABELS[key]()))];
  return (
    <Modal title={m["generation.zone_override_conflict_info_title"]()} onClose={onClose}>
      <div style={styles.body}>
        <div style={styles.text}>{m["generation.zone_override_conflict_info_text"]()}</div>
        <div style={styles.text}>{m["generation.zone_override_conflict_info_params"]()}</div>
        <ul style={styles.list}>
          {labels.map((label) => <li key={label} style={styles.text}>{label}</li>)}
        </ul>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: spacing.sectionGap },
  text: { ...typography.body },
  list: { margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: spacing.elementsGap },
};
