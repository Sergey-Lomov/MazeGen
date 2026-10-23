import { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { hasCellAreaSpread } from "../../pixi/markerScale";
import { LinkedSliderRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

/** Whether the active field's cell areas differ enough for marker size adaptation to matter
 *  (GitHub issue #819) — the same gate the parameter-links activity check mirrors. */
export function useHasCellAreaSpread(): boolean {
  const cfg = useMazeStore((s) => s.activeFieldConfig);
  return useMemo(() => hasCellAreaSpread(cfg), [cfg]);
}

/** "Size adaptation" slider (GitHub issue #819) — a 0-1 fraction shown as 0-100%, offered only on
 *  fields whose cells differ in area. One row per marker kind, next to that kind's own size row. */
export function SizeAdaptationRow<P extends string>({ value, onChange, linkTarget }: {
  value: number;
  onChange: (value: number) => void;
  linkTarget: P | null;
}) {
  const visible = useHasCellAreaSpread();
  if (!visible) return null;
  return (
    <LinkedSliderRow
      label={m["image_export.vector_by_walls.marker_size_adaptation"]()}
      value={value}
      onChange={onChange}
      min={0}
      max={1}
      step={0.01}
      format={(v) => `${Math.round(v * 100)}%`}
      linkTarget={linkTarget}
    />
  );
}
