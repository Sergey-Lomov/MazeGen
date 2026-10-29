import React from "react";
import { useMazeStore } from "../store/mazeStore";
import { typography, disabled } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Canvas hint (GitHub issue #882): the Image Export card is open but no export renderer is
 *  selected, so the canvas draws nothing. Disappears as soon as a renderer is chosen. */
export function NoExportRendererHint() {
  const visible = useMazeStore((s) => s.openCard === "image_export" && s.activeRenderMode === null);
  if (!visible) return null;
  return <div style={styles.hint}>{m["image_export.no_renderer_hint"]()}</div>;
}

const styles: Record<string, React.CSSProperties> = {
  hint: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    pointerEvents: "none",
    ...disabled(typography.body),
  },
};
