import type React from "react";
import { ShortcutKeycaps, type ShortcutKey } from "./ToolIconButton";
import { spacing, typography } from "../styles/theme";

/** Two-column keyboard hint with a centered keycap cell and left-aligned explanatory text. */
export function EmbeddedHotkeyHint({ keys, children }: { keys: readonly ShortcutKey[]; children: React.ReactNode }) {
  return (
    <div style={styles.root}>
      <span style={styles.keys}><ShortcutKeycaps keys={keys} muted /></span>
      <span style={styles.text}>{children}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "grid", gridTemplateColumns: "48px minmax(0, 1fr)", columnGap: spacing.rowGap, alignItems: "center" },
  keys: { display: "flex", alignItems: "center", justifyContent: "center" },
  text: { ...typography.caption, textAlign: "left" },
};
