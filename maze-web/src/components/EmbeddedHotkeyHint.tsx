import type React from "react";
import { ShortcutKeycaps, type ShortcutKey } from "./ToolIconButton";
import { typography } from "../styles/theme";

/** Compact, centered keyboard hint for the quiet bottom area of a side panel. */
export function EmbeddedHotkeyHint({ prefix, keys, children }: { prefix?: string; keys: readonly ShortcutKey[]; children: React.ReactNode }) {
  return (
    <div style={styles.root}>
      {prefix && <>{prefix} </>}<ShortcutKeycaps keys={keys} muted /> {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { ...typography.caption, textAlign: "center" },
};
