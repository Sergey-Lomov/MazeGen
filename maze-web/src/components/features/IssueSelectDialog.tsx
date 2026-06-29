import { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { ItemSelectDialog } from "../dialogs/ItemSelectDialog";
import { resolveIssueLabel, resolveIssueDescription } from "./qualityI18n";
import { ui, font, radius } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onSelect: (kind: string) => void;
  onClose: () => void;
}

/** Step 1 of "Add new rule": pick the issue kind first, narrowing the check list shown in
 * step 2 (CheckSelectDialog with a `kind` filter) to checks of that kind. */
export function IssueSelectDialog({ onSelect, onClose }: Props) {
  const availableChecks = useMazeStore((s) => s.availableChecks);

  const kinds = Array.from(new Set(availableChecks.map((c) => c.issue_kinds[0])));
  const [selectedKind, setSelectedKind] = useState<string>(kinds[0] ?? "");

  const items = kinds.map((kind) => ({
    id: kind,
    label: resolveIssueLabel(kind),
  }));

  const rightPanel = selectedKind ? (
    <div style={styles.description}>{resolveIssueDescription(selectedKind)}</div>
  ) : (
    <div style={styles.empty}>{m["check.not_selected"]()}</div>
  );

  const footer = (
    <>
      <button style={styles.btnSecondary} onClick={onClose}>{m["common.cancel"]()}</button>
      <button
        style={{ ...styles.btnPrimary, ...(!selectedKind ? styles.btnDisabled : {}) }}
        disabled={!selectedKind}
        onClick={() => selectedKind && onSelect(selectedKind)}
      >
        {m["common.select"]()}
      </button>
    </>
  );

  return (
    <ItemSelectDialog
      title={m["quality.select_issue_title"]()}
      items={items}
      selectedId={selectedKind}
      onSelectId={setSelectedKind}
      selectedVariant="neutral"
      rightPanel={rightPanel}
      footer={footer}
      onClose={onClose}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  description: {
    fontSize: font.lg,
    color: ui.text.tertiary,
    lineHeight: 1.6,
  },
  empty: {
    fontSize: font.lg,
    color: ui.text.disabled,
  },
  btnPrimary: {
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnSecondary: {
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
};
