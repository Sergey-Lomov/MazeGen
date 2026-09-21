import { useMemo, useState } from "react";
import type React from "react";
import { Maximize2, RotateCcw } from "lucide-react";
import { SectionHeader } from "./SectionHeader";
import { SelectRow } from "./SelectRow";
import { SliderRow } from "./SliderRow";
import { Button } from "./Button";
import { HoverIconButton } from "./HoverIconButton";
import { colorToHex, colorToOklch, oklchToColor, oklchMaxChroma, OKLCH_MAX_CHROMA, type Oklch } from "./colorFormat";
import { ui, spacing, font, indent } from "../styles/theme";
import * as m from "~/paraglide/messages";

type ToolType = "complementary" | "triadic" | "split_complementary" | "tetradic" | "divergence" | "range_split";

/** The OKLCH channel a `divergence` / `range_split` tool operates on — the other two channels are
 *  kept from the base (chroma still gamut-compensated per `gamutSafeSwatch`). */
type Scale = "h" | "l" | "c";

const TYPES: { key: ToolType; label: () => string }[] = [
  { key: "divergence", label: () => m["color_picker.tools.type.divergence"]() },
  { key: "range_split", label: () => m["color_picker.tools.type.range_split"]() },
  { key: "complementary", label: () => m["color_picker.tools.type.complementary"]() },
  { key: "split_complementary", label: () => m["color_picker.tools.type.split_complementary"]() },
  { key: "triadic", label: () => m["color_picker.tools.type.triadic"]() },
  { key: "tetradic", label: () => m["color_picker.tools.type.tetradic"]() },
];

const SCALES: { key: Scale; label: () => string }[] = [
  { key: "h", label: () => m["color_picker.tools.scale.hue"]() },
  { key: "l", label: () => m["color_picker.tools.scale.lightness"]() },
  { key: "c", label: () => m["color_picker.tools.scale.chroma"]() },
];

const DIVERGENCE_DEFAULT_COUNT = 4;
const DIVERGENCE_DEFAULT_STEP: Record<Scale, number> = { h: 30, l: 15, c: OKLCH_MAX_CHROMA / 8 };
const DIVERGENCE_MAX_STEP: Record<Scale, number> = { h: 60, l: 50, c: OKLCH_MAX_CHROMA / 2 };
const DIVERGENCE_HUE_MAX_SPREAD = 60;
const RANGE_SPLIT_COUNT_MIN = 3;
const RANGE_SPLIT_COUNT_MAX = 12;
const RANGE_SPLIT_COUNT_DEFAULT = 7;
const RANGE_SPLIT_AUTO_MIN: Record<Scale, number> = { h: 0, l: 15, c: 0 };
const RANGE_SPLIT_AUTO_MAX: Record<Scale, number> = { h: 360, l: 95, c: OKLCH_MAX_CHROMA };

/** Module-level persistence for the Tools section's own settings (GitHub issues #504, #505
 *  follow-up). `ColorPickerPanel` remounts the section fresh on every open, but the picked tool
 *  type and each type's own tuning should survive across opens — kept here rather than threaded
 *  through the call sites, since it's the picker's own UI state, not anything a caller needs to
 *  know about. Persists for the lifetime of the page (no localStorage); intentionally shared
 *  across every field's picker — "last used tool setup" is a single global preference, not
 *  per-field. */
const persisted = {
  type: "complementary" as ToolType,
  divergence: {
    scale: "h" as Scale,
    count: DIVERGENCE_DEFAULT_COUNT,
    step: { ...DIVERGENCE_DEFAULT_STEP },
  },
  rangeSplit: {
    scale: "h" as Scale,
    count: RANGE_SPLIT_COUNT_DEFAULT,
    min: { ...RANGE_SPLIT_AUTO_MIN },
    max: { ...RANGE_SPLIT_AUTO_MAX },
  },
};

/** Hue offsets (degrees) applied to the base color's OKLCH hue for each fixed-rule harmony type. */
function fixedOffsets(type: Exclude<ToolType, "divergence" | "range_split">): number[] {
  switch (type) {
    case "complementary": return [180];
    case "triadic": return [120, 240];
    case "split_complementary": return [150, 210];
    case "tetradic": return [90, 180, 270];
  }
}

/** Offsets on one side of the base: `count` steps at `step`, `2*step`, … `count*step`, the base
 *  itself not included — the two rows (positive and negative offsets) are built by calling this
 *  once per sign. Shared by `divergence`'s H/L/C scales. */
function divergenceOffsets(count: number, step: number): number[] {
  return Array.from({ length: count }, (_, i) => step * (i + 1));
}

/** The step (per unit) that makes `count` steps exactly cover the hue scale's own auto-spread span
 *  (180°, `DIVERGENCE_HUE_MAX_SPREAD`-capped) from the base, in either direction — same "auto-fit"
 *  idea as the old Analogous control, kept for the Hue scale only (Lightness / Chroma have no
 *  natural full-span target the way hue's 180° opposite point does). */
function autoFitHueStep(count: number): number {
  return Math.min(DIVERGENCE_HUE_MAX_SPREAD, 180 / count);
}

/** Evenly spaced values from `min` to `max` (inclusive), `count` steps — `range_split`'s H/L/C
 *  scales share this shape. */
function rangeSteps(count: number, min: number, max: number): number[] {
  if (count === 1) return [(min + max) / 2];
  return Array.from({ length: count }, (_, i) => min + ((max - min) * i) / (count - 1));
}

/** Build a swatch at `(l, h)`, scaling the base's chroma down by how much the sRGB gamut has
 *  narrowed at `(l, h)` relative to the base. Rotating hue or shifting lightness can push a chroma
 *  that was valid at the base out of gamut; `oklchToColor`'s per-channel clamp would then shift
 *  the hue as a side effect instead of just desaturating. A hard `min(c, oklchMaxChroma(l, h))`
 *  avoids the hue shift but still looks abrupt: the gamut's chroma ceiling falls off steeply near
 *  L's extremes, so a swatch can go from "untouched" to "heavily cut" within one or two steps.
 *  Scaling by the ratio of ceilings instead fades chroma out gradually across the whole range. */
function gamutSafeSwatch(baseOklch: Oklch, l: number, h: number): number {
  const baseMax = oklchMaxChroma(baseOklch.l, baseOklch.h);
  const targetMax = oklchMaxChroma(l, h);
  const ratio = baseMax > 1e-4 ? Math.min(1, targetMax / baseMax) : 1;
  const c = Math.min(baseOklch.c * ratio, targetMax);
  return oklchToColor({ l, c, h });
}

/** Build a swatch by overriding one OKLCH channel (`scale`) to `value`, the other two kept from
 *  `baseOklch` — the Chroma scale bypasses `gamutSafeSwatch`'s ratio scaling (it *is* the chroma
 *  being swept, clamped to what's in gamut at the base's own L/H) so an explicit chroma value
 *  isn't silently rescaled. */
function swatchAt(baseOklch: Oklch, scale: Scale, value: number): number {
  if (scale === "h") return gamutSafeSwatch(baseOklch, baseOklch.l, value);
  if (scale === "l") return gamutSafeSwatch(baseOklch, value, baseOklch.h);
  const maxC = oklchMaxChroma(baseOklch.l, baseOklch.h);
  return oklchToColor({ l: baseOklch.l, c: Math.max(0, Math.min(maxC, value)), h: baseOklch.h });
}

/** "Tools" section (GitHub issues #504 and #505, sub-issues of #498) — below the active model
 *  editor in `ColorPickerPanel`, separated from it by a divider. Holds its own base color (seeded
 *  from the color the panel opened with) and a tool-type selector; derives swatches from the base
 *  per the selected rule.
 *
 *  Complementary/Triadic/Split-complementary/Tetradic are the classic fixed-offset color-wheel
 *  rules: they rotate the base's OKLCH hue by fixed degrees (chroma and lightness kept).
 *
 *  Divergence and Range split are general tools parameterized by a `Scale` (Hue / Lightness /
 *  Chroma) — the other two OKLCH channels stay fixed at the base's own values (gamut-compensated,
 *  see `gamutSafeSwatch`):
 *  - Divergence: two rows (+ / -) of `count` swatches stepping away from the base by `step`,
 *    `2*step`, … on the chosen scale. Generalizes the old Analogous (Hue) and Monochromatic
 *    (Lightness) tools; Chroma is the new third case.
 *  - Range split: a single row of `count` swatches evenly spaced across a min/max range on the
 *    chosen scale — the base's own value isn't necessarily included. Hue's range is fixed at the
 *    full 0-360° circle (wrapping, so min/max don't apply); Lightness and Chroma default to an
 *    auto range, adjustable via min/max sliders. Generalizes the old Tonal ramp (Lightness).
 *
 *  Clicking a swatch sets the picker's working color only — it never rebuilds the row(s). The
 *  "Rebuild from current color" button (below the swatches, same style as "Project colors"'
 *  "Show all") rebuilds from the picker's current working color, for any tool type; editing
 *  sliders / hex never does. */
export function ToolsSection({ seedColor, workingColor, onPick }: {
  /** The color the picker opened with — seeds the section's own base color once, on mount. */
  seedColor: number;
  /** The picker's current working color, read only by "Rebuild from current color". */
  workingColor: number;
  /** Set the picker's working color (same path as a project-color row — does not commit). */
  onPick: (color: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [base, setBase] = useState(seedColor);
  const [type, setTypeState] = useState<ToolType>(persisted.type);
  const [divScale, setDivScaleState] = useState(persisted.divergence.scale);
  const [divCount, setDivCountState] = useState(persisted.divergence.count);
  const [divStep, setDivStepState] = useState(persisted.divergence.step);
  const [rangeScale, setRangeScaleState] = useState(persisted.rangeSplit.scale);
  const [rangeCount, setRangeCountState] = useState(persisted.rangeSplit.count);
  const [rangeMin, setRangeMinState] = useState(persisted.rangeSplit.min);
  const [rangeMax, setRangeMaxState] = useState(persisted.rangeSplit.max);

  function setType(next: ToolType) {
    persisted.type = next;
    setTypeState(next);
  }
  function setDivScale(next: Scale) {
    persisted.divergence.scale = next;
    setDivScaleState(next);
  }
  function setDivCount(next: number) {
    persisted.divergence.count = next;
    setDivCountState(next);
  }
  function setDivStep(next: number) {
    persisted.divergence.step[divScale] = next;
    setDivStepState({ ...persisted.divergence.step });
  }
  function setRangeScale(next: Scale) {
    persisted.rangeSplit.scale = next;
    setRangeScaleState(next);
  }
  function setRangeCount(next: number) {
    persisted.rangeSplit.count = next;
    setRangeCountState(next);
  }
  function setRangeMin(next: number) {
    persisted.rangeSplit.min[rangeScale] = next;
    setRangeMinState({ ...persisted.rangeSplit.min });
  }
  function setRangeMax(next: number) {
    persisted.rangeSplit.max[rangeScale] = next;
    setRangeMaxState({ ...persisted.rangeSplit.max });
  }

  const baseOklch = useMemo(() => colorToOklch(base), [base]);
  const baseValue = (scale: Scale) => (scale === "h" ? baseOklch.h : scale === "l" ? baseOklch.l : baseOklch.c);

  const swatches = useMemo(() => {
    if (type === "divergence" || type === "range_split") return null; // Rendered separately below.
    const derived = fixedOffsets(type).map((offset) => gamutSafeSwatch(baseOklch, baseOklch.l, baseOklch.h + offset));
    return [base, ...derived];
  }, [base, baseOklch, type]);

  // Divergence (generalizes the old Analogous / Monochromatic tools): two independent rows,
  // + and -, each `count` swatches at `step`, `2*step`, … `count*step` from the base on the
  // chosen scale's own side.
  const divergence = useMemo(() => {
    const offsets = divergenceOffsets(divCount, divStep[divScale]);
    const base0 = baseValue(divScale);
    return {
      plus: offsets.map((offset) => swatchAt(baseOklch, divScale, base0 + offset)),
      minus: offsets.map((offset) => swatchAt(baseOklch, divScale, base0 - offset)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseOklch, divScale, divCount, divStep]);

  // Range split (generalizes the old Tonal ramp): a single row, `count` swatches evenly spaced
  // across [min, max] on the chosen scale — Hue always spans the full 0-360° circle from the base
  // hue (wraps, so its own min/max sliders aren't shown).
  const rangeSplit = useMemo(() => {
    const base0 = baseValue(rangeScale);
    const values = rangeScale === "h"
      ? rangeSteps(rangeCount, base0, base0 + 360).map((v) => ((v % 360) + 360) % 360)
      : rangeSteps(
          rangeCount,
          Math.min(rangeMin[rangeScale], rangeMax[rangeScale]),
          Math.max(rangeMin[rangeScale], rangeMax[rangeScale]),
        );
    return { colors: values.map((v) => swatchAt(baseOklch, rangeScale, v)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseOklch, rangeScale, rangeCount, rangeMin, rangeMax]);

  const divStepMax = DIVERGENCE_MAX_STEP[divScale];
  const divStepFormat = divScale === "h" ? (v: number) => `${v}°` : divScale === "c" ? (v: number) => v.toFixed(3) : (v: number) => String(v);
  const rangeFormat = rangeScale === "h" ? (v: number) => `${Math.round(v)}°` : rangeScale === "c" ? (v: number) => v.toFixed(3) : (v: number) => `${Math.round(v)}%`;
  const rangeMax0 = rangeScale === "c" ? OKLCH_MAX_CHROMA : rangeScale === "h" ? 360 : 100;
  const rangeStep0 = rangeScale === "c" ? 0.001 : 1;

  return (
    <div style={styles.root}>
      <SectionHeader
        label={m["color_picker.tools"]()}
        expanded={expanded}
        onToggle={() => {
          setExpanded((v) => {
            const next = !v;
            if (next) setBase(workingColor);
            return next;
          });
        }}
      />
      {expanded && (
        <div style={styles.body}>
          <SelectRow
            label={m["color_picker.tools.type_label"]()}
            value={type}
            options={TYPES.map(({ key, label }) => ({ value: key, label: label() }))}
            onChange={(v) => setType(v)}
          />
          {type === "divergence" && (
            <>
              <SelectRow
                label={m["color_picker.tools.scale_label"]()}
                value={divScale}
                options={SCALES.map(({ key, label }) => ({ value: key, label: label() }))}
                onChange={(v) => setDivScale(v)}
              />
              <SliderRow
                label={m["color_picker.tools.count"]()}
                value={divCount}
                onChange={(v) => setDivCount(Math.round(v))}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["color_picker.tools.step"]()}
                value={divStep[divScale]}
                onChange={setDivStep}
                min={divScale === "h" ? 1 : 0}
                max={divStepMax}
                step={divScale === "c" ? 0.001 : 1}
                format={divStepFormat}
                resetButton={divScale === "h" ? (
                  <HoverIconButton onClick={() => setDivStep(autoFitHueStep(divCount))} title={m["color_picker.tools.auto_step"]()}>
                    <Maximize2 size={13} />
                  </HoverIconButton>
                ) : undefined}
              />
            </>
          )}
          {type === "range_split" && (
            <>
              <SelectRow
                label={m["color_picker.tools.scale_label"]()}
                value={rangeScale}
                options={SCALES.map(({ key, label }) => ({ value: key, label: label() }))}
                onChange={(v) => setRangeScale(v)}
              />
              <SliderRow
                label={m["color_picker.tools.count"]()}
                value={rangeCount}
                onChange={(v) => setRangeCount(Math.round(v))}
                min={RANGE_SPLIT_COUNT_MIN}
                max={RANGE_SPLIT_COUNT_MAX}
                step={1}
                format={(v) => String(v)}
              />
              {rangeScale !== "h" && (
                <>
                  <SliderRow
                    label={m["color_picker.tools.range_min"]()}
                    value={rangeMin[rangeScale]}
                    onChange={setRangeMin}
                    min={0}
                    max={rangeMax0}
                    step={rangeStep0}
                    format={rangeFormat}
                    resetButton={
                      <HoverIconButton onClick={() => setRangeMin(RANGE_SPLIT_AUTO_MIN[rangeScale])} title={m["color_picker.tools.reset_auto"]()}>
                        <RotateCcw size={13} />
                      </HoverIconButton>
                    }
                  />
                  <SliderRow
                    label={m["color_picker.tools.range_max"]()}
                    value={rangeMax[rangeScale]}
                    onChange={setRangeMax}
                    min={0}
                    max={rangeMax0}
                    step={rangeStep0}
                    format={rangeFormat}
                    resetButton={
                      <HoverIconButton onClick={() => setRangeMax(RANGE_SPLIT_AUTO_MAX[rangeScale])} title={m["color_picker.tools.reset_auto"]()}>
                        <RotateCcw size={13} />
                      </HoverIconButton>
                    }
                  />
                </>
              )}
            </>
          )}
          {type === "divergence" && (
            <div style={styles.analogousRows} data-testid="color-picker-divergence-swatches">
              <div style={styles.analogousRow}>
                <span style={styles.analogousLabel}>{m["color_picker.tools.plus"]()}</span>
                <div style={styles.swatchRow}>
                  {divergence.plus.map((color, i) => (
                    <button
                      key={i}
                      type="button"
                      className="hoverable"
                      title={colorToHex(color)}
                      style={{ ...styles.swatch, background: colorToHex(color) }}
                      onClick={() => onPick(color)}
                    />
                  ))}
                </div>
              </div>
              <div style={styles.analogousRow}>
                <span style={styles.analogousLabel}>{m["color_picker.tools.minus"]()}</span>
                <div style={styles.swatchRow}>
                  {divergence.minus.map((color, i) => (
                    <button
                      key={i}
                      type="button"
                      className="hoverable"
                      title={colorToHex(color)}
                      style={{ ...styles.swatch, background: colorToHex(color) }}
                      onClick={() => onPick(color)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          {type === "range_split" && (
            <div style={styles.swatchRow} data-testid="color-picker-range-split-swatches">
              {rangeSplit.colors.map((color, i) => (
                <button
                  key={i}
                  type="button"
                  className="hoverable"
                  title={colorToHex(color)}
                  style={{
                    ...styles.swatch,
                    background: colorToHex(color),
                  }}
                  onClick={() => onPick(color)}
                />
              ))}
            </div>
          )}
          {type !== "divergence" && type !== "range_split" && (
            <div style={styles.swatchRow} data-testid="color-picker-tools-swatches">
              {(swatches ?? []).map((color, i) => (
                <button
                  key={i}
                  type="button"
                  className="hoverable"
                  title={colorToHex(color)}
                  style={{ ...styles.swatch, background: colorToHex(color) }}
                  onClick={() => onPick(color)}
                />
              ))}
            </div>
          )}
          <Button variant="secondary" layoutStyle={styles.rebuildButton} onClick={() => setBase(workingColor)}>
            {m["color_picker.tools.rebuild_from_current"]()}
          </Button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  body: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  rebuildButton: { width: "100%", boxSizing: "border-box" as const, marginTop: spacing.itemGap },
  swatchRow: { display: "flex", gap: spacing.itemGap, flexWrap: "wrap" },
  analogousRows: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  analogousRow: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  // Same label look as every param row (`sharedStyles.sliderRowLabel`'s font/color), but its own
  // narrow fixed width — just wide enough for "Hue -" — so the swatches start right after the
  // label instead of lining up under the wider param-label column.
  analogousLabel: { fontSize: font.lg, color: ui.text.primary, width: 40, flexShrink: 0, lineHeight: 1.3 },
  swatch: {
    width: 32, height: 28, flexShrink: 0, borderRadius: 3, padding: 0,
    border: `2px solid ${ui.border.strong}`, boxSizing: "border-box",
  },
};
