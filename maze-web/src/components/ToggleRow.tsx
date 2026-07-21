import React from "react";
import { typography, muted } from "../styles/theme";
import { Switch } from "./Switch";
import { Inline } from "./Layout";

/** Shared labeled toggle-switch row — lifted out of `AnalyticsFeature.tsx` (its original,
 *  previously-private home) so a second feature (the debug panel's per-debug-value toggles, GitHub
 *  issue #131) can reuse it instead of a third hand-rolled copy. */
export function ToggleRow({ label, checked, onChange, disabled, info }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; info?: () => void }) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.toggleLabel, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      {info && (
        <span role="button" tabIndex={0} className="hoverable" style={styles.infoIcon} onClick={info}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") info(); }}>ℹ</span>
      )}
      <Switch checked={checked && !disabled} onChange={disabled ? () => {} : onChange} />
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toggleLabel: { flex: 1, ...muted(typography.body) },
  infoIcon: { ...muted(typography.icon), lineHeight: 1, flexShrink: 0, cursor: "default", borderRadius: 3 },
};
