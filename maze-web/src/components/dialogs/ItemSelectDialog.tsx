import React from "react";
import { Modal } from "../Modal";
import { SelectableList, SelectableRow } from "../SelectableList";
import { WarningIcon } from "../WarningIcon";
import { ui, dialogSpacing, typography, spacing } from "../../styles/theme";

interface Item {
  id: string;
  label: string;
  disabled?: boolean;
  /** Shows a warning icon after the label (e.g. an experimental strategy). */
  warning?: boolean;
  /** Groups this item under a section header, in first-seen order. Items without a
   * section render as today, ungrouped and unindented. */
  section?: string;
}

interface Props {
  title: string;
  items: Item[];
  selectedId: string;
  onSelectId: (id: string) => void;
  rightPanel: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
  /** Enter/Space confirmation shortcut (GitHub issue #638) — omit when the caller has no
   *  confirm action (e.g. the item's own row selection isn't followed by an explicit confirm). */
  onConfirm?: () => void;
}

export function ItemSelectDialog({ title, items, selectedId, onSelectId, rightPanel, footer, onClose, onConfirm }: Props) {
  const sections = groupBySection(items);

  const values = items.filter((item) => !item.disabled).map((item) => item.id);

  const renderItem = (item: Item) => (
    <SelectableRow
      key={item.id}
      value={item.id}
      selected={item.id === selectedId}
      disabled={item.disabled}
      indented={item.section !== undefined}
      trailing={item.warning && <WarningIcon />}
    >
      {item.label}
    </SelectableRow>
  );

  const body = (
    <div style={styles.content}>
      <SelectableList
        appearance="dialog"
        compact
        autoFocus
        selected={selectedId}
        values={values}
        onSelect={onSelectId}
        ariaLabel={title}
        style={styles.leftCol}
      >
        {sections.map((section, i) =>
          section.name === null ? (
            section.items.map(renderItem)
          ) : (
            <div key={section.name} role="group" aria-label={section.name}>
              {i > 0 && <div style={styles.divider} />}
              <div style={styles.sectionHeader}>{section.name}</div>
              {section.items.map(renderItem)}
            </div>
          )
        )}
      </SelectableList>
      <div style={styles.rightCol}>
        <div style={styles.rightPanel}>{rightPanel}</div>
        <div style={styles.footer}>{footer}</div>
      </div>
    </div>
  );

  return <Modal title={title} size="complex" rawBody={body} onClose={onClose} onConfirm={onConfirm} />;
}

/** Splits items into contiguous runs by `section`, in first-seen order. An item with no
 * `section` is its own ungrouped run (`name: null`), preserving today's flat rendering. */
function groupBySection(items: Item[]): { name: string | null; items: Item[] }[] {
  const sections: { name: string | null; items: Item[] }[] = [];
  for (const item of items) {
    const name = item.section ?? null;
    const last = sections[sections.length - 1];
    if (last && last.name === name && name !== null) {
      last.items.push(item);
    } else {
      sections.push({ name, items: [item] });
    }
  }
  return sections;
}

const styles: Record<string, React.CSSProperties> = {
  content: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  leftCol: {
    width: 260,
    flexShrink: 0,
    borderRight: `1px solid ${ui.border.default}`,
    overflowY: "auto" as const,
    padding: `${spacing.itemGap}px 0`,
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
  },
  sectionHeader: {
    ...typography.body,
    marginTop: spacing.groupGap,
    padding: `0 ${dialogSpacing.paddingX}px`,
  },
  divider: {
    borderTop: `1px solid ${ui.border.default}`,
    margin: `${spacing.itemGap}px ${dialogSpacing.paddingX}px 0`,
  },
  rightCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  rightPanel: {
    flex: 1,
    overflowY: "auto" as const,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: spacing.groupGap,
    padding: `${dialogSpacing.paddingY}px ${dialogSpacing.paddingX}px`,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
};
