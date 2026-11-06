import { useState } from "react";
import type { ReactNode } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { X, GripVertical, ChevronUp, ChevronDown, Plus } from "lucide-react";
import { useMazeStore } from "../../../store/mazeStore";
import { CollapseButton } from "../../CollapseButton";
import { CheckSelectDialog } from "../CheckSelectDialog";
import { IssueSelectDialog } from "../IssueSelectDialog";
import { NewRuleStrategyDialog } from "../NewRuleStrategyDialog";
import { StrategySelectDialog } from "../StrategySelectDialog";
import { AddCheckToRuleDialog } from "../AddCheckToRuleDialog";
import { RuleStrategyPanel } from "./RuleStrategyPanel";
import { RuleCheckRow } from "./RuleCheckRow";
import { RuleParamsSection } from "./RuleParamsSection";
import { QcSortable, StageHead, NewStageZone, qcCollisionDetection, lockVerticalAxis } from "./QcSortable";
import { useQualityDnd, EDGE_ZONE_PX } from "./useQualityDnd";
import { ruleDndId, stageDndId, stageHeadDndId, NEW_STAGE_START_ID, NEW_STAGE_END_ID, RULE_PREFIX } from "./qcDnd";
import { ConfirmModal } from "../../ConfirmModal";
import { Tooltip } from "../../Tooltip";
import { Switch } from "../../Switch";
import { RemoveIconButton } from "../../RemoveIconButton";
import { EditIconButton } from "../../EditIconButton";
import { ui, spacing } from "../../../styles/theme";
import { Button } from "../../Button";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles } from "./qualityCanvasStyles";
import { resolveCheckLabel, resolveCheckDescription } from "../qualityI18n";
import type { StrategySlotVM, QualityStageVM, CheckVM } from "../useQualityViewModel";
import type { CheckCandidateVM } from "../AddCheckToRuleDialog";
import type { QualitySelection } from "./types";
import { isEntityVisible } from "../ParamFields";

// Height of the bottom "new stage" drop zone strip (the top one is `EDGE_ZONE_PX` high, see `useQualityDnd`).
const BOTTOM_ZONE_PX = 36;
// Distance between consecutive stages: column gap + the stage section's own top margin.
const STAGE_GAP_PX = spacing.itemGap * 2;

// Three-step "Add new rule" flow: pick an issue kind, then a check of that kind,
// then a fix strategy for the new rule — nothing commits to the store until step 3 confirms
// (see `createRule`). Step 3 is skipped when no strategy handles the kind (logging-only kinds).
// `targetStageId` carries which stage's "+ Add rule" toolbar button started the flow — threaded
// through every step so the rule created at the end lands in that stage, not always the last one.
type NewRuleStep =
  | { stage: "issue"; targetStageId: string }
  | { stage: "checks"; kind: string; targetStageId: string }
  | { stage: "strategy"; kind: string; checkIds: string[]; paramOverrides: Record<string, Record<string, string>>; targetStageId: string }
  | null;

// True when `selection` refers to something inside `ruleId` — every `QualitySelection` variant
// can be scoped to a rule (`check` via its composite id's owning check, `param` via its `owner`,
// the rest via their own `ruleId` field directly), so a caller clearing selection on rule removal
// must check all of them, not just the ones it happened to think of first (`"nested_strategy"` was
// originally missed here, along with `"check"` — both left a selection dangling on a since-removed
// rule).
function selectionBelongsToRule(selection: QualitySelection, ruleId: string, checks: CheckVM[]): boolean {
  if (!selection) return false;
  if (selection.type === "check") return checks.some((c) => c.id === selection.id && c.ruleId === ruleId);
  if (selection.type === "param") {
    const owner = selection.owner;
    if (owner.kind === "check") return checks.some((c) => c.id === owner.checkId && c.ruleId === ruleId);
    return owner.ruleId === ruleId;
  }
  return selection.ruleId === ruleId;
}

// "+ Add check" row. With nothing addable it is disabled (focusable via the Tooltip wrapper) and
// explains why instead of opening an empty picker (GitHub issue #772).
function AddCheckRow({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip block content={disabled ? m["quality.no_checks_for_kind"]() : m["quality.add_check"]()}>
      <div
        className={disabled ? undefined : "hoverable"}
        style={disabled ? { ...styles.ruleAddCheckRow, opacity: 0.4 } : styles.ruleAddCheckRow}
        role="button"
        tabIndex={disabled ? undefined : 0}
        aria-disabled={disabled}
        onClick={onClick}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onClick();
          }
        }}
      >{`+ ${m["quality.add_check"]()}`}</div>
    </Tooltip>
  );
}

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
  const floorCount = useMazeStore((s) => s.floors.length);
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
  const toggleStageCollapsed = useMazeStore((s) => s.toggleStageCollapsed);
  const toggleRuleCollapsed = useMazeStore((s) => s.toggleRuleCollapsed);
  const [newRuleStep, setNewRuleStep] = useState<NewRuleStep>(null);
  const [strategyDialogRuleId, setStrategyDialogRuleId] = useState<string | null>(null);
  const [addToRuleId, setAddToRuleId] = useState<string | null>(null);
  const [removeConfirmRuleId, setRemoveConfirmRuleId] = useState<string | null>(null);
  const [renamingRuleId, setRenamingRuleId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingStageId, setRenamingStageId] = useState<string | null>(null);
  const [renameStageDraft, setRenameStageDraft] = useState("");
  const [removeConfirmStageId, setRemoveConfirmStageId] = useState<string | null>(null);
  const [hoveredCheckId, setHoveredCheckId] = useState<string | null>(null);

  const slots = stages.flatMap((s) => s.slots);

  const {
    sensors, columnRef, scrollRef, dragKind, edge, edgeTip, activeDragId, slotById, displaySlots,
    onDragStart, onDragMove, onDragEnd, onDragCancel,
  } = useQualityDnd(stages);

  // One full rule card. Shared by the list (with the sortable grip) and the drag overlay.
  function renderRuleCard(slot: StrategySlotVM, ruleHandle: ReactNode, isFirst: boolean, isLast: boolean) {
    const strategySelected = (selection?.type === "strategy" || selection?.type === "logging") && selection.ruleId === slot.ruleId;
    const isRenaming = renamingRuleId === slot.ruleId;
    return (
    <div style={{ ...styles.ruleCard, ...(slot.ruleDisabled ? styles.ruleCardDisabled : {}) }}>
      <div style={styles.ruleCardTitle}>
        {ruleHandle}
        <CollapseButton
          collapsed={slot.collapsed}
          onToggle={() => toggleRuleCollapsed(slot.ruleId)}
          collapseTitle={m["quality.collapse_rule"]()}
          expandTitle={m["quality.expand_rule"]()}
          style={styles.collapseBtn}
        />
        {isRenaming ? (
          <input
            style={styles.ruleCardTitleInput}
            name="quality-rule-title"
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
            {slot.name === slot.label ? slot.name : `${slot.name} (${slot.label})`}
          </span>
        )}
        <div style={styles.ruleCardTools}>
          <Tooltip content={m["quality.move_rule_up"]()}><button
            className={isFirst ? undefined : "hoverable"}
            style={{ ...styles.moveBtn, ...(isFirst ? styles.moveBtnDisabled : {}) }}
            disabled={isFirst}
            onClick={() => moveRule(slot.ruleId, "up")}
          >
            <ChevronUp size={16} color={ui.text.tertiary} />
          </button></Tooltip>
          <Tooltip content={m["quality.move_rule_down"]()}><button
            className={isLast ? undefined : "hoverable"}
            style={{ ...styles.moveBtn, ...(isLast ? styles.moveBtnDisabled : {}) }}
            disabled={isLast}
            onClick={() => moveRule(slot.ruleId, "down")}
          >
            <ChevronDown size={16} color={ui.text.tertiary} />
          </button></Tooltip>
          <Tooltip content={slot.ruleDisabled ? m["quality.enable_rule"]() : m["quality.disable_rule"]()}><div
            style={styles.toggleWrap}
          >
            <Switch checked={!slot.ruleDisabled} onChange={() => toggleRuleDisabled(slot.ruleId)} />
          </div></Tooltip>
          <EditIconButton title={m["quality.rename_rule"]()} onClick={() => startRename(slot)} />
          <RemoveIconButton title={m["quality.remove_rule"]()} onClick={() => setRemoveConfirmRuleId(slot.ruleId)} />
        </div>
      </div>
      {!slot.collapsed && (
      <>
      <RuleParamsSection slot={slot} selection={selection} onSelectParam={onSelect} />
      <div style={styles.ruleCardBody}>
        <div style={styles.ruleChecksList}>
          {slot.producedBy.map((check) => {
            const checkSelected = selection?.type === "check" && selection.id === check.id;
            // A selected param owned by this check also needs clearing on removal
            // — same dangling-selection risk `selectionBelongsToRule` guards against
            // for whole-rule removal, just scoped to one check instead.
            const checkParamSelected = selection?.type === "param" && selection.owner.kind === "check" && selection.owner.checkId === check.id;
            return (
              <RuleCheckRow
                key={check.id}
                check={check}
                selected={checkSelected}
                selection={selection}
                hovered={hoveredCheckId === check.id}
                onSelect={() => onSelect({ type: "check", id: check.id })}
                onSelectParam={onSelect}
                onRemove={() => {
                  if (checkSelected || checkParamSelected) onSelect(null);
                  removeCheck(check.ruleId, check.localId);
                }}
                onHoverChange={(h) => setHoveredCheckId(h ? check.id : null)}
              />
            );
          })}
          <AddCheckRow
            disabled={!hasCandidates(slot)}
            onClick={() => handleAddCheckClick(slot)}
          />
        </div>
        <div style={styles.ruleCardDivider} />
        <RuleStrategyPanel
          slot={slot}
          selected={strategySelected}
          selection={selection}
          onSelect={onSelect}
          onEdit={() => setStrategyDialogRuleId(slot.ruleId)}
        />
      </div>
      </>
      )}
    </div>
    );
  }

  // Compact stand-in for the dragged item: always follows the pointer, while the original node
  // stays in the list as the placeholder for the drop slot.
  function renderDragOverlay() {
    if (!activeDragId) return null;
    if (activeDragId.startsWith(RULE_PREFIX)) {
      const slot = slotById.get(activeDragId.slice(RULE_PREFIX.length));
      if (!slot) return null;
      return (
        <div style={{ cursor: "grabbing", boxShadow: "0 4px 14px rgba(0,0,0,0.35)" }}>
          {renderRuleCard({ ...slot, collapsed: true }, <GripVertical size={16} color={ui.text.tertiary} />, false, false)}
        </div>
      );
    }
    const stage = stages.find((st) => stageDndId(st.stageId) === activeDragId);
    if (!stage) return null;
    return (
      <div style={{ ...styles.ruleCard, boxShadow: "0 4px 14px rgba(0,0,0,0.35)", cursor: "grabbing" }}>
        <div style={{ ...styles.stageHeader, padding: "7px 10px" }}>
          <GripVertical size={16} color={ui.text.tertiary} />
          <span style={styles.stageHeaderText}>{stage.name}</span>
        </div>
      </div>
    );
  }

  // Candidates to add into an existing rule: check types of the same issue kind. A type with
  // `multiple instances` (none currently — see GitHub issue #60, retired) would always be
  // offered, including one already active elsewhere or in this same rule. Every other type is
  // filtered out once it's already active anywhere — adding a second instance of it would be
  // silently rejected by the store anyway (see `addCheck`), so it's not offered here.
  function candidatesFor(slot: StrategySlotVM): CheckCandidateVM[] {
    return availableChecks
      .filter((c) => c.issue_kinds[0] === slot.kind)
      .filter((c) => isEntityVisible(c.visibility, floorCount))
      .map((c) => ({
        typeId: c.id,
        label: resolveCheckLabel(c.id, c.label),
        description: resolveCheckDescription(c.id, c.description),
        params: c.params,
      }));
  }

  // Cheap existence check for render: avoids mapping every candidate just to learn there are none.
  function hasCandidates(slot: StrategySlotVM): boolean {
    return availableChecks.some((c) => c.issue_kinds[0] === slot.kind && isEntityVisible(c.visibility, floorCount));
  }

  function handleAddCheckClick(slot: StrategySlotVM) {
    if (hasCandidates(slot)) setAddToRuleId(slot.ruleId);
  }

  // Step 2 confirm: skip the strategy step entirely when no strategy handles this kind
  // (logging-only kinds), creating the rule right away with `strategyId: null`.
  function handleChecksNext(kind: string, checkId: string, paramOverrides: Record<string, Record<string, string>>, targetStageId: string) {
    if (availableStrategies.some((s) => s.handles === kind)) {
      setNewRuleStep({ stage: "strategy", kind, checkIds: [checkId], paramOverrides, targetStageId });
    } else {
      createRule([checkId], null, paramOverrides, undefined, targetStageId);
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
    <div ref={columnRef} style={{ ...styles.strategiesColumn, position: "relative" }}>
      <DndContext
        sensors={sensors}
        collisionDetection={qcCollisionDetection}
        modifiers={[lockVerticalAxis]}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
      <div ref={scrollRef} style={{ ...styles.columnBody, overflowAnchor: "none", ...(dragKind ? { pointerEvents: "none", userSelect: "none" } : {}) }}>
        <SortableContext items={stages.map((s) => stageDndId(s.stageId))} strategy={verticalListSortingStrategy}>
        {stages.map((stage, stageIndex) => {
          const isRenamingStage = renamingStageId === stage.stageId;
          const isFirstStage = stageIndex === 0;
          const isLastStage = stageIndex === stages.length - 1;
          return (
            <QcSortable key={stage.stageId} id={stageDndId(stage.stageId)} title={m["quality.drag_stage"]()}>
            {({ handle: stageHandle }) => (
            <div style={{ ...styles.stageSection, ...(stage.disabled ? styles.stageSectionDisabled : {}) }}>
              <StageHead id={stageHeadDndId(stage.stageId)}>
              <div style={styles.stageHeader}>
                {stageHandle}
                {isRenamingStage ? (
                  <input
                    style={styles.stageHeaderInput}
                    name="quality-stage-title"
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
                <CollapseButton
                  collapsed={stage.collapsed}
                  onToggle={() => toggleStageCollapsed(stage.stageId)}
                  collapseTitle={m["quality.collapse_stage"]()}
                  expandTitle={m["quality.expand_stage"]()}
                  style={styles.collapseBtn}
                />
                <Tooltip content={m["quality.add_new_rule"]()}><button
                  className="hoverable"
                  style={styles.stageToolbarBtn}
                  onClick={() => setNewRuleStep({ stage: "issue", targetStageId: stage.stageId })}
                >
                  <Plus size={16} color={ui.text.tertiary} strokeWidth={2.5} />
                </button></Tooltip>
                <Tooltip content={m["quality.move_stage_up"]()}><button
                  className={isFirstStage ? undefined : "hoverable"}
                  style={{ ...styles.stageToolbarBtn, ...(isFirstStage ? styles.stageToolbarBtnDisabled : {}) }}
                  disabled={isFirstStage}
                  onClick={() => moveStage(stage.stageId, "up")}
                >
                  <ChevronUp size={16} color={ui.text.tertiary} strokeWidth={2.5} />
                </button></Tooltip>
                <Tooltip content={m["quality.move_stage_down"]()}><button
                  className={isLastStage ? undefined : "hoverable"}
                  style={{ ...styles.stageToolbarBtn, ...(isLastStage ? styles.stageToolbarBtnDisabled : {}) }}
                  disabled={isLastStage}
                  onClick={() => moveStage(stage.stageId, "down")}
                >
                  <ChevronDown size={16} color={ui.text.tertiary} strokeWidth={2.5} />
                </button></Tooltip>
                <Tooltip content={m["quality.rename_stage"]()}><button className="hoverable" style={{ ...styles.stageToolbarBtn, fontSize: 16 }} onClick={() => startRenameStage(stage)}>✎</button></Tooltip>
                <Tooltip content={stage.disabled ? m["quality.enable_stage"]() : m["quality.disable_stage"]()}><div
                  style={styles.toggleWrap}
                >
                  <Switch checked={!stage.disabled} onChange={() => toggleStageDisabled(stage.stageId)} />
                </div></Tooltip>
                <Tooltip content={m["quality.remove_stage"]()}><button
                  className="hoverable"
                  style={styles.stageToolbarBtn}
                  onClick={() => setRemoveConfirmStageId(stage.stageId)}
                >
                  <X size={16} color={ui.text.tertiary} strokeWidth={2.5} />
                </button></Tooltip>
              </div>
              </StageHead>
              {!stage.collapsed && (
              <div style={styles.stageCards}>
                <SortableContext items={displaySlots(stage).map((sl) => ruleDndId(sl.ruleId))} strategy={() => null}>
                {displaySlots(stage).map((slot, ruleIndex) => {
                  // Global boundary — no stage above/below to cross into, regardless of whether
                  // intervening stages happen to be empty (an empty stage is still a valid
                  // crossing target for `moveRule`, so it must not count as "no neighbor").
                  const isFirst = isFirstStage && ruleIndex === 0;
                  const isLast = isLastStage && ruleIndex === displaySlots(stage).length - 1;
                  return (
                    <QcSortable key={slot.ruleId} id={ruleDndId(slot.ruleId)} title={m["quality.drag_rule"]()}>
                    {({ handle: ruleHandle, isDragging }) => renderRuleCard(isDragging ? { ...slot, collapsed: true } : slot, ruleHandle, isFirst, isLast)}
                    </QcSortable>
                  );
                })}
                </SortableContext>
                {displaySlots(stage).length === 0 && (
                  <span style={styles.stageEmptyHint}>{m["status.stage_empty"]()}</span>
                )}
              </div>
              )}
            </div>
            )}
            </QcSortable>
          );
        })}
        </SortableContext>
        {slots.length === 0 && (
          <span style={styles.emptyHint}>{m["status.no_checks"]()}</span>
        )}
        {/* Bottom "new stage" zone: its droppable is always laid out at the list end (zero-height
            wrapper, so the rect is measured at drag start), hidden until approached; the wrapper only
            grows to make room, pushing the add-stage button down, once the pointer is near. */}
        <div style={{ position: "relative", height: edge === "bottom" ? STAGE_GAP_PX + BOTTOM_ZONE_PX : 0, marginTop: -spacing.itemGap, flexShrink: 0 }}>
          <NewStageZone
            id={NEW_STAGE_END_ID}
            label=""
            active={dragKind === "rule"}
            hidden={edge !== "bottom"}
            style={{ position: "absolute", top: STAGE_GAP_PX, left: 0, right: 0, height: BOTTOM_ZONE_PX }}
          />
        </div>
        <Button variant="primary" layoutStyle={styles.addStageBtn} onClick={() => addStage()}>
            {m["quality.add_stage"]()}
          </Button>
      </div>
      <NewStageZone
        id={NEW_STAGE_START_ID}
        label=""
        active={dragKind === "rule"}
        hidden={edge !== "top"}
        style={{ position: "absolute", top: 4, left: 8, right: 8, height: EDGE_ZONE_PX - 8, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "center" }}
      />
      {edge && edgeTip && (
        <div style={{
          position: "fixed", top: edgeTip.top, left: edgeTip.left, zIndex: 1000, pointerEvents: "none",
          transform: edge === "bottom" ? "translateY(-100%)" : undefined,
          background: ui.bg.panel, border: `1px solid ${ui.border.default}`, borderRadius: 6,
          padding: "4px 10px", fontSize: 12, color: ui.text.secondary, boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        }}>
          {edge === "top" ? m["quality.drop_new_stage_top"]() : m["quality.drop_new_stage_bottom"]()}
        </div>
      )}
      <DragOverlay dropAnimation={null}>{renderDragOverlay()}</DragOverlay>
      </DndContext>
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
          onNext={(id, paramOverrides) => handleChecksNext(newRuleStep.kind, id, paramOverrides, newRuleStep.targetStageId)}
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
      {removeConfirmRuleId !== null && (
        <ConfirmModal
          message={m["quality.confirm_remove_rule"]()}
          onConfirm={() => {
            const removedSlot = slots.find((s) => s.ruleId === removeConfirmRuleId);
            if (selectionBelongsToRule(selection, removeConfirmRuleId, removedSlot?.producedBy ?? [])) onSelect(null);
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
              if (stage?.slots.some((s) => selectionBelongsToRule(selection, s.ruleId, s.producedBy))) onSelect(null);
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
