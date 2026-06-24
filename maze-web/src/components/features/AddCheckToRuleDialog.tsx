import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel } from "./qualityI18n";
import { colors, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { CheckVM } from "./useQualityViewModel";

interface Props {
  ruleId: string;
  /** Issue kind shared by `candidates` and the target rule — shown in the dialog title. */
  kind: string;
  /** Not-yet-active checks sharing the rule's kind — candidates to activate into this rule. */
  candidates: CheckVM[];
  onClose: () => void;
}

/** Picker for the rule's own `+` (RulesColumn) — activates a not-yet-active check of this
 * rule's kind directly into this rule (not as a new singleton rule), merging its issues for
 * the rule's shared strategy. Unlike CheckSelectDialog (top-level "+", always creates a new
 * rule), this targets an existing rule. */
export function AddCheckToRuleDialog({ ruleId, kind, candidates, onClose }: Props) {
  const addCheck = useMazeStore((s) => s.addCheck);
  const [selectedId, setSelectedId] = useState<string>(candidates[0]?.id ?? "");

  const selected = candidates.find((c) => c.id === selectedId);

  function handleAdd() {
    if (selectedId) {
      addCheck(selectedId, ruleId);
      onClose();
    }
  }

  const items = candidates.map((c) => ({
    id: c.id,
    label: resolveCheckLabel(c.id, c.label),
  }));

  const rightPanel = selected ? (
    <div style={styles.description}>{resolveCheckDescription(selected.id, selected.description)}</div>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        style={{ ...styles.btnPrimary, ...(!selectedId ? styles.btnDisabled : {}) }}
        disabled={!selectedId}
        onClick={handleAdd}
      >
        {m["check.add"]()}
      </button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.add_check_dialog_title"]({ issue: resolveIssueLabel(kind) })}
      items={items}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: colors.textFaint,
    lineHeight: 1.6,
  },
  empty: {
    fontSize: font.lg,
    color: colors.textVeryDim,
  },
  btnPrimary: {
    background: colors.bgBtnPrimary,
    border: "none",
    color: colors.textWhite,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnSecondary: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
