import type React from "react";
import { ArrowBigUp, Option } from "lucide-react";
import { radius, ui } from "../styles/theme";
import { TILE_SIZE } from "../pixi/constants";
import { Tooltip } from "./Tooltip";

export type ShortcutKey = string;

type Props = {
  selected: boolean;
  /** Tooltip label — the tool carries no visible text. */
  title: string;
  /** Tooltip explanation, rendered below the label. */
  description?: string;
  /** Keyboard shortcut, rendered as keycap badges in the tooltip. */
  shortcut?: readonly ShortcutKey[];
  /** Modifier key shown before the tooltip explanation. */
  descriptionShortcut?: readonly ShortcutKey[];
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Destructive tool — a selected state shows a danger-hued border instead of the accent one. */
  danger?: boolean;
  /** Releasing the pointer on this button keeps the canvas selection (it is read by the click). */
  preservesFieldSelection?: boolean;
};

/** Shared presentation for icon-only tool labels and their optional explanations. */
export function ToolTooltip({ title, description, shortcut, descriptionShortcut, children }: {
  title: string;
  description?: string;
  shortcut?: readonly ShortcutKey[];
  descriptionShortcut?: readonly ShortcutKey[];
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={
      <span style={styles.content}>
        <span style={styles.titleRow}>
          <span style={styles.title}>{title}</span>
          {shortcut && <ShortcutKeycaps keys={shortcut} />}
        </span>
        {description && <span style={styles.description}>{descriptionShortcut && <ShortcutKeycaps keys={descriptionShortcut} />}{description}</span>}
      </span>
    }>
      {children}
    </Tooltip>
  );
}

/** Square icon-only button for tool pickers (GitHub issue #456) — its own button type
 *  ("tool icon", `btn-tool-icon` in global.css), not a toggle. Selection is shown by an accent
 *  border, never a fill swap. Sized to one tessellation cell. */
export function ToolIconButton({ selected, title, description, shortcut, descriptionShortcut, onClick, children, disabled, danger, preservesFieldSelection }: Props) {
  return (
    <ToolTooltip title={title} description={description} shortcut={shortcut} descriptionShortcut={descriptionShortcut}>
      <button
        type="button"
        className={selected ? (danger ? "btn-tool-icon-selected-danger" : "btn-tool-icon-selected") : "btn-tool-icon"}
        style={styles.button}
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        data-preserves-field-selection={preservesFieldSelection ? "" : undefined}
      >
        <span className="tool-icon-face">
          <span className="tool-icon-content">{children}</span>
        </span>
      </button>
    </ToolTooltip>
  );
}

const SHORTCUT_ICONS = {
  shift: ArrowBigUp,
} as const;

function ShortcutKeycaps({ keys }: { keys: readonly ShortcutKey[] }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const spokenKeys = keys.map((key) => key === "shift" ? "Shift" : key === "Alt" && isMac ? "Option" : key);
  return <span aria-label={`Shortcut: ${spokenKeys.join(" plus ")}`} style={styles.shortcut}>{keys.map((key, index) => {
    const Icon = key === "Alt" && isMac ? Option : SHORTCUT_ICONS[key as keyof typeof SHORTCUT_ICONS];
    return <kbd key={`${key}-${index}`} style={styles.keycap}>{Icon ? <Icon aria-hidden="true" size={key === "Alt" && isMac ? 11 : 14} strokeWidth={2.5} /> : key}</kbd>;
  })}</span>;
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
  content: { display: "block", minWidth: 0 },
  titleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 },
  title: { color: ui.text.primary },
  description: { display: "flex", alignItems: "center", gap: 4, marginTop: 6, color: ui.text.tertiary },
  shortcut: { display: "inline-flex", gap: 3, flexShrink: 0 },
  keycap: {
    height: 20,
    minWidth: 20,
    padding: "0 5px",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.md,
    background: ui.bg.keycap,
    color: ui.text.primary,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "0.9em",
    lineHeight: 1.2,
    textAlign: "center",
  },
};
