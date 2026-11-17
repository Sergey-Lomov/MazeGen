import type { LinkPath } from "../../store/parameterLinkSchema";
import { LinkedSliderRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

/** "Size adaptation" slider (GitHub issue #819) — a 0-1 fraction shown as 0-100%, offered only on
 *  fields whose cells differ in area — the schema's `spread` rule (`hasAreaSpread`) hides the row through
 *  `LinkedSliderRow`. One row per marker kind, next to that kind's own size row. */
export function SizeAdaptationRow<P extends LinkPath>({ value, onChange, linkTarget }: {
  value: number;
  onChange: (value: number) => void;
  linkTarget: P | null;
}) {
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
