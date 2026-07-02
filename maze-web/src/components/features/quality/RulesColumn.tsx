import { useState } from "react";
import { X, ChevronUp, ChevronDown, Plus, Pencil } from "lucide-react";
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
import { ui } from "../../../styles/theme";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { resolveCheckLabel, resolveCheckDescription } from "../qualityI18n";
import type { StrategySlotVM, QualityStageVM } from "../useQualityViewModel";
import type { CheckCandidateVM } from "../AddCheckToRuleDialog";
import type { QualitySelection } from "./types";
import { isTypeAlreadyActive } from "../../../store/slices/generationSlice";

// Three-step "Add new rule" flow: pick an issue kind, then checks of that kind (multiselect),
// then a fix strategy for the new rule — nothing commits to the store until step 3 confirms
// (see `createRule`). Step 3 is skipped when no strategy handles the kind (logging-only kinds).
// `targetStageId` carries which stage's "+ Add rule" toolbar button started the flow — threaded
// through every step so the rule created at the end lands in that stage, not always the last one.
type NewRuleStep =
  | { stage: "issue"; targetStageId: string }
  | { stage: "checks"; kind: string; targetStageId: string }
  | { stage: "strategy"; kind: string; checkIds: string[]; paramOverrides: Record<string, Record<string, string>>; targetStageId: string }
  | null;

interface Props {
  stages: QualityStageVM[];
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

// One card per rule, split left/right: checks on the left, fix strategy (+ its params, inline,
// the same as generation method params) on the right. Split rather than stacked so disabling/
// configuring the fix reads as independent from the checks — the checks still run regardless of
// whether their rule's fix is enabled. The card title row carries whole-rule tools (toggle,
// rename, remove), distinct from the strategy-only toggle in the right half. Cards are grouped
// under stage sections (see GitHub issue #65) — `▲`/`▼` on a rule card move it in the combined
// stage-then-rule order, crossing stage boundaries when at one stage's own edge.
export function RulesColumn({ stages, selection, onSelect }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);
  const availableStrategies = useMazeStore((s) => s.availableStrategies);
  const rules = useMazeStore((s) => s.rules);
  const removeCheck = useMazeStore((s) => s.removeCheck);
  const createRule = useMazeStore((s) => s.createRule);
  const toggleRuleDisabled = useMazeStore((s) => s.toggleRuleDisabled);
  const renameRule = useMazeStore((s) => s.renameRule);
  const removeRule = useMazeStore((s) => s.removeRule);
  const moveRule = useMazeStore((s) => s.moveRule);
  const addStage = useMazeStore((s) => s.addStage);
  const renameStage = useMazeStore((s) => s.renameStage);
  const removeStage = useMazeStore((s) => s.removeStage);
  const moveStage = useMazeStore((s) => s.moveStage);
  const toggleStageDisabled = useMazeStore((s) => s.toggleStageDisabled);
  const [newRuleStep, setNewRuleStep] = useState<NewRuleStep>(null);
  const [strategyDialogRuleId, setStrategyDialogRuleId] = useState<string | null>(null);
  const [addToRuleId, setAddToRuleId] = useState<string | null>(null);
  const [noCandidatesAlertOpen, setNoCandidatesAlertOpen] = useState(false);
  const [removeConfirmRuleId, setRemoveConfirmRuleId] = useState<string | null>(null);
  const [renamingRuleId, setRenamingRuleId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingStageId, setRenamingStageId] = useState<string | null>(null);
  const [renameStageDraft, setRenameStageDraft] = useState("");
  const [removeConfirmStageId, setRemoveConfirmStageId] = useState<string | null>(null);
  const [hoveredCheckId, setHoveredCheckId] = useState<string | null>(null);

  const slots = stages.flatMap((s) => s.slots);

  // Candidates to add into an existing rule: check types of the same issue kind. A type with
  // `allow_multiple_instances` (none currently — see GitHub issue #60, retired) would always be
  // offered, including one already active elsewhere or in this same rule. Every other type is
  // filtered out once it's already active anywhere — adding a second instance of it would be
  // silently rejected by the store anyway (see `addCheck`), so it's not offered here.
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
  function handleChecksNext(kind: string, checkIds: string[], paramOverrides: Record<string, Record<string, string>>, targetStageId: string) {
    if (availableStrategies.some((s) => s.handles === kind)) {
      setNewRuleStep({ stage: "strategy", kind, checkIds, paramOverrides, targetStageId });
    } else {
      createRule(checkIds, null, paramOverrides, undefined, targetStageId);
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

  function startRenameStage(stage: QualityStageVM) {
    setRenamingStageId(stage.stageId);
    setRenameStageDraft(stage.name);
  }

  function commitRenameStage() {
    if (renamingStageId && renameStageDraft.trim()) {
      renameStage(renamingStageId, renameStageDraft.trim());
    }
    setRenamingStageId(null);
  }

  return (
    <div style={styles.strategiesColumn}>
      <div style={styles.columnBody}>
        {stages.map((stage, stageIndex) => {
          const isRenamingStage = renamingStageId === stage.stageId;
          const isFirstStage = stageIndex === 0;
          const isLastStage = stageIndex === stages.length - 1;
          return (
            <div key={stage.stageId} style={{ ...styles.stageSection, ...(stage.disabled ? styles.stageSectionDisabled : {}) }}>
              <div style={styles.stageHeader}>
                {isRenamingStage ? (
                  <input
                    style={styles.stageHeaderInput}
                    value={renameStageDraft}
                    autoFocus
                    onChange={(e) => setRenameStageDraft(e.target.value)}
                    onBlur={commitRenameStage}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRenameStage();
                      if (e.key === "Escape") setRenamingStageId(null);
                    }}
                  />
                ) : (
                  <span style={styles.stageHeaderText}>{stage.name}</span>
                )}
              </div>
              <div style={styles.stageToolbar}>
                <button
                  style={styles.stageToolbarBtn}
                  title={m["quality.add_new_rule"]()}
                  onClick={() => setNewRuleStep({ stage: "issue", targetStageId: stage.stageId })}
                >
                  <Plus size={16} color={ui.text.tertiary} />
                </button>
                <button
                  style={{ ...styles.stageToolbarBtn, ...(isFirstStage ? styles.stageToolbarBtnDisabled : {}) }}
                  title={m["quality.move_stage_up"]()}
                  disabled={isFirstStage}
                  onClick={() => moveStage(stage.stageId, "up")}
                >
                  <ChevronUp size={16} color={ui.text.tertiary} />
                </button>
                <button
                  style={{ ...styles.stageToolbarBtn, ...(isLastStage ? styles.stageToolbarBtnDisabled : {}) }}
                  title={m["quality.move_stage_down"]()}
                  disabled={isLastStage}
                  onClick={() => moveStage(stage.stageId, "down")}
                >
                  <ChevronDown size={16} color={ui.text.tertiary} />
                </button>
                <button style={styles.stageToolbarBtn} title={m["quality.rename_stage"]()} onClick={() => startRenameStage(stage)}>
                  <Pencil size={15} color={ui.text.tertiary} />
                </button>
                <div
                  style={styles.toggleWrap}
                  title={stage.disabled ? m["quality.enable_stage"]() : m["quality.disable_stage"]()}
                >
                  <Switch checked={!stage.disabled} onChange={() => toggleStageDisabled(stage.stageId)} />
                </div>
                <button
                  style={styles.stageToolbarBtn}
                  title={m["quality.remove_stage"]()}
                  onClick={() => setRemoveConfirmStageId(stage.stageId)}
                >
                  <X size={16} color={ui.text.tertiary} />
                </button>
              </div>
              <div style={styles.stageCards}>
                {stage.slots.map((slot, ruleIndex) => {
                  const strategySelected = (selection?.type === "strategy" || selection?.type === "logging") && selection.ruleId === slot.ruleId;
                  const isRenaming = renamingRuleId === slot.ruleId;
                  // Global boundary — no stage above/below to cross into, regardless of whether
                  // intervening stages happen to be empty (an empty stage is still a valid
                  // crossing target for `moveRule`, so it must not count as "no neighbor").
                  const isFirst = isFirstStage && ruleIndex === 0;
                  const isLast = isLastStage && ruleIndex === stage.slots.length - 1;
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
                            <ChevronUp size={16} color={ui.text.tertiary} />
                          </button>
                          <button
                            style={{ ...styles.moveBtn, ...(isLast ? styles.moveBtnDisabled : {}) }}
                            title={m["quality.move_rule_down"]()}
                            disabled={isLast}
                            onClick={() => moveRule(slot.ruleId, "down")}
                          >
                            <ChevronDown size={16} color={ui.text.tertiary} />
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
                            <X size={18} color={ui.text.tertiary} />
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
                {stage.slots.length === 0 && (
                  <span style={styles.stageEmptyHint}>{m["status.stage_empty"]()}</span>
                )}
              </div>
            </div>
          );
        })}
        {slots.length === 0 && (
          <span style={styles.emptyHint}>{m["status.no_checks"]()}</span>
        )}
        <button style={styles.addStageBtn} onClick={() => addStage()}>
          {m["quality.add_stage"]()}
        </button>
      </div>
      {newRuleStep?.stage === "issue" && (
        <IssueSelectDialog
          onSelect={(kind) => setNewRuleStep({ stage: "checks", kind, targetStageId: newRuleStep.targetStageId })}
          onClose={() => setNewRuleStep(null)}
        />
      )}
      {newRuleStep?.stage === "checks" && (
        <CheckSelectDialog
          kind={newRuleStep.kind}
          onBack={() => setNewRuleStep({ stage: "issue", targetStageId: newRuleStep.targetStageId })}
          onNext={(ids, paramOverrides) => handleChecksNext(newRuleStep.kind, ids, paramOverrides, newRuleStep.targetStageId)}
          onClose={() => setNewRuleStep(null)}
        />
      )}
      {newRuleStep?.stage === "strategy" && (
        <NewRuleStrategyDialog
          kind={newRuleStep.kind}
          onBack={() => setNewRuleStep({ stage: "checks", kind: newRuleStep.kind, targetStageId: newRuleStep.targetStageId })}
          onConfirm={(strategyId, params) => {
            createRule(newRuleStep.checkIds, strategyId, newRuleStep.paramOverrides, params, newRuleStep.targetStageId);
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
      {removeConfirmStageId !== null && (() => {
        const stage = stages.find((s) => s.stageId === removeConfirmStageId);
        const hasRules = (stage?.slots.length ?? 0) > 0;
        return (
          <ConfirmModal
            message={hasRules ? m["quality.confirm_remove_stage_with_rules"]() : m["quality.confirm_remove_stage"]()}
            onConfirm={() => {
              if ((selection?.type === "strategy" || selection?.type === "logging") && stage?.slots.some((s) => s.ruleId === selection.ruleId)) onSelect(null);
              removeStage(removeConfirmStageId);
              setRemoveConfirmStageId(null);
            }}
            onCancel={() => setRemoveConfirmStageId(null)}
          />
        );
      })()}
    </div>
  );
}
