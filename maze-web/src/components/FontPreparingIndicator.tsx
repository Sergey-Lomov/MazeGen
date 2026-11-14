import React, { useEffect, useState, useSyncExternalStore } from "react";
import { isRasterWorkBusy, subscribeRasterWork } from "../pixi/renderers/rasterFont/rasterFontStore";
import { ui, typography, radius } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** How long a font conversion must run before the indicator appears: quick ones finish unnoticed. */
export const INDICATOR_DELAY_MS = 500;

/** A small unobtrusive "Preparing fonts" note while an MSDF atlas is being built in the background
 *  (GitHub issue #966). It says nothing about which font, weight or glyph: the user only needs to know
 *  that the text may still change its rendering shortly. */
export function FontPreparingIndicator() {
  const busy = useSyncExternalStore(subscribeRasterWork, isRasterWorkBusy);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!busy) { setVisible(false); return; }
    const timer = setTimeout(() => setVisible(true), INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  if (!visible) return null;
  return (
    <div role="status" style={styles.note} data-testid="font-preparing-indicator">
      {m["font_picker.preparing"]()}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  note: {
    ...typography.caption,
    position: "absolute",
    right: 12,
    top: 12,
    padding: "3px 8px",
    borderRadius: radius.md,
    background: ui.bg.input,
    color: ui.text.secondary,
    pointerEvents: "none",
    opacity: 0.9,
  },
};
