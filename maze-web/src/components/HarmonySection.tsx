import { useMemo, useState } from "react";
import type React from "react";
import { Maximize2 } from "lucide-react";
import { SectionHeader } from "./SectionHeader";
import { SelectRow } from "./SelectRow";
import { SliderRow } from "./SliderRow";
import { Button } from "./Button";
import { HoverIconButton } from "./HoverIconButton";
import { colorToHex, colorToOklch, oklchToColor, oklchMaxChroma, type Oklch } from "./colorFormat";
import { ui, spacing, font } from "../styles/theme";
import * as m from "~/paraglide/messages";

type HarmonyType = "complementary" | "triadic" | "analogous" | "split_complementary" | "tetradic" | "monochromatic";

const TYPES: { key: HarmonyType; label: () => string }[] = [
  { key: "complementary", label: () => m["color_picker.harmony.type.complementary"]() },
  { key: "split_complementary", label: () => m["color_picker.harmony.type.split_complementary"]() },
  { key: "triadic", label: () => m["color_picker.harmony.type.triadic"]() },
  { key: "tetradic", label: () => m["color_picker.harmony.type.tetradic"]() },
  { key: "analogous", label: () => m["color_picker.harmony.type.analogous"]() },
  { key: "monochromatic", label: () => m["color_picker.harmony.type.monochromatic"]() },
];

const ANALOGOUS_DEFAULT_COUNT = 6;
const ANALOGOUS_DEFAULT_SPREAD = 30;
const ANALOGOUS_MAX_SPREAD = 60;
const MONOCHROMATIC_DEFAULT_COUNT = 3;
const MONOCHROMATIC_DEFAULT_STEP = 15;

/** Module-level persistence for the Harmony section's own settings (GitHub issue #504 follow-up).
 *  `ColorPickerPanel` remounts the section fresh on every open, but the picked harmony type and
 *  each type's own tuning (currently just Analogous' count/spread) should survive across opens —
 *  kept here rather than threaded through the call sites, since it's the picker's own UI state, not
 *  anything a caller needs to know about. Persists for the lifetime of the page (no localStorage);
 *  intentionally shared across every field's picker — "last used harmony setup" is a single global
 *  preference, not per-field. */
const persisted = {
  type: "complementary" as HarmonyType,
  analogous: { count: ANALOGOUS_DEFAULT_COUNT, spread: ANALOGOUS_DEFAULT_SPREAD },
  monochromatic: { count: MONOCHROMATIC_DEFAULT_COUNT, step: MONOCHROMATIC_DEFAULT_STEP },
};

/** Hue offsets (degrees) applied to the base color's OKLCH hue for each fixed-rule harmony type.
 *  Analogous and Monochromatic are variable-count and computed separately. */
function fixedOffsets(type: Exclude<HarmonyType, "analogous" | "monochromatic">): number[] {
  switch (type) {
    case "complementary": return [180];
    case "triadic": return [120, 240];
    case "split_complementary": return [150, 210];
    case "tetradic": return [90, 180, 270];
  }
}

/** Analogous offsets on one side of the base (HUE+ or HUE-): `count` steps at `spread`, `2*spread`,
 *  … `count*spread` degrees, the base itself not included — the two rows (positive and negative
 *  offsets) are built by calling this once per sign. */
function analogousOffsets(count: number, spread: number): number[] {
  return Array.from({ length: count }, (_, i) => spread * (i + 1));
}

/** The spread (degrees per step) that makes `count` steps exactly cover 180° from the base, in
 *  either direction — GitHub issue #504 follow-up's "auto-fit" control. Capped at the spread
 *  slider's own max: for `count` below 3, 180/count exceeds it, and an uncapped value would move
 *  the slider's displayed number past where its thumb can actually sit. */
function autoFitSpread(count: number): number {
  return Math.min(ANALOGOUS_MAX_SPREAD, 180 / count);
}

/** Monochromatic lightness offsets on one side of the base (L+ or L-): `count` steps at `step`,
 *  `2*step`, … `count*step`, clamped to the valid 0-100 lightness range — same shape as
 *  `analogousOffsets`, just on the L axis instead of hue. */
function monochromaticOffsets(count: number, step: number): number[] {
  return Array.from({ length: count }, (_, i) => step * (i + 1));
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

/** "Harmony" section (GitHub issue #504, sub-issue of #498) — below the active model editor in
 *  `ColorPickerPanel`, separated from it by a divider. Holds its own base color (seeded from the
 *  color the panel opened with) and a harmony-type selector; derives swatches by rotating the
 *  base's OKLCH hue (chroma and lightness kept), per the classic color-wheel rules — except
 *  Monochromatic, which keeps hue and chroma fixed and spreads lightness instead. Analogous and
 *  Monochromatic share the same shape: two independent rows (HUE+/HUE- for Analogous, L+/L- for
 *  Monochromatic), each `count` steps out from the base at `spread`/`step`, `2*spread`/`2*step`, …;
 *  the base itself isn't a swatch in either row. Clicking a swatch sets the
 *  picker's working color only — it never rebuilds the row(s). The "Rebuild from current color"
 *  button (below the swatches, same style as "Project colors"' "Show all") rebuilds from the
 *  picker's current working color, for any harmony type; editing sliders / hex never does. */
export function HarmonySection({ seedColor, workingColor, onPick }: {
  /** The color the picker opened with — seeds the section's own base color once, on mount. */
  seedColor: number;
  /** The picker's current working color, read only by "Rebuild from current color". */
  workingColor: number;
  /** Set the picker's working color (same path as a project-color row — does not commit). */
  onPick: (color: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [base, setBase] = useState(seedColor);
  const [type, setTypeState] = useState<HarmonyType>(persisted.type);
  const [count, setCountState] = useState(persisted.analogous.count);
  const [spread, setSpreadState] = useState(persisted.analogous.spread);
  const [monoCount, setMonoCountState] = useState(persisted.monochromatic.count);
  const [monoStep, setMonoStepState] = useState(persisted.monochromatic.step);

  function setType(next: HarmonyType) {
    persisted.type = next;
    setTypeState(next);
  }
  function setCount(next: number) {
    persisted.analogous.count = next;
    setCountState(next);
  }
  function setSpread(next: number) {
    persisted.analogous.spread = next;
    setSpreadState(next);
  }
  function setMonoCount(next: number) {
    persisted.monochromatic.count = next;
    setMonoCountState(next);
  }
  function setMonoStep(next: number) {
    persisted.monochromatic.step = next;
    setMonoStepState(next);
  }

  const swatches = useMemo(() => {
    const baseOklch = colorToOklch(base);
    if (type === "analogous" || type === "monochromatic") return null; // Each renders its own two rows below.
    const derived = fixedOffsets(type).map((offset) => gamutSafeSwatch(baseOklch, baseOklch.l, baseOklch.h + offset));
    return [base, ...derived];
  }, [base, type]);

  // Analogous (GitHub issue #504 follow-up): two independent rows, HUE+ and HUE-, each `count`
  // swatches at `spread`, `2*spread`, … `count*spread` degrees from the base on its own side. The
  // base itself is not shown — clicking a row's swatch still just sets the working color.
  const analogous = useMemo(() => {
    const baseOklch = colorToOklch(base);
    const offsets = analogousOffsets(count, spread);
    return {
      plus: offsets.map((offset) => gamutSafeSwatch(baseOklch, baseOklch.l, baseOklch.h + offset)),
      minus: offsets.map((offset) => gamutSafeSwatch(baseOklch, baseOklch.l, baseOklch.h - offset)),
    };
  }, [base, count, spread]);

  // Monochromatic (GitHub issue #504 follow-up): same shape as Analogous, but on the L axis —
  // two rows, L+ and L-, each `count` swatches at `step`, `2*step`, … from the base, clamped to
  // the valid 0-100 lightness range since (unlike hue) it doesn't wrap.
  const monochromatic = useMemo(() => {
    const baseOklch = colorToOklch(base);
    const offsets = monochromaticOffsets(monoCount, monoStep);
    const clampL = (l: number) => Math.max(0, Math.min(100, l));
    return {
      plus: offsets.map((offset) => gamutSafeSwatch(baseOklch, clampL(baseOklch.l + offset), baseOklch.h)),
      minus: offsets.map((offset) => gamutSafeSwatch(baseOklch, clampL(baseOklch.l - offset), baseOklch.h)),
    };
  }, [base, monoCount, monoStep]);

  return (
    <div style={styles.root}>
      <SectionHeader
        label={m["color_picker.harmony"]()}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div style={styles.body}>
          <SelectRow
            label={m["color_picker.harmony.type_label"]()}
            value={type}
            options={TYPES.map(({ key, label }) => ({ value: key, label: label() }))}
            onChange={(v) => setType(v)}
          />
          {type === "analogous" && (
            <>
              <SliderRow
                label={m["color_picker.harmony.analogous_count"]()}
                value={count}
                onChange={(v) => setCount(Math.round(v))}
                min={1}
                max={10}
                // "Count" is now per-side (HUE+ / HUE-), so 1 is a valid minimum (was 2 when it
                // meant the total including the base).
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["color_picker.harmony.analogous_spread"]()}
                value={spread}
                onChange={setSpread}
                min={1}
                max={ANALOGOUS_MAX_SPREAD}
                step={1}
                format={(v) => `${v}°`}
                resetButton={
                  <HoverIconButton onClick={() => setSpread(autoFitSpread(count))} title={m["color_picker.harmony.analogous_auto_spread"]()}>
                    <Maximize2 size={13} />
                  </HoverIconButton>
                }
              />
            </>
          )}
          {type === "monochromatic" && (
            <>
              <SliderRow
                label={m["color_picker.harmony.monochromatic_count"]()}
                value={monoCount}
                onChange={(v) => setMonoCount(Math.round(v))}
                min={1}
                max={10}
                step={1}
                format={(v) => String(v)}
              />
              <SliderRow
                label={m["color_picker.harmony.monochromatic_step"]()}
                value={monoStep}
                onChange={(v) => setMonoStep(Math.round(v))}
                min={0}
                max={50}
                step={1}
                format={(v) => String(v)}
              />
            </>
          )}
          {type === "analogous" && (
            <div style={styles.analogousRows} data-testid="color-picker-harmony-swatches">
              <div style={styles.analogousRow}>
                <span style={styles.analogousLabel}>{m["color_picker.harmony.hue_plus"]()}</span>
                <div style={styles.swatchRow}>
                  {analogous.plus.map((color, i) => (
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
                <span style={styles.analogousLabel}>{m["color_picker.harmony.hue_minus"]()}</span>
                <div style={styles.swatchRow}>
                  {analogous.minus.map((color, i) => (
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
          {type === "monochromatic" && (
            <div style={styles.analogousRows} data-testid="color-picker-harmony-swatches">
              <div style={styles.analogousRow}>
                <span style={styles.analogousLabel}>{m["color_picker.harmony.lightness_plus"]()}</span>
                <div style={styles.swatchRow}>
                  {monochromatic.plus.map((color, i) => (
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
                <span style={styles.analogousLabel}>{m["color_picker.harmony.lightness_minus"]()}</span>
                <div style={styles.swatchRow}>
                  {monochromatic.minus.map((color, i) => (
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
          {type !== "analogous" && type !== "monochromatic" && (
            <div style={styles.swatchRow} data-testid="color-picker-harmony-swatches">
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
            {m["color_picker.harmony.rebuild_from_current"]()}
          </Button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  body: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
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
