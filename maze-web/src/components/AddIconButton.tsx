import type React from "react";
import { Plus } from "lucide-react";
import { ui, radius } from "../styles/theme";

/** Shared "add a new entry" icon button — the flat `Plus` glyph convention used throughout the
 *  quality panels (`RulesColumn`'s own `stageToolbarBtn`) rather than a bordered/filled button, so
 *  every add entry point across the app renders and behaves identically instead of each toolbar
 *  hand-rolling its own button+`Plus` copy. */
export function AddIconButton({ onClick, title }: { onClick: (e: React.MouseEvent) => void; title: string }) {
  return (
    <button type="button" className="hoverable" style={styles.addBtn} title={title} onClick={onClick}>
      <Plus size={16} color={ui.text.tertiary} strokeWidth={2.5} />
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  addBtn: {
    background: "none",
    border: "none",
    padding: "2px 6px",
    cursor: "default",
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    borderRadius: radius.sm,
    flexShrink: 0,
  },
};
