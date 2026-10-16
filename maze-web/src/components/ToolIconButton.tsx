import type React from "react";
import { radius, ui } from "../styles/theme";
import { TILE_SIZE } from "../pixi/constants";
import { Tooltip } from "./Tooltip";

type Props = {
  selected: boolean;
  /** Tooltip label — the tool carries no visible text. */
  title: string;
  /** Tooltip explanation, rendered below the label. */
  description?: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Destructive tool — a selected state shows a danger-hued border instead of the accent one. */
  danger?: boolean;
};

/** Shared presentation for icon-only tool labels and their optional explanations. */
export function ToolTooltip({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={<><span style={styles.title}>{title}</span>{description && <span style={styles.description}>{description}</span>}</>}>
      {children}
    </Tooltip>
  );
}

/** Square icon-only button for tool pickers (GitHub issue #456) — its own button type
 *  ("tool icon", `btn-tool-icon` in global.css), not a toggle. Selection is shown by an accent
 *  border, never a fill swap. Sized to one tessellation cell. */
export function ToolIconButton({ selected, title, description, onClick, children, disabled, danger }: Props) {
  return (
    <ToolTooltip title={title} description={description}>
      <button
        type="button"
        className={selected ? (danger ? "btn-tool-icon-selected-danger" : "btn-tool-icon-selected") : "btn-tool-icon"}
        style={styles.button}
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
      >
        <span className="tool-icon-face">
          <span className="tool-icon-content">{children}</span>
        </span>
      </button>
    </ToolTooltip>
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
  title: { color: ui.text.primary },
  description: { display: "block", marginTop: 2, color: ui.text.tertiary },
};
