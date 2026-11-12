import type React from "react";
import { radius, spacing, typography, ui } from "../styles/theme";
import { Tooltip } from "./Tooltip";

export interface ListCellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Text of the title row. Omitted for a cell that is only a details row. */
  title?: React.ReactNode;
  /** Cuts a long title with an ellipsis instead of wrapping it. */
  truncateTitle?: boolean;
  /** Next to the title, before the badge (e.g. a colour dot). */
  titleAddon?: React.ReactNode;
  /** Pinned to the right of the title row (an `IdBubble`). */
  badge?: React.ReactNode;
  /** The row under the title. The caller gives it its own sizing (e.g. `flex: 1`); the actions sit
   *  at its right edge when they are in the details row. */
  details?: React.ReactNode;
  /** Buttons of the cell (`ListCellAction`). */
  actions?: React.ReactNode;
  /** Where `actions` go: the right end of the title row, or of the details row. */
  actionsPlacement?: "title" | "details";
  /** Content under the rows, indented one level in like the cell's other detail content. */
  children?: React.ReactNode;
}

/** One entry of a side-panel list: a title row (title, addon, id badge), an optional details row
 *  (bubbles and the action buttons) and an optional body. The rows only lay out what the caller
 *  passes in; hover, click and highlight behavior stays with the caller through the `div` props.
 *  `style` is merged last (e.g. a highlighted background). */
export function ListCell({
  title, truncateTitle = false, titleAddon, badge, details, actions, actionsPlacement = "details", children, style, ...rest
}: ListCellProps) {
  const titleActions = actionsPlacement === "title" && actions;
  const detailsActions = actionsPlacement === "details" && actions;
  return (
    <div {...rest} style={{ ...styles.cell, ...style }}>
      {(title !== undefined || titleAddon || badge || titleActions) && (
        <div style={styles.titleRow}>
          {title !== undefined && <span style={truncateTitle ? styles.titleTruncated : styles.title}>{title}</span>}
          {titleAddon}
          {badge && <span style={styles.badge}>{badge}</span>}
          {titleActions && <div style={{ ...styles.actions, ...(badge ? {} : styles.actionsPushed) }}>{titleActions}</div>}
        </div>
      )}
      {(details !== undefined || detailsActions) && (
        <div style={styles.detailsRow}>
          {details}
          {detailsActions && <div style={{ ...styles.actions, ...styles.actionsPushed }}>{detailsActions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export interface ListCellActionProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onClick" | "style"> {
  /** Tooltip text and accessible name. */
  title: string;
  onAction: () => void;
  /** Tints the glyph with the error colour (a destructive action). */
  danger?: boolean;
  /** Marks the active one of several mode buttons: pass it (true or false) only for such a button;
   *  it also sets `aria-pressed`. */
  selected?: boolean;
  /** Runs the action on pointer down instead of click. A SidePanel row can be re-rendered between
   *  the press and the release, which drops the click (GitHub issue #679); keyboard activation
   *  still goes through click. */
  activateOnPress?: boolean;
  /** The glyph, usually a 16px lucide icon. */
  children: React.ReactNode;
}

/** Icon button of a `ListCell`'s action area. */
export function ListCellAction({ title, onAction, danger = false, selected, activateOnPress = false, disabled, children, ...rest }: ListCellActionProps) {
  return (
    <Tooltip content={title}>
      <button
        type="button"
        className="hoverable"
        {...rest}
        aria-label={title}
        // Only a mode button (one with a `selected` flag) is a toggle for assistive technology.
        aria-pressed={selected}
        disabled={disabled}
        style={{ ...styles.actionButton, ...(selected ? styles.actionSelected : {}), ...(danger ? { color: ui.text.error } : {}), ...(disabled ? { opacity: 0.4 } : {}) }}
        onPointerDown={activateOnPress ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          // Mouse/touch activation happens here so it cannot depend on a later click event after a
          // list re-render. Keyboard activation still comes through click below.
          onAction();
        } : undefined}
        onClick={(event) => {
          // A button inside a clickable cell never also clicks the cell.
          event.stopPropagation();
          if (!activateOnPress || event.detail === 0) onAction();
        }}
      >
        <span style={styles.glyph}>{children}</span>
      </button>
    </Tooltip>
  );
}

const styles: Record<string, React.CSSProperties> = {
  cell: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap / 2,
    padding: `${spacing.itemGap}px ${spacing.groupGap}px`,
    borderBottom: `1px solid ${ui.border.default}`,
  },
  // The badge stays in normal flow, so it cannot overlap the controls of the details row.
  titleRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  title: { ...typography.body, minWidth: 0 },
  titleTruncated: { ...typography.body, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: { marginLeft: "auto", display: "inline-flex", flexShrink: 0 },
  detailsRow: { display: "flex", alignItems: "center", gap: spacing.itemGap, minWidth: 0 },
  actions: { position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: spacing.itemGap, flexShrink: 0 },
  actionsPushed: { marginLeft: "auto" },
  actionButton: {
    ...typography.icon,
    width: 22,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    background: "none",
    color: ui.text.tertiary,
    lineHeight: 1,
    cursor: "default",
    flexShrink: 0,
  },
  actionSelected: { background: ui.bg.hover, color: ui.text.primary, borderRadius: radius.sm },
  // Lets the pointer reach the button itself, not the svg inside it.
  glyph: { display: "flex", pointerEvents: "none" },
};
