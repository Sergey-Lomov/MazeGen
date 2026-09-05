import { useEffect, useRef, useState } from "react";
import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing } from "../styles/theme";
import { colorToHex, colorToRgb, rgbToColor, type Rgb } from "./colorFormat";
import { GradientSlider } from "./GradientSlider";
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
  // Text buffer per channel so an in-progress / empty input isn't forced back to a number mid-edit.
  const [buffers, setBuffers] = useState<Partial<Record<Channel, string>>>({});

  // Drop stale input buffers when the color changes from *outside* this editor (the shared hex
  // field, or another channel) — otherwise a numeric input keeps showing text that no longer
  // matches its channel until it loses focus. A change this editor itself produced (tracked via
  // `expectedColor`) is left alone so an in-progress edit isn't wiped.
  const expectedColor = useRef(color);
  useEffect(() => {
    if (color !== expectedColor.current) {
      expectedColor.current = color;
      setBuffers({});
    }
  }, [color]);

  function commit(ch: Channel, value: number) {
    const next = rgbToColor({ ...rgb, [ch]: value });
    expectedColor.current = next;
    onChange(next);
  }

  function handleInput(ch: Channel, raw: string) {
    setBuffers((b) => ({ ...b, [ch]: raw }));
    if (raw.trim() === "") return;
    const n = Number(raw);
    if (Number.isFinite(n)) commit(ch, Math.max(0, Math.min(255, n)));
  }

  function clearBuffer(ch: Channel) {
    setBuffers((b) => {
      const next = { ...b };
      delete next[ch];
      return next;
    });
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
