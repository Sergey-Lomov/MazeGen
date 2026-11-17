import { useEffect, useRef, useState } from "react";
import { PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragStartEvent, DragMoveEvent, DragEndEvent } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useMazeStore } from "../../../store/mazeStore";
import { setTooltipsSuppressed } from "../../Tooltip";
import type { StrategySlotVM, QualityStageVM } from "../useQualityViewModel";
import { initialPreview, movePreview, finalizeRuleDrop, resolveDrop, NEW_STAGE_START_ID, NEW_STAGE_END_ID, RULE_PREFIX } from "./qcDnd";
import type { PreviewLayout } from "./qcDnd";

/** Height of the strip at the list's top/bottom edge where the "new stage" drop zone appears. */
export const EDGE_ZONE_PX = 48;

// Drag-and-drop orchestration for the QC rules column (GitHub issue #39): drag state, the live
// cross-stage preview layout, edge "new stage" zone proximity, and the drop -> store action mapping.
// The pure placement rules live in `qcDnd.ts`; this hook only wires them to dnd-kit events.
export function useQualityDnd(stages: QualityStageVM[]) {
  const reorderRule = useMazeStore((s) => s.reorderRule);
  const moveRuleToNewStage = useMazeStore((s) => s.moveRuleToNewStage);
  const reorderStage = useMazeStore((s) => s.reorderStage);

  // `dragKind` drives the new-stage zones and the "no hover / no text cursor while dragging" styling.
  // `preview` is the live stageId -> ruleIds layout while a rule is dragged: moving the dragged rule
  // between stages in it makes the target stage's cards shift to show the drop slot.
  const [dragKind, setDragKind] = useState<"rule" | "stage" | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // The scrolling list body: the top "new stage" zone is only offered when it is scrolled to the top.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which outer edge of the list the pointer is near while a rule is dragged: the matching "new stage"
  // zone is revealed there.
  const [edge, setEdge] = useState<"top" | "bottom" | null>(null);
  // Floating label next to the dragged card (outside it) naming the edge zone being hovered.
  const [edgeTip, setEdgeTip] = useState<{ top: number; left: number } | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewLayout | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!dragKind) return;
    setTooltipsSuppressed(true);
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = prevCursor;
      setTooltipsSuppressed(false);
    };
  }, [dragKind]);

  const dndStages = stages.map((s) => ({ stageId: s.stageId, ruleIds: s.slots.map((sl) => sl.ruleId) }));
  const slotById = new Map(stages.flatMap((s) => s.slots).map((sl) => [sl.ruleId, sl]));

  // The stage's slots in drag-preview order (the real order when no rule is being dragged).
  function displaySlots(stage: QualityStageVM): StrategySlotVM[] {
    const ids = preview?.[stage.stageId];
    if (!ids) return stage.slots;
    return ids.map((id) => slotById.get(id)).filter((sl): sl is StrategySlotVM => sl !== undefined);
  }

  // The bottom zone sits in flow at the list's end (always laid out, hidden until approached): the
  // pointer is "near" it from `EDGE_ZONE_PX` above its top, while it is inside the visible panel.
  function nearEndZone(pointerY: number, box: DOMRect): boolean {
    const zone = columnRef.current?.querySelector(`[data-zone-id="${NEW_STAGE_END_ID}"]`);
    if (!zone) return false;
    const r = zone.getBoundingClientRect();
    return r.top < box.bottom && pointerY > r.top - EDGE_ZONE_PX && pointerY < r.bottom + 8;
  }

  function resetDrag() {
    setDragKind(null);
    setPreview(null);
    setActiveDragId(null);
    setEdge(null);
    setEdgeTip(null);
  }

  function handleDragStart(e: DragStartEvent) {
    const isRule = String(e.active.id).startsWith(RULE_PREFIX);
    setActiveDragId(String(e.active.id));
    setDragKind(isRule ? "rule" : "stage");
    setPreview(isRule ? initialPreview(dndStages) : null);
  }

  // Cross-stage live preview: hovering a rule inserts the dragged rule next to it, hovering a stage's
  // title/toolbar inserts it as the first slot, hovering an empty stage body inserts it there.
  function handleDragMove(e: DragMoveEvent) {
    const activeId = String(e.active.id);
    const pointerY = e.activatorEvent instanceof PointerEvent ? e.activatorEvent.clientY + e.delta.y : null;
    const box = columnRef.current?.getBoundingClientRect();
    if (activeId.startsWith(RULE_PREFIX) && pointerY !== null && box) {
      const atTop = (scrollRef.current?.scrollTop ?? 0) <= 1;
      const nextEdge = atTop && pointerY < box.top + EDGE_ZONE_PX ? "top" : nearEndZone(pointerY, box) ? "bottom" : null;
      setEdge(nextEdge);
      const card = e.active.rect.current.translated;
      setEdgeTip(nextEdge && card ? { top: nextEdge === "top" ? card.top + card.height + 6 : card.top - 6, left: box.left + 12 } : null);
    }
    if (!preview || !e.over || !activeId.startsWith(RULE_PREFIX)) return;
    // Upper half of a hovered card inserts above it, lower half below it (pointer-based).
    const translated = e.active.rect.current.translated;
    const y = pointerY ?? (translated ? translated.top + translated.height / 2 : e.over.rect.top);
    const below = y > e.over.rect.top + e.over.rect.height / 2;
    const next = movePreview(preview, activeId.slice(RULE_PREFIX.length), String(e.over.id), below);
    if (next) setPreview(next);
  }

  function handleDragEnd(e: DragEndEvent) {
    const finalPreview = preview;
    resetDrag();
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (finalPreview && activeId.startsWith(RULE_PREFIX) && overId && overId !== NEW_STAGE_START_ID && overId !== NEW_STAGE_END_ID) {
      const ruleId = activeId.slice(RULE_PREFIX.length);
      const drop = finalizeRuleDrop(finalPreview, ruleId, dndStages);
      if (drop) reorderRule(ruleId, drop.targetStageId, drop.index);
      return;
    }
    const action = resolveDrop(activeId, overId, dndStages);
    if (!action) return;
    if (action.type === "moveRuleToNewStage") moveRuleToNewStage(action.ruleId, action.position);
    else reorderStage(action.stageId, action.index);
  }

  return {
    sensors, columnRef, scrollRef, dragKind, edge, edgeTip, activeDragId, slotById, displaySlots,
    onDragStart: handleDragStart,
    onDragMove: handleDragMove,
    onDragEnd: handleDragEnd,
    onDragCancel: resetDrag,
  };
}
