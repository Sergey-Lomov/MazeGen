import { useEffect, useRef } from "react";
import type { LinkPath } from "../../store/parameterLinkSchema";
import { isLabelFontFamilyLoaded, loadLabelFontFamily } from "../../pixi/renderers/labelFont";
import { LinkedFontRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

/** The one link-aware font-family control for every canvas text style: a row whose button shows the
 *  current font and opens `FontPickerPanel`. Every text settings group renders this row and passes
 *  only its value, setter and link target, so the loading and preview behavior lives here once. */
export function FontFamilyRow<P extends LinkPath>({ value, onChange, linkTarget }: {
  value: string | undefined;
  onChange: (value: string) => void;
  linkTarget: P | null;
}) {
  // A preview tick for a family that is still loading must not land after a newer pick (arrow keys
  // move faster than a font loads), so only the latest request is applied.
  const latestRequest = useRef(0);
  useEffect(() => {
    // Project files retain the selected family name. Load it whenever this value arrives through
    // project restoration or a shared-style link, not only after a direct user selection.
    void loadLabelFontFamily(value ?? "");
  }, [value]);
  // The family the picker opened with: Cancel restores it, even when this machine lacks the font.
  const openFamily = useRef<string | null>(null);
  const commit = (family: string) => {
    const request = ++latestRequest.current;
    // The default, already-loaded and open-time fonts apply synchronously: the picker's Cancel
    // restores the open-time font and then re-enables the link, and that order must not be inverted
    // by a promise. An unloaded font renders as the bundled Roboto until it loads.
    if (!family.trim() || isLabelFontFamilyLoaded(family) || family === openFamily.current) {
      onChange(family);
      return;
    }
    void loadLabelFontFamily(family).then(() => { if (request === latestRequest.current) onChange(family); });
  };
  return <LinkedFontRow label={m["image_export.label_font_family"]()} family={value ?? ""} onChange={commit} onOpen={() => { openFamily.current = value ?? ""; }} linkTarget={linkTarget} />;
}
