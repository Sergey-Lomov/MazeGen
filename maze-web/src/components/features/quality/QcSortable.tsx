import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { useDroppable, pointerWithin, closestCenter } from "@dnd-kit/core";
import type { CollisionDetection, Modifier } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ui, spacing } from "../../../styles/theme";
import { RULE_PREFIX, STAGE_PREFIX, STAGE_HEAD_PREFIX, NEW_STAGE_START_ID, NEW_STAGE_END_ID } from "./qcDnd";

export interface DragHandleProps {
  handle: ReactNode;
  isDragging: boolean;
}

// Wraps one rule card or stage section as a sortable item; `children` receives the grip `handle`
// element to place inside the item (only the grip starts a drag, so buttons/inputs stay usable).
export function QcSortable({ id, title, children }: {
  id: string;
  title: string;
  children: (p: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useSortable({ id, animateLayoutChanges: () => false });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    ...(isDragging ? { border: `2px dashed ${ui.border.default}`, borderRadius: 6, boxSizing: "border-box" as const } : {}),
  };
  // dnd-kit re-renders every sortable on each pointer move (its context changes), but `children` only
  // changes when the parent re-renders: memoizing keeps a long list of large rule cards from being
  // re-rendered in full on every mouse move during a drag.
  const content = useMemo(() => {
    const handle = (
      <button
        ref={setActivatorNodeRef}
        className="hoverable"
        aria-label={title}
        title={title}
        style={{ background: "none", border: "none", padding: 0, display: "flex", alignItems: "center", cursor: "grab", flexShrink: 0, touchAction: "none" }}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} color={ui.text.tertiary} />
      </button>
    );
    return children({ handle, isDragging });
  }, [children, isDragging, title, attributes, listeners, setActivatorNodeRef]);
  // While dragged, the original node stays in the list as an empty placeholder marking the drop slot;
  // the item under the pointer is rendered by the `DragOverlay` in RulesColumn.
  return (
    <div ref={setNodeRef} style={style}>
      <div style={isDragging ? { visibility: "hidden" } : undefined}>{content}</div>
    </div>
  );
}

// Stage title + toolbar area: hovering it while dragging a rule means "drop into this stage's
// first slot" (see `RulesColumn.handleDragOver`).
export function StageHead({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef} style={{ display: "flex", flexDirection: "column", gap: spacing.itemGap }}>{children}</div>;
}

// Outer drop zone above the first / below the last stage: dropping a rule here creates a new stage.
export function NewStageZone({ id, label, active, hidden, style }: { id: string; label: string; active: boolean; hidden?: boolean; style?: CSSProperties }) {
  const { setNodeRef } = useDroppable({ id });
  if (!active) return null;
  return (
    <div
      ref={setNodeRef}
      data-zone-id={id}
      style={{
        visibility: hidden ? "hidden" : undefined,
        border: `2px dashed ${ui.border.default}`,
        borderRadius: 6,
        padding: "10px 8px",
        textAlign: "center",
        fontSize: 12,
        color: ui.text.tertiary,
        background: ui.bg.panel,
        boxSizing: "border-box",
        ...style,
      }}
    >{label}</div>
  );
}

// Rule drag: pointer-hit rules / new-stage zones win over the (large) stage containers, which are
// the fallback (empty stage, header area). Stage drag: only stage containers are candidates.
export const qcCollisionDetection: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  if (activeId.startsWith(STAGE_PREFIX)) {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith(STAGE_PREFIX) || c.id === NEW_STAGE_START_ID || c.id === NEW_STAGE_END_ID),
    });
  }
  const hits = pointerWithin(args);
  const fine = hits.filter((c) => String(c.id).startsWith(RULE_PREFIX) || String(c.id).startsWith(STAGE_HEAD_PREFIX) || c.id === NEW_STAGE_START_ID || c.id === NEW_STAGE_END_ID);
  // A "new stage" zone under the pointer beats rules/headers it overlaps.
  const zone = fine.filter((c) => c.id === NEW_STAGE_START_ID || c.id === NEW_STAGE_END_ID);
  if (zone.length > 0) return zone;
  if (fine.length > 0) return fine;
  if (hits.length > 0) return hits;
  return closestCenter(args);
};

// Locks dragging to the vertical axis so moving the pointer sideways never pushes the dragged
// item past the column edge and grows a horizontal scrollbar.
export const lockVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
