import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, spacing, ui } from "../styles/theme";
import {
  colorToHex,
  colorToOklch,
  oklchToColor,
  oklchInSrgb,
  oklchMaxChroma,
  oklchToSrgbSample,
  OKLCH_MAX_CHROMA,
  type Oklch,
} from "./colorFormat";
import { GradientSlider } from "./GradientSlider";
import { useChannelInputs, parseChannelInput } from "./useChannelInputs";
import { usePickerDrag } from "./usePickerDrag";
import { pickerAreaStyles } from "./pickerAreaStyles";
import * as m from "~/paraglide/messages";

interface Props {
  /** Working color as a packed 24-bit RGB number. */
  color: number;
  /** Called with the new packed (gamut-clamped) color on every slider / input edit. */
  onChange: (color: number) => void;
}

type Channel = "l" | "c" | "h";

const CHANNELS: { key: Channel; label: () => string; max: number; step: number; decimals: number }[] = [
  { key: "l", label: () => m["color_picker.channel.ok_l"](), max: 100, step: 1, decimals: 0 },
  { key: "c", label: () => m["color_picker.channel.ok_c"](), max: OKLCH_MAX_CHROMA, step: 0.001, decimals: 4 },
  { key: "h", label: () => m["color_picker.channel.ok_h"](), max: 360, step: 1, decimals: 0 },
];

/** Gradient track for one channel: that channel swept across its range with the other two fixed.
 *  The C track additionally hatches the region past the sRGB gamut for the current L and H. */
function channelGradient(oklch: Oklch, ch: Channel): string {
  const at = (v: number) => colorToHex(oklchToColor({ ...oklch, [ch]: v }));
  if (ch === "h") {
    const stops = [0, 60, 120, 180, 240, 300, 360].map((h) => at(h));
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }
  if (ch === "l") return `linear-gradient(to right, ${at(0)}, ${at(50)}, ${at(100)})`;
  // C: grey -> fully saturated, with the out-of-gamut tail dimmed + hatched.
  const limit = oklchMaxChroma(oklch.l, oklch.h);
  const pct = Math.max(0, Math.min(100, (limit / OKLCH_MAX_CHROMA) * 100));
  const sweep = `linear-gradient(to right, ${at(0)}, ${at(OKLCH_MAX_CHROMA)})`;
  const hatch =
    `repeating-linear-gradient(45deg, ` +
    `rgba(0,0,0,0.35) 0 3px, rgba(0,0,0,0) 3px 6px)`;
  const mask = `linear-gradient(to right, rgba(0,0,0,0) ${pct}%, rgba(0,0,0,0.4) ${pct}%)`;
  return `${hatch} ${pct}% / ${100 - pct}% 100% no-repeat, ${mask}, ${sweep}`;
}

// 2D area backing-bitmap resolution. Small — the plane is a smooth gamut map, CSS scales it up to
// the rendered size; painting it full-res on every hue change would stutter the hue drag.
const AREA_COLS = 96;
const AREA_ROWS = 72;

// The hue strip's gradient is a fixed full-spectrum sweep (constant L / C) — build it once.
const HUE_STRIP_GRADIENT =
  `linear-gradient(to bottom, ` +
  [0, 45, 90, 135, 180, 225, 270, 315, 360]
    .map((h) => colorToHex(oklchToColor({ l: 70, c: OKLCH_MAX_CHROMA, h })))
    .join(", ") +
  `)`;

/** Paint the L (Y, 100 top → 0 bottom) × C (X, 0 → OKLCH_MAX_CHROMA) plane at a fixed hue onto
 *  `canvas`. Every cell shows its gamut-clamped sRGB color — the out-of-gamut region is left as is
 *  (the C slider track marks that boundary instead). */
function paintLcPlane(canvas: HTMLCanvasElement, h: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(AREA_COLS, AREA_ROWS);
  const data = img.data;
  for (let row = 0; row < AREA_ROWS; row++) {
    const l = (1 - row / (AREA_ROWS - 1)) * 100;
    for (let col = 0; col < AREA_COLS; col++) {
      const c = (col / (AREA_COLS - 1)) * OKLCH_MAX_CHROMA;
      const s = oklchToSrgbSample({ l, c, h });
      const i = (row * AREA_COLS + col) * 4;
      data[i] = s.r;
      data[i + 1] = s.g;
      data[i + 2] = s.b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** OKLCH editing model for `ColorPickerPanel` (GitHub issue #502, sub-issue of #498). A 2D area
 *  (chroma on X, lightness on Y) with a draggable crosshair (each cell painted as its clamped sRGB
 *  color), a vertical hue strip with a draggable marker, plus three gradient sliders
 *  (L 0-100%, C 0-`OKLCH_MAX_CHROMA`, H 0-360 degrees) each paired with a numeric input. The C
 *  slider track marks the out-of-gamut region; a persistent badge below the sliders reads
 *  "Converts to sRGB precisely / imprecisely" depending on whether the current OKLCH is in gamut.
 *
 *  OKLCH is held in local state as the source of truth: the committed color is always the
 *  gamut-clamped sRGB value, so packing to RGB and reading it back would drift the other channels
 *  after a clamp. State is re-seeded from `color` only on an outside change (shared hex field,
 *  model switch); the editor's own edits are tracked via `useChannelInputs`. Conversion is
 *  OKLCH <-> OKLab <-> linear sRGB <-> sRGB per the CSS Color 4 / Bjorn Ottosson definitions. */
export function OklchModelEditor({ color, onChange }: Props) {
  const [oklch, setOklch] = useState<Oklch>(() => colorToOklch(color));
  const oklchRef = useRef(oklch);
  oklchRef.current = oklch;

  const reseed = useCallback((next: number) => {
    const seeded = colorToOklch(next);
    oklchRef.current = seeded;
    setOklch(seeded);
  }, []);
  const { buffers, markSelfEdit, setBuffer, clearBuffer } = useChannelInputs<Channel>(color, reseed);

  const commit = useCallback(
    (next: Partial<Oklch>) => {
      const merged = { ...oklchRef.current, ...next };
      oklchRef.current = merged;
      const packed = oklchToColor(merged);
      markSelfEdit(packed);
      setOklch(merged);
      onChange(packed);
    },
    [markSelfEdit, onChange],
  );

  function commitChannel(ch: Channel, value: number) {
    commit({ [ch]: value });
  }

  function handleInput(ch: Channel, raw: string, max: number) {
    setBuffer(ch, raw);
    const value = parseChannelInput(raw, max);
    if (value !== null) commitChannel(ch, value);
  }

  // --- 2D area (chroma X, lightness Y — Y inverted so lighter is at the top) ---
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) paintLcPlane(canvasRef.current, oklch.h);
  }, [oklch.h]);

  const { ref: areaRef, onPointerDown: onAreaPointerDown } = usePickerDrag(
    useCallback(
      ({ x, y }) => {
        clearBuffer("c");
        clearBuffer("l");
        commit({ c: x * OKLCH_MAX_CHROMA, l: (1 - y) * 100 });
      },
      [commit, clearBuffer],
    ),
  );

  const onAreaKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const cur = oklchRef.current;
      let c = cur.c;
      let l = cur.l;
      const cStep = e.shiftKey ? 0.05 : 0.005;
      const lStep = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") c -= cStep;
      else if (e.key === "ArrowRight") c += cStep;
      else if (e.key === "ArrowUp") l += lStep;
      else if (e.key === "ArrowDown") l -= lStep;
      else return;
      e.preventDefault();
      commit({
        c: Math.max(0, Math.min(OKLCH_MAX_CHROMA, c)),
        l: Math.max(0, Math.min(100, l)),
      });
    },
    [commit],
  );

  const { ref: hueRef, onPointerDown: onHuePointerDown } = usePickerDrag(
    useCallback(
      ({ y }) => {
        clearBuffer("h");
        commit({ h: y * 360 });
      },
      [commit, clearBuffer],
    ),
  );

  const onHueKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1;
      let h = oklchRef.current.h;
      if (e.key === "ArrowUp") h -= step;
      else if (e.key === "ArrowDown") h += step;
      else return;
      e.preventDefault();
      commit({ h: Math.max(0, Math.min(360, h)) });
    },
    [commit],
  );

  const hex = colorToHex(color);
  const outOfGamut = !oklchInSrgb(oklch);
  const hueOnlyHex = colorToHex(oklchToColor({ l: 70, c: OKLCH_MAX_CHROMA, h: oklch.h }));
  // The C track's gradient runs an `oklchMaxChroma` bisection — recompute only when OKLCH moves,
  // not on every unrelated render.
  const trackBackgrounds = useMemo(
    () => ({
      l: channelGradient(oklch, "l"),
      c: channelGradient(oklch, "c"),
      h: channelGradient(oklch, "h"),
    }),
    [oklch],
  );

  return (
    <div style={styles.root} data-testid="color-picker-oklch">
      <div style={styles.pickers}>
        <div
          ref={areaRef}
          style={styles.area}
          role="slider"
          tabIndex={0}
          aria-label={m["color_picker.oklch.area_label"]()}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(oklch.l)}
          aria-valuetext={`L ${Math.round(oklch.l)}, C ${oklch.c.toFixed(3)}`}
          data-testid="color-picker-oklch-area"
          onKeyDown={onAreaKeyDown}
          onPointerDown={onAreaPointerDown}
        >
          <canvas
            ref={canvasRef}
            width={AREA_COLS}
            height={AREA_ROWS}
            style={styles.areaCanvas}
          />
          <div
            style={{
              ...styles.crosshair,
              left: `${(oklch.c / OKLCH_MAX_CHROMA) * 100}%`,
              top: `${100 - oklch.l}%`,
              background: hex,
            }}
            data-testid="color-picker-oklch-crosshair"
          />
        </div>
        <div
          ref={hueRef}
          style={{ ...styles.hueStrip, background: HUE_STRIP_GRADIENT }}
          role="slider"
          tabIndex={0}
          aria-label={m["color_picker.oklch.hue_label"]()}
          aria-valuenow={Math.round(oklch.h)}
          aria-valuemin={0}
          aria-valuemax={360}
          data-testid="color-picker-oklch-hue"
          onKeyDown={onHueKeyDown}
          onPointerDown={onHuePointerDown}
        >
          <div
            style={{ ...styles.hueMarker, top: `${(oklch.h / 360) * 100}%`, background: hueOnlyHex }}
            data-testid="color-picker-oklch-hue-marker"
          />
        </div>
      </div>
      {CHANNELS.map(({ key, label, max, step, decimals }) => (
        <div key={key} style={styles.row}>
          <span style={styles.label}>{label()}</span>
          <GradientSlider
            min={0}
            max={max}
            step={step}
            value={oklch[key]}
            aria-label={label()}
            style={styles.slider}
            trackBackground={trackBackgrounds[key]}
            thumbColor={hex}
            onChange={(v) => { clearBuffer(key); commitChannel(key, v); }}
          />
          <input
            type="number"
            name={`oklch-${key}`}
            min={0}
            max={max}
            step={step}
            value={buffers[key] ?? oklch[key].toFixed(decimals)}
            aria-label={`${label()} value`}
            style={styles.number}
            onChange={(e) => handleInput(key, e.target.value, max)}
            onBlur={() => clearBuffer(key)}
          />
        </div>
      ))}
      <span
        style={outOfGamut ? styles.badge : styles.badgeOk}
        data-testid="color-picker-oklch-gamut-badge"
        data-out-of-gamut={outOfGamut}
      >
        {outOfGamut
          ? m["color_picker.oklch.out_of_srgb"]()
          : m["color_picker.oklch.in_srgb"]()}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.groupGap },
  ...pickerAreaStyles,
  // `overflow: hidden` clips the CSS-scaled canvas to the rounded corners.
  area: { ...pickerAreaStyles.area, overflow: "hidden" },
  // Always rendered (below the sliders) so it never reflows the layout — only its text and colour
  // change between the in-gamut and out-of-gamut states.
  badge: {
    ...typography.caption,
    alignSelf: "center",
    textAlign: "center",
    padding: "2px 6px",
    borderRadius: 4,
    background: ui.bg.warning,
    color: ui.text.warning,
  },
  badgeOk: {
    ...typography.caption,
    alignSelf: "center",
    textAlign: "center",
    padding: "2px 6px",
    borderRadius: 4,
    color: ui.text.tertiary,
  },
  areaCanvas: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    // Smooth the small backing bitmap up to the rendered size.
    imageRendering: "auto",
  },
  row: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  label: { ...typography.body, width: 16, flexShrink: 0 },
  slider: { flex: 1 },
  number: { ...sharedStyles.textFieldSm, width: 64, flexShrink: 0 },
};
