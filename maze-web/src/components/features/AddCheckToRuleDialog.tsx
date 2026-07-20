import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { ParamFields } from "./ParamFields";
import { resolveCheckLabel, resolveCheckDescription, resolveIssueLabel, resolveParamLabel, resolveParamDescription } from "./qualityI18n";
import { ui, radius, typography, disabled } from "../../styles/theme";
import * as m from "~/paraglide/messages";
import type { ParamDescriptor } from "../../wasm/types";

// "min,max" for interval params -- mirrors maze-core's `parse_param` Interval encoding
// (repair/params.rs).
function defaultValue(p: ParamDescriptor): string {
  const k = p.kind;
  if (k.type === "bool") return k.default ? "true" : "false";
  if (k.type === "interval") return `${k.default_min},${k.default_max}`;
  return String(k.default);
}

/** A check type offered as a candidate to add into a rule — this is a `CheckDescriptor`
 * projection, not a `CheckVM`: candidates aren't active instances yet, so they have no
 * `ruleId`/`localId`. */
export interface CheckCandidateVM {
  typeId: string;
  label: string;
  description: string;
  params: ParamDescriptor[];
}

interface Props {
  ruleId: string;
  /** Issue kind shared by `candidates` and the target rule — shown in the dialog title. */
  kind: string;
  /** Check types sharing the rule's kind, already filtered by `RulesColumn.candidatesFor` — a
   * type with `allow_multiple_instances` (none currently — see GitHub issue #60, retired) would
   * be offered even if already active elsewhere; every other type is excluded once active
   * anywhere. */
  candidates: CheckCandidateVM[];
  onClose: () => void;
}

/** Picker for the rule's own `+` (RulesColumn) — activates a not-yet-active check of this
 * rule's kind directly into this rule (not as a new singleton rule), merging its issues for
 * the rule's shared strategy. Unlike CheckSelectDialog (top-level "+", always creates a new
 * rule), this targets an existing rule. */
export function AddCheckToRuleDialog({ ruleId, kind, candidates, onClose }: Props) {
  const addCheck = useMazeStore((s) => s.addCheck);
  const [selectedId, setSelectedId] = useState<string>(candidates[0]?.typeId ?? "");
  // Param edits made in this dialog before the check is actually added — keyed by check type id
  // so switching the selection and coming back preserves what was typed (mirrors CheckSelectDialog).
  const [paramOverrides, setParamOverrides] = useState<Record<string, Record<string, string>>>({});

  const selected = candidates.find((c) => c.typeId === selectedId);

  function handleParamChange(paramId: string, value: string) {
    setParamOverrides((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [paramId]: value },
    }));
  }

  function handleAdd() {
    if (selectedId) {
      addCheck(selectedId, ruleId, paramOverrides[selectedId]);
      onClose();
    }
  }

  const items = candidates.map((c) => ({
    id: c.typeId,
    label: resolveCheckLabel(c.typeId, c.label),
  }));

  const rightPanel = selected ? (
    <>
      <div style={styles.description}>{resolveCheckDescription(selected.typeId, selected.description)}</div>
      {selected.params.length > 0 && (
        <div style={styles.paramsSection}>
          <div style={styles.paramsSeparator} />
          <ParamFields
            params={selected.params.map((p) => ({ ...p, label: resolveParamLabel(p.id, p.label) }))}
            getValue={(p) => paramOverrides[selectedId]?.[p.id] ?? defaultValue(p)}
            onChange={handleParamChange}
            getDescription={(p) => resolveParamDescription(p.id)}
          />
        </div>
      )}
    </>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const footer = (
    <>
      <button className="hoverable" style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        className={selectedId ? "hoverable-accent" : undefined}
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
    ...typography.body,
    lineHeight: 1.6,
  },
  empty: {
    ...disabled(typography.caption),
  },
  paramsSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  paramsSeparator: {
    borderTop: `1px solid ${ui.border.default}`,
    marginBottom: 4,
  },
  btnPrimary: {
    ...typography.control,
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 12px",
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnSecondary: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
