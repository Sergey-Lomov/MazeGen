import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { SelectableList, SelectableRow } from "../SelectableList";
import { typography, muted } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

export function SeedHistoryDialog({ onClose }: Props) {
  const seedHistory = useMazeStore((s) => s.seedHistory);
  const seedHistoryIndex = useMazeStore((s) => s.seedHistoryIndex);
  const seedHistoryJump = useMazeStore((s) => s.seedHistoryJump);
  const seed = useMazeStore((s) => s.seed);

  // Only the history entry the seed field currently shows is highlighted; a seed typed in by hand
  // that is not in the history highlights nothing. The current index wins when the seed repeats.
  const currentIndex = seedHistory[seedHistoryIndex] === seed ? seedHistoryIndex : seedHistory.lastIndexOf(seed);
  // The row the arrow keys moved to, jumped to by Enter. A click jumps at once instead.
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const highlightedIndex = keyboardIndex ?? (currentIndex < 0 ? null : currentIndex);

  function handlePick(index: number) {
    seedHistoryJump(index);
    onClose();
  }

  // Displayed newest-first, so the arrow keys walk the real indices from the last to the first.
  const walkOrder = seedHistory.map((_, displayIndex) => String(seedHistory.length - 1 - displayIndex));

  return (
    <Modal
      title={m["generation.seed_history_title"]()}
      onClose={onClose}
      onConfirm={keyboardIndex !== null ? () => handlePick(keyboardIndex) : undefined}
    >
      {seedHistory.length === 0 ? (
        <div style={styles.empty}>{m["generation.seed_history_empty"]()}</div>
      ) : (
        // A row's value is its actual `seedHistory` position (`realIndex`), since `seedHistoryJump`
        // addresses the array, not the display order.
        <SelectableList
          appearance="dialog"
          hoverSelected
          autoFocus
          selected={highlightedIndex === null ? null : String(highlightedIndex)}
          values={walkOrder}
          onSelect={(value, source) => (source === "keyboard" ? setKeyboardIndex(Number(value)) : handlePick(Number(value)))}
          ariaLabel={m["generation.seed_history_title"]()}
        >
          {walkOrder.map((value) => (
            <SelectableRow key={value} value={value} selected={Number(value) === highlightedIndex}>
              {seedHistory[Number(value)]}
            </SelectableRow>
          ))}
        </SelectableList>
      )}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    ...muted(typography.body),
  },
};
