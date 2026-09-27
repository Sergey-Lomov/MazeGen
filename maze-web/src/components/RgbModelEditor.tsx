import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing } from "../styles/theme";
import { colorToHex, colorToRgb, rgbToColor, type Rgb } from "./colorFormat";
import { GradientSlider } from "./GradientSlider";
import { useChannelInputs, parseChannelInput } from "./useChannelInputs";
import * as m from "~/paraglide/messages";

interface Props {
  /** Working color as a packed 24-bit RGB number. */
  color: number;
  /** Called with the new packed color on every slider / input edit. */
  onChange: (color: number) => void;
}

type Channel = "r" | "g" | "b";

const CHANNELS: { key: Channel; label: () => string }[] = [
  { key: "r", label: () => m["color_picker.channel.r"]() },
  { key: "g", label: () => m["color_picker.channel.g"]() },
  { key: "b", label: () => m["color_picker.channel.b"]() },
];

/** Build the gradient track for one channel: the current color with that channel swept 0 → 255. */
function channelGradient(rgb: Rgb, ch: Channel): string {
  const at = (v: number) => colorToHex(rgbToColor({ ...rgb, [ch]: v }));
  return `linear-gradient(to right, ${at(0)}, ${at(255)})`;
}

/** RGB editing model for `ColorPickerPanel` (GitHub issue #500, sub-issue of #498). Three channel
 *  sliders (0-255) with a gradient track showing where the color moves along that channel, each
 *  paired with a numeric input. Any edit updates the working color; the panel keeps the shared
 *  preview and hex field in sync. */
export function RgbModelEditor({ color, onChange }: Props) {
  const rgb = colorToRgb(color);
  const { buffers, markSelfEdit, setBuffer, clearBuffer } = useChannelInputs<Channel>(color);

  function commit(ch: Channel, value: number) {
    const next = rgbToColor({ ...rgb, [ch]: value });
    markSelfEdit(next);
    onChange(next);
  }

  function handleInput(ch: Channel, raw: string) {
    setBuffer(ch, raw);
    const value = parseChannelInput(raw, 255);
    if (value !== null) commit(ch, value);
  }

  return (
    <div style={styles.root} data-testid="color-picker-rgb">
      {CHANNELS.map(({ key, label }) => (
        <div key={key} style={styles.row}>
          <span style={styles.label}>{label()}</span>
          <GradientSlider
            min={0}
            max={255}
            value={rgb[key]}
            aria-label={label()}
            style={styles.slider}
            trackBackground={channelGradient(rgb, key)}
            thumbColor={colorToHex(color)}
            onChange={(v) => { clearBuffer(key); commit(key, v); }}
          />
          <input
            type="number"
            name={`rgb-${key}`}
            min={0}
            max={255}
            step={1}
            value={buffers[key] ?? String(rgb[key])}
            aria-label={`${label()} value`}
            style={styles.number}
            onChange={(e) => handleInput(key, e.target.value)}
            onBlur={() => clearBuffer(key)}
          />
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.groupGap },
  row: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  label: { ...typography.body, width: 16, flexShrink: 0 },
  // Geometry (track height, thumb, states) lives in `.gradient-slider` in global.css; only the
  // per-channel gradient + `--thumb-color` are set inline.
  slider: { flex: 1 },
  number: { ...sharedStyles.textFieldSm, width: 52, flexShrink: 0 },
};
