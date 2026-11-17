import type React from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Bubble, BubbleArrow } from "../Bubble";
import { radius, dialogSpacing, spacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

export type ConnectionDirection = "forward" | "backward" | "two_way";

interface Props {
  title: string;
  /** Endpoint labels in the entry's own `from`/`to` order. */
  fromLabel: string;
  toLabel: string;
  direction: ConnectionDirection;
  onSelect: (direction: ConnectionDirection) => void;
  onClose: () => void;
}

/** Type and direction picker of a teleport or vertical passage (settings tool, GitHub issue #748):
 *  two-way, one-way `from -> to`, or one-way `to -> from`. Rows form a table: every row lists the
 *  `from` bubble first and the `to` bubble second, and only the arrow shows the direction. The
 *  current option is highlighted; picking one applies it and closes the dialog. */
export function ConnectionSettingsDialog({ title, fromLabel, toLabel, direction, onSelect, onClose }: Props) {
  const options: { direction: ConnectionDirection; label: string; arrow: string }[] = [
    { direction: "two_way", label: m["tools.connection_two_way"](), arrow: "<->" },
    { direction: "forward", label: m["tools.connection_one_way"](), arrow: "->" },
    { direction: "backward", label: m["tools.connection_one_way"](), arrow: "<-" },
  ];
  return (
    <Modal title={title} size="approveWide" onClose={onClose}>
      <div style={styles.list}>
        {options.map((option) => (
          <Button
            key={option.direction}
            variant={option.direction === direction ? "primary" : "secondary"}
            layoutStyle={styles.item}
            onClick={() => { onSelect(option.direction); onClose(); }}
          >
            <span style={styles.label}>{option.label}</span>
            <Bubble>{fromLabel}</Bubble>
            <BubbleArrow style={styles.arrow}>{option.arrow}</BubbleArrow>
            <Bubble>{toLabel}</Bubble>
          </Button>
        ))}
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Each row is a subgrid of the list's columns (label, `from`, arrow, `to`), so every row's cells
  // start at the same x like a table. The last column takes any extra width (e.g. a title wider
  // than the rows), so the rows always span the whole dialog.
  list: { display: "grid", gridTemplateColumns: "repeat(3, max-content) auto", rowGap: dialogSpacing.gap },
  item: {
    ...typography.control, display: "grid", gridColumn: "1 / -1", gridTemplateColumns: "subgrid", alignItems: "center",
    justifyItems: "start", columnGap: spacing.itemGap, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, borderRadius: radius.sm,
  },
  label: { ...typography.body, whiteSpace: "nowrap", marginRight: spacing.itemGap },
  arrow: { justifySelf: "center" },
};
