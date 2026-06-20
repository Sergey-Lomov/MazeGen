import { useState } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../../../store/mazeStore";
import { CheckSelectDialog } from "../CheckSelectDialog";
import { colors } from "../../../styles/theme";
import * as m from "~/paraglide/messages";
import { qualityCanvasStyles as styles, cardStyle } from "./qualityCanvasStyles";
import type { CheckVM } from "../useQualityViewModel";
import type { QualitySelection } from "./types";

interface Props {
  checks: CheckVM[];
  selection: QualitySelection;
  onSelect: (s: QualitySelection) => void;
}

export function ChecksColumn({ checks, selection, onSelect }: Props) {
  const removeCheck = useMazeStore((s) => s.removeCheck);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  return (
    <div style={styles.column}>
      <div style={styles.columnHeader}>
        <span style={styles.columnTitle}>{m["quality.checks_column"]()}</span>
        <button style={styles.addBtn} onClick={() => setAddDialogOpen(true)} title={m["quality.add_check"]()}>+</button>
      </div>
      <div style={styles.columnBody}>
        {checks.map((check) => {
          const selected = selection?.type === "check" && selection.id === check.id;
          return (
            <div
              key={check.id}
              style={cardStyle(selected)}
              onClick={() => onSelect({ type: "check", id: check.id })}
            >
              <span style={styles.cardLabel}>{check.label}</span>
              <button
                style={styles.removeBtn}
                title={m["quality.remove"]()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (selected) onSelect(null);
                  removeCheck(check.id);
                }}
              >
                <X size={16} color={colors.textDim} />
              </button>
            </div>
          );
        })}
        {checks.length === 0 && (
          <span style={styles.emptyHint}>{m["status.no_checks"]()}</span>
        )}
      </div>
      {addDialogOpen && <CheckSelectDialog onClose={() => setAddDialogOpen(false)} />}
    </div>
  );
}
