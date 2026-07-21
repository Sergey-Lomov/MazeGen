import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { ui, dialogSpacing, typography, muted, spacing } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

export function SeedHistoryDialog({ onClose }: Props) {
  const seedHistory = useMazeStore((s) => s.seedHistory);
  const seedHistoryIndex = useMazeStore((s) => s.seedHistoryIndex);
  const seedHistoryJump = useMazeStore((s) => s.seedHistoryJump);

  function handlePick(index: number) {
    seedHistoryJump(index);
    onClose();
  }

  return (
    <Modal title={m["generation.seed_history_title"]()} onClose={onClose}>
      {seedHistory.length === 0 ? (
        <div style={styles.empty}>{m["generation.seed_history_empty"]()}</div>
      ) : (
        // Displayed newest-first (reversed) — `realIndex` maps each displayed row back to its
        // actual `seedHistory` position, since `seedHistoryJump` addresses the array, not the
        // display order.
        seedHistory.map((_, displayIndex) => {
          const realIndex = seedHistory.length - 1 - displayIndex;
          const seedValue = seedHistory[realIndex];
          return (
            <button
              key={realIndex}
              className={realIndex === seedHistoryIndex ? "hoverable-tint" : "hoverable"}
              style={{ ...styles.item, ...(realIndex === seedHistoryIndex ? styles.itemSelected : {}) }}
              onClick={() => handlePick(realIndex)}
            >
              <span style={styles.itemLabel}>{seedValue}</span>
            </button>
          );
        })
      )}
    </Modal>
  );
}

// Mirrors `ItemSelectDialog`'s own `item`/`itemSelected`/`itemLabel` styles — same row look as
// every other selection dialog (algorithm, strategy, check), just without its left/right split
// or footer, since picking a row here selects and closes immediately.
const styles: Record<string, React.CSSProperties> = {
  empty: {
    ...muted(typography.body),
  },
  item: {
    ...typography.control,
    background: "none",
    border: "none",
    textAlign: "left" as const,
    padding: `6px ${dialogSpacing.paddingX}px`,
    color: ui.text.secondary,
    cursor: "default",
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
  },
  itemSelected: {
    background: ui.accent.base,
    color: ui.text.inverse,
  },
  itemLabel: {
    flex: 1,
  },
};
