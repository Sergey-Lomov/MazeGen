import { useCallback, useRef, useState } from "react";
import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing } from "../styles/theme";
import { colorToHex, colorToHsl, hslToColor, type Hsl } from "./colorFormat";
import { GradientSlider } from "./GradientSlider";
import { useChannelInputs } from "./useChannelInputs";
import { ColorChannelInput } from "./ColorChannelInput";
import type { NormalizerResult } from "./inputNormalization";
import { usePickerDrag } from "./usePickerDrag";
import { pickerAreaStyles } from "./pickerAreaStyles";
import * as m from "~/paraglide/messages";

interface Props {
  /** Working color as a packed 24-bit RGB number. */
  color: number;
  /** Called with the new packed color on every area / strip / slider / input edit. */
  onChange: (color: number) => void;
}

type Channel = "h" | "s" | "l";

const CHANNELS: { key: Channel; label: () => string; max: number }[] = [
  { key: "h", label: () => m["color_picker.channel.h"](), max: 360 },
  { key: "s", label: () => m["color_picker.channel.s"](), max: 100 },
  { key: "l", label: () => m["color_picker.channel.l"](), max: 100 },
];

/** Gradient track for one channel: the current color with that channel swept across its range,
 *  the two other channels held fixed. */
function channelGradient(hsl: Hsl, ch: Channel): string {
  if (ch === "h") {
    // Full spectrum at fixed s=100 / l=50 — sweeping hue at the working color's own (possibly
    // achromatic) s/l would collapse the track to grey and make the slider unreadable.
    const stops = [0, 60, 120, 180, 240, 300, 360].map(
      (h) => colorToHex(hslToColor({ h, s: 100, l: 50 })),
    );
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }
  const at = (v: number) => colorToHex(hslToColor({ ...hsl, [ch]: v }));
  // L runs black -> current hue/sat -> white, so add the midpoint stop; S is a plain two-stop
  // sweep from grey to the fully saturated color.
  if (ch === "l") return `linear-gradient(to right, ${at(0)}, ${at(50)}, ${at(100)})`;
  return `linear-gradient(to right, ${at(0)}, ${at(100)})`;
}

/** HSL editing model for `ColorPickerPanel` (GitHub issue #501, sub-issue of #498). A 2D area
 *  (saturation on X, lightness on Y) with a draggable crosshair, a vertical hue strip with a
 *  draggable marker, three `GradientSlider`s (H 0-360, S 0-100, L 0-100) with gradient tracks, and
 *  three numeric inputs with the same ranges. Every control stays in sync; the panel keeps the
 *  shared preview and hex field in sync too.
 *
 *  HSL is held in local state as the source of truth — packing to RGB and reading back would lose
 *  hue whenever saturation or lightness hits an achromatic edge (S 0, L 0/100) and would jitter the
 *  channels through 8-bit rounding, so moving one channel must never disturb the others. State is
 *  re-seeded from `color` only when the color changes from *outside* this editor (the shared hex
 *  field, or the model switch); the editor's own edits are tracked via `expectedColor`. Conversion
 *  is exact sRGB HSL <-> RGB; reopening the picker reconstructs HSL from the stored RGB. */
export function HslModelEditor({ color, onChange }: Props) {
  const [hsl, setHsl] = useState<Hsl>(() => colorToHsl(color));
  // Kept in a ref alongside the state so `commit` can merge onto the latest value without reading
  // it inside a state updater (updaters must stay pure — StrictMode double-invokes them).
  const hslRef = useRef(hsl);
  hslRef.current = hsl;

  // On an outside color change (shared hex field, model switch) re-seed HSL from it; the hook
  // clears the input buffers. `markSelfEdit` marks the editor's own commits so hue survives an
  // achromatic S/L instead of being reconstructed from the packed RGB.
  const reseed = useCallback((next: number) => {
    const seeded = colorToHsl(next);
    hslRef.current = seeded;
    setHsl(seeded);
  }, []);
  const { buffers, markSelfEdit, setBuffer, clearBuffer } = useChannelInputs<Channel>(color, reseed);

  const commit = useCallback(
    (next: Partial<Hsl>) => {
      const merged = { ...hslRef.current, ...next };
      hslRef.current = merged;
      const packed = hslToColor(merged);
      markSelfEdit(packed);
      setHsl(merged);
      onChange(packed);
    },
    [markSelfEdit, onChange],
  );

  function commitChannel(ch: Channel, value: number) {
    commit({ [ch]: value });
  }

  function handleInput(ch: Channel, result: NormalizerResult<number | null>) {
    setBuffer(ch, result.raw);
    if (result.value !== null) commitChannel(ch, result.value);
  }

  // --- 2D area (saturation X, lightness Y — Y inverted so lighter is at the top) ---
  const { ref: areaRef, onPointerDown: onAreaPointerDown } = usePickerDrag(
    useCallback(
      ({ x, y }) => commit({ s: x * 100, l: (1 - y) * 100 }),
      [commit],
    ),
  );

  // Arrow keys nudge S / L by 1 (10 with Shift); keeps the area usable without a pointer.
  const onAreaKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1;
      const cur = hslRef.current;
      let s = cur.s;
      let l = cur.l;
      if (e.key === "ArrowLeft") s -= step;
      else if (e.key === "ArrowRight") s += step;
      else if (e.key === "ArrowUp") l += step;
      else if (e.key === "ArrowDown") l -= step;
      else return;
      e.preventDefault();
      commit({ s: Math.max(0, Math.min(100, s)), l: Math.max(0, Math.min(100, l)) });
    },
    [commit],
  );

  // --- vertical hue strip ---
  const { ref: hueRef, onPointerDown: onHuePointerDown } = usePickerDrag(
    useCallback(({ y }) => commit({ h: y * 360 }), [commit]),
  );

  // Up / Down nudge hue by 1 (10 with Shift).
  const onHueKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1;
      let h = hslRef.current.h;
      if (e.key === "ArrowUp") h -= step;
      else if (e.key === "ArrowDown") h += step;
      else return;
      e.preventDefault();
      commit({ h: Math.max(0, Math.min(360, h)) });
    },
    [commit],
  );

  const hex = colorToHex(color);
  const hueOnlyHex = colorToHex(hslToColor({ h: hsl.h, s: 100, l: 50 }));

  return (
    <div style={styles.root} data-testid="color-picker-hsl">
      <div style={styles.pickers}>
        <div
          ref={areaRef}
          style={{
            ...styles.area,
            background:
              `linear-gradient(to top, #000, transparent), ` +
              `linear-gradient(to right, #fff, ${hueOnlyHex})`,
          }}
          role="slider"
          tabIndex={0}
          aria-label={m["color_picker.hsl.area_label"]()}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsl.s)}
          aria-valuetext={`S ${Math.round(hsl.s)}, L ${Math.round(hsl.l)}`}
          data-testid="color-picker-hsl-area"
          onKeyDown={onAreaKeyDown}
          onPointerDown={onAreaPointerDown}
        >
          <div
            style={{
              ...styles.crosshair,
              left: `${hsl.s}%`,
              top: `${100 - hsl.l}%`,
              background: hex,
            }}
            data-testid="color-picker-hsl-crosshair"
          />
        </div>
        <div
          ref={hueRef}
          style={{ ...styles.hueStrip, background: HUE_STRIP_GRADIENT }}
          role="slider"
          tabIndex={0}
          aria-label={m["color_picker.hsl.hue_label"]()}
          aria-valuenow={Math.round(hsl.h)}
          aria-valuemin={0}
          aria-valuemax={360}
          data-testid="color-picker-hsl-hue"
          onKeyDown={onHueKeyDown}
          onPointerDown={onHuePointerDown}
        >
          <div
            style={{ ...styles.hueMarker, top: `${(hsl.h / 360) * 100}%` }}
            data-testid="color-picker-hsl-hue-marker"
          />
        </div>
      </div>
      {CHANNELS.map(({ key, label, max }) => (
        <div key={key} style={styles.row}>
          <span style={styles.label}>{label()}</span>
          <GradientSlider
            min={0}
            max={max}
            value={hsl[key]}
            aria-label={label()}
            style={styles.slider}
            trackBackground={channelGradient(hsl, key)}
            thumbColor={hex}
            onChange={(v) => { clearBuffer(key); commitChannel(key, v); }}
          />
          <ColorChannelInput
            name={`hsl-${key}`}
            max={max}
            step={1}
            value={buffers[key] ?? String(Math.round(hsl[key]))}
            ariaLabel={`${label()} value`}
            style={styles.number}
            onInput={(result) => handleInput(key, result)}
            onBlur={() => clearBuffer(key)}
          />
        </div>
      ))}
    </div>
  );
}

// Fixed full-spectrum sweep — the hue strip's track never depends on the working color.
const HUE_STRIP_GRADIENT =
  "linear-gradient(to bottom, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)";

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.groupGap },
  ...pickerAreaStyles,
  row: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  label: { ...typography.body, width: 16, flexShrink: 0 },
  slider: { flex: 1 },
  number: { ...sharedStyles.textFieldSm, width: 52, flexShrink: 0 },
};
