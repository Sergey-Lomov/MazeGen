import React from "react";
import { typography } from "../styles/theme";
import { ColorSwatch } from "./ColorSwatch";
import { Inline } from "./Layout";

/** Shared labeled color-picker row — label + `ColorSwatch`, mirrors `ToggleRow`'s label + `Switch`
 *  shape so a color param and a toggle param line up identically in the same settings list. */
export function ColorRow({ label, color, onChange, disabled }: { label: string; color: number; onChange: (color: number) => void; disabled?: boolean }) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <ColorSwatch color={color} onChange={onChange} disabled={disabled} />
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
