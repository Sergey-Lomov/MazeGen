import type React from "react";
import { RotateCcw } from "lucide-react";
import { ui } from "../styles/theme";

/** Per-field "unlink from shared style" reset button (GitHub issue #322) — mirrors
 *  `TeleportGroupRow`'s own reset icon convention (`TeleportSettingsSection.tsx`). Shown only for
 *  a field that's part of a "Shared style" group; disabled (dim, inert) while the field still
 *  follows the shared value, active once the user has overridden it directly. Clicking clears the
 *  override, snapping the field back to the shared value. */
export function OverrideResetButton({ overridden, onReset, title }: { overridden: boolean; onReset: () => void; title: string }) {
  return (
    <button
      type="button"
      className="hoverable"
      title={title}
      style={styles.button}
      disabled={!overridden}
      onClick={onReset}
    >
      <RotateCcw size={13} color={ui.text.tertiary} opacity={overridden ? 1 : 0.4} />
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    display: "inline-flex", alignItems: "center", flexShrink: 0,
    background: "none", border: "none", outline: "none", cursor: "default", padding: 0,
  },
};
