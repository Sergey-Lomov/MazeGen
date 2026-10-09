import { createContext, useContext } from "react";
import type React from "react";
import { Maximize2 } from "lucide-react";
import { ui, controlRowHeight } from "../../styles/theme";
import type { TextFitKind } from "../../pixi/selectors/exportWarnings";
import * as m from "~/paraglide/messages";

/** Auto-fit data for the export settings panels (GitHub issue #707) — each panel provides one at its
 *  root, computed from the whole project's labels (`computeTextFitItemsAcrossFloors`), so every
 *  font-size row underneath can render an "Auto-fit" button without prop threading (same pattern
 *  as `LinkContext`). Values are `null` when no related text exists. */
export interface TextFitContextValue {
  /** Largest size at which every label of this size control fits its plate. */
  fitFor: (kind: TextFitKind) => number | null;
  /** Smallest of the per-kind fits — the one size that fits every label. */
  fitAll: () => number | null;
}

const TextFitContext = createContext<TextFitContextValue | null>(null);

export const TextFitContextProvider = TextFitContext.Provider;

export function useTextFit(): TextFitContextValue | null {
  return useContext(TextFitContext);
}

/** Borderless icon (`Maximize2`, the same glyph as the canvas "Fit to screen" button) that applies a computed font size through the field's own `onChange`, so it
 *  counts as a manual edit (the field's incoming link is detached by the store setter). Disabled
 *  with an explanatory tooltip when there is nothing to fit. */
export function AutoFitButton({ resolve, onApply, all = false }: {
  resolve: (ctx: TextFitContextValue) => number | null;
  onApply: (size: number) => void;
  all?: boolean;
}): React.ReactElement | null {
  const ctx = useTextFit();
  if (!ctx) return null;
  const size = resolve(ctx);
  const label = m["image_export.vector_by_walls.text_autofit_button"]();
  const title = size === null
    ? m["image_export.vector_by_walls.text_autofit_nothing"]()
    : all ? m["image_export.vector_by_walls.text_autofit_all_tooltip"]() : m["image_export.vector_by_walls.text_autofit_tooltip"]();
  const disabled = size === null;
  return (
    <span
      className={disabled ? undefined : "hoverable"}
      style={{ ...iconStyle, cursor: "default" }}
      title={title}
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => { if (size !== null) onApply(size); }}
    >
      <Maximize2 size={controlRowHeight - 9} color={disabled ? ui.text.disabled : ui.text.secondary} strokeWidth={2.5} />
    </span>
  );
}

/** Borderless icon box, same footprint as `LinkStatusIcon`'s wrapper so the two sit side by side. */
const iconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: controlRowHeight,
  height: controlRowHeight,
  flexShrink: 0,
  borderRadius: 3,
};
