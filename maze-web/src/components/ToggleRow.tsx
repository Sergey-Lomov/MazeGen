import React, { type ReactNode } from "react";
import { typography, muted, disabled as disabledStyle, spacing } from "../styles/theme";
import { Switch } from "./Switch";
import { Inline } from "./Layout";
import { InfoIconButton } from "./InfoIconButton";

/** Shared labeled toggle-switch row — lifted out of `AnalyticsFeature.tsx` (its original,
 *  previously-private home) so a second feature (the debug panel's per-debug-value toggles, GitHub
 *  issue #131) can reuse it instead of a third hand-rolled copy. */
export function ToggleRow({ label, checked, onChange, disabled, info, action, resetButton, layoutStyle }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; info?: () => void; action?: ReactNode;
  /** Trailing control (GitHub issue #652's per-field link-status icon, `LinkStatusIcon`), after the
   *  `Switch` — same trailing-slot convention as `SelectRow`/`SliderRow`/`ColorRow`. */
  resetButton?: ReactNode;
  layoutStyle?: React.CSSProperties }) {
  return (
    <Inline gap="groupGap" style={layoutStyle}>
      <span style={styles.toggleLabelGroup}>
        <span style={disabled ? disabledStyle(typography.body) : styles.toggleLabel}>{label}</span>
        {info && <InfoIconButton onClick={info} />}
      </span>
      {action}
      <Switch checked={checked && !disabled} onChange={disabled ? () => {} : onChange} ariaLabel={label} />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toggleLabelGroup: { flex: 1, display: "flex", alignItems: "center", gap: spacing.rowGap },
  toggleLabel: { ...muted(typography.body) },
};
