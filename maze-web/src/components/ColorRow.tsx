import React from "react";
import { typography } from "../styles/theme";
import { ColorSwatch } from "./ColorSwatch";
import type { ColorField, ProjectColorEntry } from "../pixi/selectors/projectColorsSelector";
import { Inline } from "./Layout";
import { useColorVisibility } from "./ColorVisibilityContext";

/** Shared labeled color-picker row — label + `ColorSwatch`, mirrors `ToggleRow`'s label + `Switch`
 *  shape so a color param and a toggle param line up identically in the same settings list. */
export function ColorRow({ field, disabled, ...rest }: ColorRowViewProps & {
  /** This row's project-color field (GitHub issues #503, #717) — required: its name is the picker's
   *  header, its key drops the field's own row from the "Project colors" list and selects its export
   *  warnings, and its visibility predicate decides whether the row is currently in play (a hidden
   *  field renders disabled). A color outside the registry uses {@link UnregisteredColorRow}. */
  field: ColorField;
}) {
  const visibility = useColorVisibility();
  const hidden = visibility !== null && !field.isVisible(visibility);
  return <ColorRowView {...rest} field={field} disabled={disabled || hidden} />;
}

/** A color row for a value that is not a project-color field (e.g. the background-image auto-fill
 *  color) — no field-aware picker features, no visibility gating. */
export function UnregisteredColorRow(props: ColorRowViewProps) {
  return <ColorRowView {...props} />;
}

interface ColorRowViewProps {
  label: string; color: number; onChange: (color: number) => void; disabled?: boolean;
  /** Trailing control (GitHub issue #652's per-field link-status icon, `LinkStatusIcon`) — the
   *  label stays `flex: 1`, so this never shrinks it. */
  resetButton?: React.ReactNode;
  /** Forwarded to `ColorSwatch` (GitHub issue #666) — see its doc comment. */
  onOpen?: () => void;
  /** Forwarded to `ColorSwatch` (GitHub issue #666) — see its doc comment. */
  onCancel?: () => void;
  /** "Priority" project colors (GitHub issue #503) pinned to the top of the picker's "Project
   *  colors" section — sibling colors that matter for this particular decision, chosen by the call
   *  site. Passed straight through to `ColorPickerPanel`; may be empty / omitted. */
  priorityColors?: ProjectColorEntry[];
  /** This field's factory default (GitHub issue #503) — the picker pins it as the first, always
   *  unique row of the "Project colors" priority group under a generic "Default" label. Omit when
   *  the field has no meaningful default. */
  defaultColor?: number;
  /** Set by {@link ColorRow}; absent for {@link UnregisteredColorRow} (the picker header then falls
   *  back to `label`). */
  field?: ColorField;
}

function ColorRowView({ label, color, onChange, disabled, resetButton, onOpen, onCancel, priorityColors, defaultColor, field }: ColorRowViewProps) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <ColorSwatch color={color} onChange={onChange} disabled={disabled} onOpen={onOpen} onCancel={onCancel} priorityColors={priorityColors} defaultColor={defaultColor} field={field} fallbackName={label} />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
