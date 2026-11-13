import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef } from "react";
import type React from "react";
import { dialogSpacing, indent, radius, spacing, typography, ui } from "../styles/theme";

/** How a selection was made. A keyboard move can repeat dozens of times a second while an arrow key
 *  is held, so a caller with an expensive reaction (a live preview) may want to coalesce it. */
export type SelectionSource = "pointer" | "keyboard";

/** `panel`: a framed list inside a side panel. `dialog`: bare rows spanning a dialog's width. */
export type SelectableAppearance = "panel" | "dialog";

interface SelectableContext {
  listId: string;
  appearance: SelectableAppearance;
  /** Dialog rows only: the tighter vertical padding of a long list. */
  compact: boolean;
  hoverSelected: boolean;
  select: (value: string, source: SelectionSource) => void;
}

const ListContext = createContext<SelectableContext | null>(null);

const optionDomId = (listId: string, value: string) => `${listId}-option-${encodeURIComponent(value)}`;

export interface SelectableListProps<V extends string = string> {
  /** The selected value, or `null` while nothing is. */
  selected: V | null;
  /** Called for a click on a row and for each arrow key move. */
  onSelect: (value: V, source: SelectionSource) => void;
  /** Every selectable (not disabled) value in display order: the order the arrow keys walk. Omitted
   *  for a list whose selection is applied at once (pick and close), which keys must not walk. */
  values?: readonly V[];
  appearance?: SelectableAppearance;
  compact?: boolean;
  /** Takes keyboard focus on mount, so the arrow keys work at once. */
  autoFocus?: boolean;
  /** Dialog rows only: the selected row brightens on hover like the others, instead of staying put. */
  hoverSelected?: boolean;
  /** Not an option: content pinned to the bottom of the list body (it never scrolls away). */
  footer?: React.ReactNode;
  /** The footer fills the whole list body and centers its content, for a list with no rows to show. */
  centerFooter?: boolean;
  testId?: string;
  ariaLabel?: string;
  /** Merged over the list's own style (e.g. a dialog column's width, scroll and border). */
  style?: React.CSSProperties;
  /** `SelectableRow`s, possibly inside `role="group"` sections. */
  children: React.ReactNode;
}

/** Single-select list: `role="listbox"` over `SelectableRow`s. The listbox itself holds focus, so
 *  the highlight moves with the up / down arrows (clamped at both ends; from nothing, Down lands on
 *  the first value and Up on the last) and is announced through `aria-activedescendant`. The
 *  selected row is scrolled into view as the selection moves. */
export function SelectableList<V extends string = string>({
  selected, onSelect, values, appearance = "panel", compact = false, autoFocus = false, hoverSelected = false, footer, centerFooter = false, testId, ariaLabel, style, children,
}: SelectableListProps<V>) {
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // Rows hold `select` in their memo dependencies, so it must keep its identity across renders.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const select = useCallback((value: string, source: SelectionSource) => onSelectRef.current(value as V, source), []);
  const context = useMemo(
    () => ({ listId, appearance, compact, hoverSelected, select }),
    [listId, appearance, compact, hoverSelected, select],
  );

  const activeId = selected === null ? undefined : optionDomId(listId, selected);

  useEffect(() => {
    if (autoFocus) listRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  useEffect(() => {
    if (activeId !== undefined) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
    // `values.length`, not `values`: callers rebuild the array every render, which must not
    // re-scroll; a changed length covers the selected row appearing after the options load.
  }, [activeId, values?.length]);

  function handleKeyDown(event: React.KeyboardEvent) {
    if (values === undefined || values.length === 0) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = selected === null ? -1 : values.indexOf(selected);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index < 0 ? (step > 0 ? 0 : values.length - 1) : Math.min(values.length - 1, Math.max(0, index + step));
    if (next !== index) onSelect(values[next], "keyboard");
  }

  return (
    <ListContext.Provider value={context}>
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label={ariaLabel}
        // Focus stays on the listbox, so the moving highlight is announced through the active option.
        aria-activedescendant={activeId}
        style={{ ...styles.list, ...(appearance === "panel" ? styles.listPanel : {}), ...style }}
        onKeyDown={handleKeyDown}
        data-testid={testId}
      >
        {children}
        {footer && <div role="presentation" style={centerFooter ? styles.footerCentered : styles.footer}>{footer}</div>}
      </div>
    </ListContext.Provider>
  );
}

export interface SelectableRowProps {
  value: string;
  selected: boolean;
  /** A disabled row is shown dimmed and cannot be selected. */
  disabled?: boolean;
  /** Dialog rows only: one level in, for a row under a section header. */
  indented?: boolean;
  /** After the label (e.g. a warning icon). */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}

/** One row of a `SelectableList`. Memoized so moving the highlight re-renders only the two rows
 *  whose selected state changed, not every row of a long list (every installed font). */
export const SelectableRow = memo(function SelectableRow({ value, selected, disabled = false, indented = false, trailing, children }: SelectableRowProps) {
  const context = useContext(ListContext);
  if (context === null) throw new Error("SelectableRow must be rendered inside a SelectableList");
  const { listId, appearance, compact, hoverSelected, select } = context;
  const dialog = appearance === "dialog";
  const className = dialog
    ? (disabled ? undefined : selected ? (hoverSelected ? "hoverable-tint" : "hoverable-selected") : "hoverable")
    : "picker-list-row";
  return (
    <div
      id={optionDomId(listId, value)}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      className={className}
      style={{
        ...(dialog ? styles.rowDialog : styles.rowPanel),
        ...(dialog ? { padding: `${compact ? 3 : 6}px ${dialogSpacing.paddingX + (indented ? indent.tree : 0)}px` } : {}),
        ...(selected ? (dialog ? styles.rowDialogSelected : styles.rowPanelSelected) : {}),
        ...(disabled ? styles.rowDisabled : {}),
      }}
      onClick={disabled ? undefined : () => select(value, "pointer")}
    >
      <span style={dialog ? styles.label : { ...styles.label, ...styles.labelTruncated }}>{children}</span>
      {trailing}
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", outline: "none" },
  listPanel: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
  },
  footer: {
    position: "sticky",
    bottom: 0,
    marginTop: "auto",
    background: ui.bg.input,
    borderTop: `1px solid ${ui.border.default}`,
    padding: spacing.groupGap,
  },
  footerCentered: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: spacing.groupGap, textAlign: "center" },
  rowPanel: { ...typography.body, display: "flex", alignItems: "center", padding: "3px 8px", flexShrink: 0, cursor: "default" },
  rowPanelSelected: { background: ui.state.selected, color: ui.text.primary },
  rowDialog: {
    ...typography.control,
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
    width: "100%",
    boxSizing: "border-box",
    color: ui.text.secondary,
    cursor: "default",
  },
  rowDialogSelected: { background: ui.accent.base, color: ui.text.inverse },
  rowDisabled: { opacity: 0.4, cursor: "default" },
  label: { flex: 1, minWidth: 0 },
  labelTruncated: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
};
