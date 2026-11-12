import { useEffect, useRef } from "react";
import type { LinkPath } from "../../store/parameterLinkSchema";
import { DEFAULT_LABEL_FONT, labelFontEquals, type LabelFont } from "../../pixi/renderers/fontChoice";
import { isLabelFontLoaded, loadLabelFont } from "../../pixi/renderers/labelFont";
import { LinkedFontRow } from "./LinkedRows";
import type { TextFitKind } from "../../pixi/selectors/exportWarnings";
import * as m from "~/paraglide/messages";

/** The one link-aware font control for every canvas text style: a row whose button shows the current
 *  font (family and weight, GitHub issue #973) and opens `FontPickerPanel`. Every text settings group
 *  renders this row and passes only its value, setter and link target, so the loading and preview
 *  behavior lives here once. */
export function LabelFontRow<P extends LinkPath>({ value, onChange, linkTarget, warningKinds }: {
  value: LabelFont | undefined;
  onChange: (value: LabelFont) => void;
  linkTarget: P | null;
  /** The canvas texts this font drives (GitHub issue #971): the picker shows their overflow warnings. */
  warningKinds?: TextFitKind[];
}) {
  const font = value ?? DEFAULT_LABEL_FONT;
  // A preview tick for a font that is still loading must not land after a newer pick (arrow keys
  // move faster than a font loads), so only the latest request is applied.
  const latestRequest = useRef(0);
  useEffect(() => {
    // Project files retain the selected font. Load it whenever this value arrives through
    // project restoration or a shared-style link, not only after a direct user selection.
    void loadLabelFont({ family: font.family, weight: font.weight });
  }, [font.family, font.weight]);
  // The font the picker opened with: Cancel restores it, even when this machine lacks the font.
  const openFont = useRef<LabelFont | null>(null);
  const commit = (next: LabelFont) => {
    const request = ++latestRequest.current;
    // The default, already-loaded and open-time fonts apply synchronously: the picker's Cancel
    // restores the open-time font and then re-enables the link, and that order must not be inverted
    // by a promise. An unloaded font renders as the bundled Roboto until it loads.
    if (!next.family.trim() || isLabelFontLoaded(next) || (openFont.current !== null && labelFontEquals(next, openFont.current))) {
      onChange(next);
      return;
    }
    void loadLabelFont(next).then(() => { if (request === latestRequest.current) onChange(next); });
  };
  return <LinkedFontRow label={m["image_export.label_font_family"]()} font={font} onChange={commit} onOpen={() => { openFont.current = font; }} linkTarget={linkTarget} warningKinds={warningKinds} />;
}
