import type React from "react";
import { ui, radius, typography, muted, disabled as disabledText, spacing, dialogSpacing, controlRowHeight } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";

export const styles: Record<string, React.CSSProperties> = {
  labelBubble: { cursor: "default", padding: "0 2px", borderRadius: 3, background: ui.bg.panelAlt },
  inactiveBadge: { display: "inline-flex", alignItems: "center", marginLeft: 4, color: ui.text.tertiary, cursor: "default" },
  // Replaces `Modal`'s own padded `body` now that this dialog uses `rawBody` (GitHub issue #645
  // follow-up) — needed so the toolbar below can stay `flexShrink: 0` while only the row list
  // scrolls, which `Modal.body`'s single `overflowY: auto` container couldn't give us.
  dialogBody: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
  },
  toolbar: { display: "flex", alignItems: "center", gap: spacing.itemGap, flexShrink: 0 },
  // Horizontal rule under the toolbar (GitHub issue #645 follow-up) — `dialogBody`'s own `gap`
  // already separates it from the toolbar above and the scroll area below, so the scrollable
  // list starts right beneath this line rather than floating in extra whitespace.
  toolbarDivider: { height: 1, background: ui.border.default, flexShrink: 0, margin: 0 },
  rowsScroll: { flex: 1, minHeight: 0, overflowY: "auto" as const },
  breadcrumbRoot: { position: "relative" as const, flex: 1, minWidth: 0 },
  breadcrumbBar: {
    ...typography.field,
    display: "flex",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
    background: ui.bg.input,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    padding: "2px 6px",
    cursor: "default",
  },
  breadcrumbPlaceholder: { ...muted(typography.field) },
  breadcrumbChip: { display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const },
  breadcrumbSep: { ...muted(typography.field) },
  breadcrumbPop: { ...sharedStyles.closeBtn, display: "flex", alignItems: "center", marginLeft: "auto", flexShrink: 0 },
  breadcrumbClear: { ...sharedStyles.closeBtn, display: "flex", alignItems: "center", flexShrink: 0 },
  breadcrumbDropdown: {
    position: "absolute" as const,
    top: "100%",
    left: 0,
    right: 0,
    marginTop: 2,
    zIndex: 10,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    background: ui.bg.panel,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    padding: 4,
    maxHeight: 220,
    overflowY: "auto" as const,
  },
  emptyState: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.groupGap,
    padding: `${spacing.sectionGap * 2}px ${dialogSpacing.paddingX}px`,
  },
  emptyStateText: { ...typography.body },
  emptyStateSubtext: { ...muted(typography.caption) },
  rows: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
    background: ui.bg.panel,
    borderRadius: radius.md,
    border: `1px solid ${ui.border.default}`,
    padding: "7px 6px 7px 10px",
  },
  rowDisabled: { opacity: 0.5 },
  rowLine: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  linkLabel: { ...typography.body, flex: 1, minWidth: 0 },
  valueLabel: { ...muted(typography.caption), flex: 1, minWidth: 0 },
  valueColorSwatch: {
    display: "inline-block",
    width: 14,
    height: 14,
    borderRadius: 3,
    marginLeft: 4,
    verticalAlign: "middle",
    border: `1px solid ${ui.border.default}`,
  },
  editorBody: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
    gap: dialogSpacing.gap,
  },
  editorColumns: { display: "flex", gap: spacing.sectionGap, flex: 1, minHeight: 0 },
  editorColumn: { flex: 1, display: "flex", flexDirection: "column", gap: spacing.itemGap, minWidth: 0, minHeight: 0, overflowY: "auto" as const },
  // `position: sticky` alone lets scrolled rows show through since the title has no fill of its
  // own — an opaque background matching the dialog's (`Modal`'s `ui.bg.panel`) is what actually
  // clips them instead of letting them bleed through underneath (GitHub issue #645 follow-up).
  editorColumnTitle: { ...typography.body, position: "sticky" as const, top: 0, background: ui.bg.panel, paddingBottom: spacing.elementsGap, zIndex: 1 },
  pickerSearch: { ...sharedStyles.inputSm, boxSizing: "border-box" as const, width: "100%", flexShrink: 0 },
  pickerList: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  pickerRow: { ...typography.body, cursor: "default", padding: "2px 4px", borderRadius: 3 },
  // GitHub issue #688 — dims a hidden leaf/group row so it reads as inactive at a glance, on top of
  // the closed-eye badge; applied before `pickerRowSelected` so a selected-but-inactive row still
  // shows its selection highlight.
  pickerRowInactive: { ...muted(typography.body) },
  pickerRowDisabled: { ...disabledText(typography.body), cursor: "not-allowed" },
  pickerRowLocked: { opacity: 0.6 },
  pickerRowSelected: { background: ui.state.selected },
  pickerGroupRow: {
    ...typography.body,
    display: "flex",
    alignItems: "center",
    gap: spacing.elementsGap,
    cursor: "default",
    padding: "2px 4px",
    borderRadius: 3,
  },
  pickerHint: { ...muted(typography.caption) },
  // Narrower than the target/source picker columns (GitHub issue #645 follow-up) — the modifiers
  // column only ever holds short step rows ("× 1.5") plus an icon-sized add button, so it needs far
  // less width than the picker trees do.
  wideColumn: { flex: 1.4 },
  modifiersColumn: { flex: 0.6 },
  // Same horizontal inset/radius as `pickerRow`/`pickerGroupRow` (GitHub issue #645 follow-up) —
  // the Target/Source columns' content is never flush with the column edge, and this column's
  // chain-step rows shouldn't be the one exception.
  modifierStep: { display: "flex", alignItems: "center", gap: spacing.elementsGap, padding: "2px 4px", borderRadius: 3 },
  modifierStepText: { ...typography.body, flex: 1 },
  modifierError: { ...typography.caption, color: ui.text.error },
  // Same look as the quality panel's rule-title rename input (`ruleCardTitleInput`), minus its
  // `fontWeight: 600` — this is `sharedStyles.inputSm` itself, the un-bolded base that
  // `ruleCardTitleInput` builds on. `height`/`boxSizing` pinned to `controlRowHeight` so it lines
  // up exactly with the op `<select>` beside it (`modifierOpSelect`) — their native heights
  // otherwise differ slightly (GitHub issue #645 follow-up).
  modifierValueInput: { ...sharedStyles.inputSm, height: controlRowHeight, boxSizing: "border-box" as const },
  modifierOpSelect: { height: controlRowHeight, boxSizing: "border-box" as const },
  // Same `pickerRow` convention as every other row in this dialog (GitHub issue #645 follow-up) —
  // the row's own box IS the column's full width with the hover fill on it, and `padding: "2px
  // 4px"` is purely the text's internal inset, not an outer margin — so its hover highlight spans
  // edge-to-edge exactly like the Target/Source columns' own rows, with no gap on either side.
  addModifierRow: { ...typography.body, color: ui.text.tertiary, cursor: "default", padding: "2px 4px", borderRadius: 3 },
  editorFooter: { display: "flex", justifyContent: "flex-end", gap: spacing.groupGap, flexShrink: 0 },
  editorFooterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing.groupGap, paddingTop: spacing.groupGap, flexShrink: 0 },
  // `ToggleRow`'s own `Inline` defaults to `flex: 1` on its label group, which would stretch it
  // across the whole footer row and push the Cancel/Save buttons off to the far right rather than
  // sitting right next to the toggle (GitHub issue #688) — capped to its content width instead.
  showInactiveToggle: { flex: "none" },
};
