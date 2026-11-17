import React, { useState } from "react";
import { sharedStyles } from "../styles/shared";
import { FontPickerPanel } from "./FontPickerPanel";
import type { LabelFont } from "../pixi/renderers/fontChoice";
import { formatLabelFont } from "../store/fontLabels";
import type { TextFitKind } from "../pixi/selectors/exportWarnings";

interface Props {
  /** Current font; the empty family is the bundled vector (MSDF) Roboto. */
  font: LabelFont;
  onChange: (font: LabelFont) => void;
  disabled?: boolean;
  /** Picker header, usually the row label. */
  title?: string;
  /** Live-preview handler for the open picker, same contract as `ColorSwatch`: called with the
   *  highlighted font on every change and once with the open-time font on cancel. Defaults to
   *  `onChange`, so the live stream is the commit and Apply only closes the panel. */
  onPreview?: (font: LabelFont) => void;
  /** Called once right before the picker opens, to snapshot state the call site restores on cancel. */
  onOpen?: () => void;
  /** Called once when the user cancels the open picker. */
  onCancel?: () => void;
  /** Forwarded to `FontPickerPanel`: the canvas texts this font drives, whose overflow warnings the picker shows. */
  warningKinds?: TextFitKind[];
}

/** Display name of a stored font: the family and the weight name ("Roboto, Bold"). */
export function fontDisplayName(font: LabelFont): string {
  return formatLabelFont(font);
}

/** Button showing the current font name; clicking opens `FontPickerPanel`. Replaces the family
 *  dropdown / text field, the font counterpart of `ColorSwatch`. */
export function FontButton({ font, onChange, disabled, title, onPreview, onOpen, onCancel, warningKinds }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);

  function open() {
    onOpen?.();
    setPickerOpen(true);
  }

  return (
    <>
      <button
        type="button"
        style={{ ...sharedStyles.selectSm, ...styles.button, ...(disabled ? styles.disabled : {}) }}
        disabled={disabled}
        onClick={open}
        data-testid="font-button"
      >
        {fontDisplayName(font)}
      </button>
      {pickerOpen && (
        <FontPickerPanel
          font={font}
          title={title}
          // Same commit timing as `ColorSwatch`: with a distinct `onPreview` channel Apply is the one
          // and only `onChange` commit; with the default the live stream already committed.
          onApply={(next) => { if (onPreview) onChange(next); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
          onPreview={onPreview ?? onChange}
          onCancel={onCancel}
          warningKinds={warningKinds}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    // Fits its text, grows toward the label up to `maxWidth` (the label keeps the rest of the row),
    // and only then cuts the name with an ellipsis. 140 px is the floor so short names line up.
    minWidth: 140,
    maxWidth: "65%",
    flex: "0 1 auto",
    padding: "2px 6px",
    textAlign: "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    backgroundImage: "none",
    cursor: "default",
  },
  disabled: { opacity: 0.4 },
};
