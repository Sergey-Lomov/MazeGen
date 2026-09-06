import { useEffect, useRef, useState } from "react";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { TextFieldRow } from "./TextFieldRow";
import { ui, radius, typography, spacing } from "../styles/theme";
import { HEX_COLOR_RE, colorToHex, hexToColor } from "./colorFormat";
import { RgbModelEditor } from "./RgbModelEditor";
import { HslModelEditor } from "./HslModelEditor";
import { OklchModelEditor } from "./OklchModelEditor";
import * as m from "~/paraglide/messages";
import type React from "react";

/** Color models the picker can drive. `rgb` ships in #500, `hsl` in #501, `oklch` in #502; later
 *  sub-issues add more. */
type ColorModel = "rgb" | "hsl" | "oklch";

const MODELS: { key: ColorModel; label: () => string }[] = [
  { key: "rgb", label: () => m["color_picker.model.rgb"]() },
  { key: "hsl", label: () => m["color_picker.model.hsl"]() },
  { key: "oklch", label: () => m["color_picker.model.oklch"]() },
];

interface Props {
  /** Color the swatch currently holds, used to seed the working color on open. */
  color: number;
  /** Commit handler — called once with the working color when the user hits "Apply". */
  onApply: (color: number) => void;
  /** Dismiss handler — called on "Cancel", the header close button, or Escape. */
  onClose: () => void;
  /** Live-preview handler (GitHub issue #513). Called with the working color on every change while
   *  the picker is open, so the canvas can render the color in context as the user drags. On
   *  Cancel / header close / Escape it is called once more with the original `color` to restore the
   *  pre-open state; Apply leaves the last previewed color in place. Optional — a swatch whose
   *  `onChange` is cheap and side-effect-free can let `ColorSwatch` default it to `onChange`, but a
   *  call site whose `onChange` marks the maze dirty or pushes a history entry must pass a lighter
   *  handler here that only updates the render. A handler that is expensive per call should
   *  throttle itself. */
  onPreview?: (color: number) => void;
}

/** Shell of the custom color picker (GitHub issue #499, sub-issue of #498). Opens as a `SidePanel`
 *  overlay covering whatever panel is currently docked beside the canvas, seeded with the swatch's
 *  color. Holds a working color in local state: a large live preview plus an editable hex field.
 *  "Apply" commits via `onApply` and closes; "Cancel" closes without touching the swatch. Per-model
 *  editing controls (square, hue strip, channel sliders) come in later sub-issues.
 *
 *  Live canvas preview (GitHub issue #513): while open, every working-color change is pushed through
 *  `onPreview` so the canvas renders the color in context; Cancel / header close / Escape push the
 *  original color back before closing, Apply leaves the last preview in place. */
export function ColorPickerPanel({ color, onApply, onClose, onPreview }: Props) {
  const [working, setWorking] = useState(color);
  const [hexInput, setHexInput] = useState(() => colorToHex(color));
  const [model, setModel] = useState<ColorModel>("rgb");
  /** The color in effect when the picker opened. Captured once — with live preview (#513) the
   *  `color` prop tracks each previewed change (the call site's `onChange` also writes the store),
   *  so it can't be used to restore on Cancel. */
  const originalColor = useRef(color).current;

  const hexValid = HEX_COLOR_RE.test(hexInput);

  // The live preview (#513) can fire once per pointer-move tick while a model slider / 2D area is
  // dragged — far more often than once a frame, and a call site's `onPreview` may re-render a full
  // preview canvas per call. Throttle to one `onPreview` call per animation frame, always with the
  // latest color; `flushPreview` delivers a pending frame synchronously so Cancel / Apply never
  // leave a stale color pending after the picker unmounts. Same pattern as `StepSlider`.
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const pendingPreview = useRef<number | null>(null);
  const previewScheduled = useRef(false);
  const previewRafId = useRef<number | null>(null);

  useEffect(() => () => {
    if (previewRafId.current !== null) cancelAnimationFrame(previewRafId.current);
  }, []);

  function flushPreview() {
    previewScheduled.current = false;
    if (previewRafId.current !== null) {
      cancelAnimationFrame(previewRafId.current);
      previewRafId.current = null;
    }
    if (pendingPreview.current !== null) {
      onPreviewRef.current?.(pendingPreview.current);
      pendingPreview.current = null;
    }
  }

  /** Queue a live-canvas preview of the working color, coalesced to one call per animation frame. */
  function preview(next: number) {
    if (!onPreviewRef.current) return;
    pendingPreview.current = next;
    if (previewScheduled.current) return;
    previewScheduled.current = true;
    previewRafId.current = requestAnimationFrame(flushPreview);
  }

  /** Close the picker, first restoring the canvas to the color that was in effect on open. Used by
   *  Cancel, the header close button, and Escape. Restores unconditionally (even with no pending
   *  frame) — an earlier previewed color may already be on the canvas. */
  function cancel() {
    if (onPreviewRef.current) {
      pendingPreview.current = originalColor;
      flushPreview();
    }
    onClose();
  }

  /** Commit on Apply: deliver any still-queued preview frame synchronously (unmount would drop it),
   *  then hand the final color to the call site. No queued frame → nothing to flush. */
  function apply() {
    flushPreview();
    onApply(working);
  }

  /** Update the working color from a model editor and re-sync the shared hex field. */
  function setWorkingColor(next: number) {
    setWorking(next);
    setHexInput(colorToHex(next));
    preview(next);
  }

  function handleHexChange(next: string) {
    setHexInput(next);
    if (HEX_COLOR_RE.test(next)) {
      const packed = hexToColor(next);
      setWorking(packed);
      preview(packed);
    }
  }

  return (
    <SidePanel title={m["color_picker.title"]()} onClose={cancel} overlay>
      {/* `tabIndex` so the container itself can hold focus and receive Escape even when the click
       *  that opened the picker landed on a non-focusable element. */}
      <div
        style={styles.body}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}
      >
        <div style={styles.content}>
          <div style={{ ...styles.preview, background: colorToHex(working) }} data-testid="color-picker-preview" />
          <TextFieldRow
            label={m["color_picker.hex_label"]()}
            value={hexInput}
            invalid={!hexValid}
            onChange={handleHexChange}
          />
          {!hexValid && <span style={styles.hexError}>{m["color_picker.hex_invalid"]()}</span>}
          <div style={styles.modelSwitcher}>
            {MODELS.map(({ key, label }) => (
              <Button
                key={key}
                variant={model === key ? "toggle-selected" : "toggle"}
                onClick={() => setModel(key)}
              >
                {label()}
              </Button>
            ))}
          </div>
          {model === "rgb" && <RgbModelEditor color={working} onChange={setWorkingColor} />}
          {model === "hsl" && <HslModelEditor color={working} onChange={setWorkingColor} />}
          {model === "oklch" && <OklchModelEditor color={working} onChange={setWorkingColor} />}
        </div>
        <div style={styles.footer}>
          <Button variant="secondary" layoutStyle={styles.footerBtn} onClick={cancel}>
            {m["common.cancel"]()}
          </Button>
          <Button variant="primary" layoutStyle={styles.footerBtn} disabled={!hexValid} onClick={apply}>
            {m["common.apply"]()}
          </Button>
        </div>
      </div>
    </SidePanel>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, outline: "none" },
  content: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
    padding: spacing.sectionGap,
    overflowY: "auto",
  },
  preview: {
    width: "100%",
    height: 120,
    border: `2px solid ${ui.border.strong}`,
    borderRadius: radius.md,
    boxSizing: "border-box",
  },
  hexError: { ...typography.caption, color: ui.text.error },
  modelSwitcher: { display: "flex", gap: spacing.itemGap },
  footer: {
    display: "flex",
    gap: spacing.groupGap,
    padding: spacing.groupGap,
    borderTop: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  footerBtn: { flex: 1 },
};
