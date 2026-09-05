import { useState } from "react";
import { SidePanel } from "./SidePanel";
import { Button } from "./Button";
import { TextFieldRow } from "./TextFieldRow";
import { ui, radius, typography, spacing } from "../styles/theme";
import { HEX_COLOR_RE, colorToHex, hexToColor } from "./colorFormat";
import { RgbModelEditor } from "./RgbModelEditor";
import { HslModelEditor } from "./HslModelEditor";
import * as m from "~/paraglide/messages";
import type React from "react";

/** Color models the picker can drive. `rgb` ships in #500, `hsl` in #501; later sub-issues add more. */
type ColorModel = "rgb" | "hsl";

const MODELS: { key: ColorModel; label: () => string }[] = [
  { key: "rgb", label: () => m["color_picker.model.rgb"]() },
  { key: "hsl", label: () => m["color_picker.model.hsl"]() },
];

interface Props {
  /** Color the swatch currently holds, used to seed the working color on open. */
  color: number;
  /** Commit handler — called once with the working color when the user hits "Apply". */
  onApply: (color: number) => void;
  /** Dismiss handler — called on "Cancel", the header close button, or Escape. */
  onClose: () => void;
}

/** Shell of the custom color picker (GitHub issue #499, sub-issue of #498). Opens as a `SidePanel`
 *  overlay covering whatever panel is currently docked beside the canvas, seeded with the swatch's
 *  color. Holds a working color in local state: a large live preview plus an editable hex field.
 *  "Apply" commits via `onApply` and closes; "Cancel" closes without touching the swatch. Per-model
 *  editing controls (square, hue strip, channel sliders) come in later sub-issues. */
export function ColorPickerPanel({ color, onApply, onClose }: Props) {
  const [working, setWorking] = useState(color);
  const [hexInput, setHexInput] = useState(() => colorToHex(color));
  const [model, setModel] = useState<ColorModel>("rgb");

  const hexValid = HEX_COLOR_RE.test(hexInput);

  /** Update the working color from a model editor and re-sync the shared hex field. */
  function setWorkingColor(next: number) {
    setWorking(next);
    setHexInput(colorToHex(next));
  }

  function handleHexChange(next: string) {
    setHexInput(next);
    if (HEX_COLOR_RE.test(next)) setWorking(hexToColor(next));
  }

  return (
    <SidePanel title={m["color_picker.title"]()} onClose={onClose} overlay>
      {/* `tabIndex` so the container itself can hold focus and receive Escape even when the click
       *  that opened the picker landed on a non-focusable element. */}
      <div
        style={styles.body}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
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
        </div>
        <div style={styles.footer}>
          <Button variant="secondary" layoutStyle={styles.footerBtn} onClick={onClose}>
            {m["common.cancel"]()}
          </Button>
          <Button variant="primary" layoutStyle={styles.footerBtn} disabled={!hexValid} onClick={() => onApply(working)}>
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
