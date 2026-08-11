import React from "react";
import { typography } from "../styles/theme";
import { ColorSwatch } from "./ColorSwatch";
import { Inline } from "./Layout";

/** Shared labeled color-picker row — label + `ColorSwatch`, mirrors `ToggleRow`'s label + `Switch`
 *  shape so a color param and a toggle param line up identically in the same settings list. */
export function ColorRow({ label, color, onChange, disabled, resetButton }: {
  label: string; color: number; onChange: (color: number) => void; disabled?: boolean;
  /** Trailing control (GitHub issue #322's per-field "Shared style" reset button,
   *  `OverrideResetButton`) — the label stays `flex: 1`, so this never shrinks it. */
  resetButton?: React.ReactNode;
}) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <ColorSwatch color={color} onChange={onChange} disabled={disabled} />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
