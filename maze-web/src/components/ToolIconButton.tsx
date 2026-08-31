import type React from "react";
import { radius } from "../styles/theme";
import { TILE_SIZE } from "../pixi/constants";

type Props = {
  selected: boolean;
  /** Native tooltip — the tool's own label, since the button carries no visible text. */
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Destructive tool — a selected state shows a danger-hued border instead of the accent one. */
  danger?: boolean;
};

/** Square icon-only button for tool pickers (GitHub issue #456) — its own button type
 *  ("tool icon", `btn-tool-icon` in global.css), not a toggle. Selection is shown by an accent
 *  border, never a fill swap. Sized to one tessellation cell. */
export function ToolIconButton({ selected, title, onClick, children, disabled, danger }: Props) {
  return (
    <button
      type="button"
      className={selected ? (danger ? "btn-tool-icon-selected-danger" : "btn-tool-icon-selected") : "btn-tool-icon"}
      style={styles.button}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    width: TILE_SIZE + 4,
    height: TILE_SIZE + 4,
    padding: 0,
    borderRadius: radius.sm,
    cursor: "default",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
  },
};
