import { useState } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { useMazeStore } from "../../../store/mazeStore";
import { CheckSelectDialog } from "../CheckSelectDialog";
import { IssueSelectDialog } from "../IssueSelectDialog";
import { NewRuleStrategyDialog } from "../NewRuleStrategyDialog";
import { StrategySelectDialog } from "../StrategySelectDialog";
import { AddCheckToRuleDialog } from "../AddCheckToRuleDialog";
import { RuleStrategyPanel } from "./RuleStrategyPanel";
import { RuleCheckRow } from "./RuleCheckRow";
import { ConfirmModal } from "../../ConfirmModal";
import { AlertModal } from "../../AlertModal";
import { Switch } from "../../Switch";
import { colors } from "../../../styles/theme";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { resolveCheckLabel, resolveCheckDescription } from "../qualityI18n";
import type { StrategySlotVM } from "../useQualityViewModel";
import type { CheckCandidateVM } from "../AddCheckToRuleDialog";
import type { QualitySelection } from "./types";
import { isTypeAlreadyActive } from "../../../store/slices/generationSlice";

// Three-step "Add new rule" flow: pick an issue kind, then checks of that kind (multiselect),
// then a fix strategy for the new rule — nothing commits to the store until step 3 confirms
// (see `createRule`). Step 3 is skipped when no strategy handles the kind (logging-only kinds).
type NewRuleStep =
  | { stage: "issue" }
  | { stage: "checks"; kind: string }
  | { stage: "strategy"; kind: string; checkIds: string[]; paramOverrides: Record<string, Record<string, string>> }
  | null;

interface Props {
  slots: StrategySlotVM[];
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

// One card per rule, split left/right: checks on the left, fix strategy (+ its params, inline,
// the same as generation method params) on the right. Split rather than stacked so disabling/
// configuring the fix reads as independent from the checks — the checks still run regardless of
// whether their rule's fix is enabled. The card title row carries whole-rule tools (toggle,
// rename, remove), distinct from the strategy-only toggle in the right half.
export function RulesColumn({ slots, selection, onSelect }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const rules = useMazeStore((s) => s.rules);
  const removeCheck = useMazeStore((s) => s.removeCheck);
  const createRule = useMazeStore((s) => s.createRule);
  const toggleRuleDisabled = useMazeStore((s) => s.toggleRuleDisabled);
  const renameRule = useMazeStore((s) => s.renameRule);
  const removeRule = useMazeStore((s) => s.removeRule);
  const moveRule = useMazeStore((s) => s.moveRule);
  const [newRuleStep, setNewRuleStep] = useState<NewRuleStep>(null);
  const [strategyDialogRuleId, setStrategyDialogRuleId] = useState<string | null>(null);
  const [addToRuleId, setAddToRuleId] = useState<string | null>(null);
  const [noCandidatesAlertOpen, setNoCandidatesAlertOpen] = useState(false);
  const [removeConfirmRuleId, setRemoveConfirmRuleId] = useState<string | null>(null);
  const [renamingRuleId, setRenamingRuleId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [hoveredCheckId, setHoveredCheckId] = useState<string | null>(null);

  // Candidates to add into an existing rule: check types of the same issue kind. A type with
  // `allow_multiple_instances` (currently only `min_region_count`, see GitHub issue #60) is
  // always offered, including one already active elsewhere or in this same rule. Every other
  // type is filtered out once it's already active anywhere — adding a second instance of it
  // would be silently rejected by the store anyway (see `addCheck`), so it's not offered here.
  function candidatesFor(slot: StrategySlotVM): CheckCandidateVM[] {
    return availableChecks
      .filter((c) => c.issue_kinds[0] === slot.kind)
      .filter((c) => c.allow_multiple_instances || !isTypeAlreadyActive(rules, c.id))
      .map((c) => ({
        typeId: c.id,
        label: resolveCheckLabel(c.id, c.label),
        description: resolveCheckDescription(c.id, c.description),
        params: c.params,
      }));
  }

  function handleAddCheckClick(slot: StrategySlotVM) {
    if (candidatesFor(slot).length === 0) {
      setNoCandidatesAlertOpen(true);
    } else {
      setAddToRuleId(slot.ruleId);
    }
  }

  // Step 2 confirm: skip the strategy step entirely when no strategy handles this kind
  // (logging-only kinds), creating the rule right away with `strategyId: null`.
  function handleChecksNext(kind: string, checkIds: string[], paramOverrides: Record<string, Record<string, string>>) {
    if (availableStrategies.some((s) => s.handles === kind)) {
      setNewRuleStep({ stage: "strategy", kind, checkIds, paramOverrides });
    } else {
      createRule(checkIds, null, paramOverrides);
      setNewRuleStep(null);
    }
  }

  function startRename(slot: StrategySlotVM) {
    setRenamingRuleId(slot.ruleId);
    setRenameDraft(slot.name);
  }

  function commitRename() {
    if (renamingRuleId && renameDraft.trim()) {
      renameRule(renamingRuleId, renameDraft.trim());
    }
    setRenamingRuleId(null);
  }

  return (
    <div style={styles.strategiesColumn}>
      <div style={styles.columnBody}>
        {slots.map((slot, index) => {
          const strategySelected = (selection?.type === "strategy" || selection?.type === "logging") && selection.ruleId === slot.ruleId;
          const isRenaming = renamingRuleId === slot.ruleId;
          const isFirst = index === 0;
          const isLast = index === slots.length - 1;
          return (
            <div key={slot.ruleId} style={{ ...styles.ruleCard, ...(slot.ruleDisabled ? styles.ruleCardDisabled : {}) }}>
              <div style={styles.ruleCardTitle}>
                {isRenaming ? (
                  <input
                    style={styles.ruleCardTitleInput}
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingRuleId(null);
                    }}
                  />
                ) : (
                  <span style={styles.ruleCardTitleText}>
                    {slot.producedBy.length === 0 ? `${slot.name} (${slot.label})` : slot.name}
                  </span>
                )}
                <div style={styles.ruleCardTools}>
                  <button
                    style={{ ...styles.moveBtn, ...(isFirst ? styles.moveBtnDisabled : {}) }}
                    title={m["quality.move_rule_up"]()}
                    disabled={isFirst}
                    onClick={() => moveRule(slot.ruleId, "up")}
                  >
                    <ChevronUp size={16} color={colors.textDim} />
                  </button>
                  <button
                    style={{ ...styles.moveBtn, ...(isLast ? styles.moveBtnDisabled : {}) }}
                    title={m["quality.move_rule_down"]()}
                    disabled={isLast}
                    onClick={() => moveRule(slot.ruleId, "down")}
                  >
                    <ChevronDown size={16} color={colors.textDim} />
                  </button>
                  <div
                    style={styles.toggleWrap}
                    title={slot.ruleDisabled ? m["quality.enable_rule"]() : m["quality.disable_rule"]()}
                  >
                    <Switch checked={!slot.ruleDisabled} onChange={() => toggleRuleDisabled(slot.ruleId)} />
                  </div>
                  <button style={styles.editBtn} title={m["quality.rename_rule"]()} onClick={() => startRename(slot)}>✎</button>
                  <button
                    style={styles.removeBtn}
                    title={m["quality.remove_rule"]()}
                    onClick={() => setRemoveConfirmRuleId(slot.ruleId)}
                  >
                    <X size={18} color={colors.textDim} />
                  </button>
                </div>
              </div>
              <div style={styles.ruleCardBody}>
                <div style={styles.ruleChecksList}>
                  {slot.producedBy.map((check) => {
                    const checkSelected = selection?.type === "check" && selection.id === check.id;
                    return (
                      <RuleCheckRow
                        key={check.id}
                        check={check}
                        selected={checkSelected}
                        hovered={hoveredCheckId === check.id}
                        onSelect={() => onSelect({ type: "check", id: check.id })}
                        onRemove={() => {
                          if (checkSelected) onSelect(null);
                          removeCheck(check.ruleId, check.localId);
                        }}
                        onHoverChange={(h) => setHoveredCheckId(h ? check.id : null)}
                      />
                    );
                  })}
                  <div
                    style={styles.ruleAddCheckRow}
                    onClick={() => handleAddCheckClick(slot)}
                    title={m["quality.add_check"]()}
                  >{`+ ${m["quality.add_check"]()}`}</div>
                </div>
                <div style={styles.ruleCardDivider} />
                <RuleStrategyPanel
                  slot={slot}
                  selected={strategySelected}
                  onSelect={onSelect}
                  onEdit={() => setStrategyDialogRuleId(slot.ruleId)}
                />
              </div>
            </div>
          );
        })}
        {slots.length === 0 && (
          <span style={styles.emptyHint}>{m["status.no_checks"]()}</span>
        )}
        <button style={styles.addRuleBtn} onClick={() => setNewRuleStep({ stage: "issue" })}>
          {m["quality.add_new_rule"]()}
        </button>
      </div>
      {newRuleStep?.stage === "issue" && (
        <IssueSelectDialog
          onSelect={(kind) => setNewRuleStep({ stage: "checks", kind })}
          onClose={() => setNewRuleStep(null)}
        />
      )}
      {newRuleStep?.stage === "checks" && (
        <CheckSelectDialog
          kind={newRuleStep.kind}
          onBack={() => setNewRuleStep({ stage: "issue" })}
          onNext={(ids, paramOverrides) => handleChecksNext(newRuleStep.kind, ids, paramOverrides)}
          onClose={() => setNewRuleStep(null)}
        />
      )}
      {newRuleStep?.stage === "strategy" && (
        <NewRuleStrategyDialog
          kind={newRuleStep.kind}
          onBack={() => setNewRuleStep({ stage: "checks", kind: newRuleStep.kind })}
          onConfirm={(strategyId, params) => {
            createRule(newRuleStep.checkIds, strategyId, newRuleStep.paramOverrides, params);
            setNewRuleStep(null);
          }}
          onClose={() => setNewRuleStep(null)}
        />
      )}
      {strategyDialogRuleId !== null && (
        <StrategySelectDialog
          ruleId={strategyDialogRuleId}
          kind={slots.find((s) => s.ruleId === strategyDialogRuleId)?.kind ?? ""}
          onClose={() => setStrategyDialogRuleId(null)}
        />
      )}
      {addToRuleId !== null && (() => {
        const slot = slots.find((s) => s.ruleId === addToRuleId);
        if (!slot) return null;
        return (
          <AddCheckToRuleDialog
            ruleId={addToRuleId}
            kind={slot.kind}
            candidates={candidatesFor(slot)}
            onClose={() => setAddToRuleId(null)}
          />
        );
      })()}
      {noCandidatesAlertOpen && (
        <AlertModal message={m["quality.no_checks_for_kind"]()} onClose={() => setNoCandidatesAlertOpen(false)} />
      )}
      {removeConfirmRuleId !== null && (
        <ConfirmModal
          message={m["quality.confirm_remove_rule"]()}
          onConfirm={() => {
            if ((selection?.type === "strategy" || selection?.type === "logging") && selection.ruleId === removeConfirmRuleId) onSelect(null);
            removeRule(removeConfirmRuleId);
            setRemoveConfirmRuleId(null);
          }}
          onCancel={() => setRemoveConfirmRuleId(null)}
        />
      )}
    </div>
  );
}
