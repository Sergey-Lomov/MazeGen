import { colorToRgb, rgbToColor, colorToHsl, hslToColor, colorToOklch, oklchToColor } from "./colorMath";

/** Family of a linkable parameter — constrains which parameters can be linked to one another (only
 *  same-type pairs) and which link a `"number"` pair may carry a `ParamModifier` chain on (#645), or
 *  a `"color"` pair a `ColorModifier` chain on (#647) — every other type stays pure equality. Extend
 *  as new parameter shapes appear. `markerShape`/`verticalArrowStyle`/`indexLabelStyle`/
 *  `labelFontWeight` are each a small string enum reused by multiple settings fields across both
 *  render modes (same underlying TS type and value set) — split out from a generic catch-all so each
 *  gets its own localized `format` instead of showing a raw enum string. `boolean` covers plain
 *  on/off toggles. A `"color"` value is a packed 24-bit RGB number, same as every other color field
 *  in the app (`store/colorMath.ts`) — `Object.is` equality is exact, no separate `equals` needed. */
export type ParamType = "number" | "color" | "cornerStyle" | "markerShape" | "verticalArrowStyle" | "indexLabelStyle" | "labelFontWeight" | "boolean";

/** Registry entry for one linkable parameter — the single source of truth for its type, value
 *  equality, display label, and settings-panel location, instead of scattered `!==` comparisons /
 *  hardcoded strings across the engine and UI. `equals` defaults to `Object.is`; a parameter with an
 *  object value (a future #647 color-as-object) overrides it here, not in the engine. `label` is a
 *  resolved display string (the caller passes an already-translated message), used by the
 *  parameter-links management dialog (GitHub issue #644) to list a path in human-readable form.
 *  `group` mirrors that same path's location in the settings panel itself (e.g. `["Markers",
 *  "Start"]` for `startMarker.size`, matching that panel's own "Markers" section > "Start" sub-
 *  group) — the dialog nests its own collapsible tree by this path instead of listing every
 *  linkable field flat, so a user finds a field where they'd expect it (same section/subsection
 *  names as the panel). An empty array means "no section" — listed at the dialog's own top level,
 *  outside any group; every current entry has a non-empty `group`, including the four "Shared
 *  style" source fields. `format` renders a raw value the same way the settings panel itself
 *  displays it (e.g. `"round"` → "Скругление"), used by the parameter-links dialog's current-value
 *  line; defaults to `String(v)` for plain numbers. Registry entries expose `label`/`group` as
 *  getters resolved in the current locale on every read (GitHub issue #742) — spreading a
 *  descriptor (`{ ...descriptor }`) snapshots them, so a memoized copy must depend on the locale. */
export interface ParamDescriptor {
  type: ParamType;
  equals: (a: unknown, b: unknown) => boolean;
  label: string;
  group: string[];
  format: (value: unknown) => string;
}

/** One numeric transform step in a link's `modifiers` chain (GitHub issue #645) — `value op`
 *  applied to whatever the previous step produced (or to the raw source value, for the first
 *  step). Only valid for `ParamType: "number"` links; a link between any other same-type pair
 *  never carries any. `"div"` with `value: 0` is rejected at the editor level (`LinkEditor`),
 *  never reaches here. */
export interface ParamModifier {
  op: "add" | "sub" | "mul" | "div";
  value: number;
}

function applyOne(value: number, modifier: ParamModifier): number {
  switch (modifier.op) {
    case "add":
      return value + modifier.value;
    case "sub":
      return value - modifier.value;
    case "mul":
      return value * modifier.value;
    case "div":
      return value / modifier.value;
  }
}

/** Applies a link's `modifiers` chain, in list order, to a raw numeric `value` copied from its
 *  `source` — each step transforms the previous step's result, so `[+3, x2]` on `value: 5` yields
 *  `(5 + 3) * 2 = 16`, not two independent transforms of `5`. `undefined`/empty is the pure-equality
 *  case (no transform), same as every other link type. */
export function applyModifiers(value: number, modifiers: ParamModifier[] | undefined): number {
  if (!modifiers) return value;
  return modifiers.reduce(applyOne, value);
}

/** Color model a `ColorModifier` step's `channel` is expressed in (GitHub issue #647). OKLCH is the
 *  perceptually-correct choice — channel-wise arithmetic there keeps hue/lightness/chroma meaning
 *  what they say, while the same operation in RGB/HSL can shift perceived hue or brightness as a
 *  side effect (e.g. adding to each RGB channel brightens unevenly across hues). `LinkEditor`
 *  defaults a new color link's chain to `"oklch"` and shows a hint recommending it, but doesn't force
 *  it — RGB/HSL stay available for a user who wants that model's specific (if perceptually uneven)
 *  behavior. */
export type ColorModel = "rgb" | "hsl" | "oklch";

/** Which channel of `model` a `ColorModifier` step targets. RGB: `r`/`g`/`b` (0-255). HSL: `h`
 *  (degrees, 0-360) / `s`/`l` (0-100). OKLCH: `l` (0-100) / `c` (0-`OKLCH_MAX_CHROMA`, see
 *  `colorMath.ts`) / `h` (degrees, 0-360). `h` is shared by HSL and OKLCH but each has its own
 *  `ColorChannel` literal (`"hsl-h"` / `"oklch-h"`) rather than a bare `"h"`, since a chain's `model`
 *  decides which hue space the degrees are measured in — collapsing them would let a step silently
 *  keep stale channel selection across a model switch in the editor. */
export type ColorChannel = "r" | "g" | "b" | "hsl-h" | "s" | "l" | "oklch-h" | "c" | "oklch-l";

/** One channel-arithmetic step in a color link's `colorModifiers` chain (GitHub issue #647) — mirrors
 *  `ParamModifier`'s `op`/`value` shape, but `channel` picks which single channel of `model` the op
 *  applies to; every other channel of that step passes through unchanged. Only valid for
 *  `ParamType: "color"` links; a link between any other same-type pair never carries any. `"div"`
 *  with `value: 0` is rejected at the editor level (`ColorModifierStepDialog`), never reaches here. */
export interface ColorModifier {
  model: ColorModel;
  channel: ColorChannel;
  op: "add" | "sub" | "mul" | "div";
  value: number;
}

function colorChannelRange(channel: ColorChannel): { min: number; max: number } {
  switch (channel) {
    case "r":
    case "g":
    case "b":
      return { min: 0, max: 255 };
    case "hsl-h":
    case "oklch-h":
      return { min: 0, max: 360 };
    case "s":
    case "l":
    case "oklch-l":
      return { min: 0, max: 100 };
    case "c":
      return { min: 0, max: Infinity };
  }
}

/** Reads one channel's current value out of `color` in whichever model `channel` belongs to. */
function readColorChannel(color: number, channel: ColorChannel): number {
  switch (channel) {
    case "r":
      return colorToRgb(color).r;
    case "g":
      return colorToRgb(color).g;
    case "b":
      return colorToRgb(color).b;
    case "hsl-h":
      return colorToHsl(color).h;
    case "s":
      return colorToHsl(color).s;
    case "l":
      return colorToHsl(color).l;
    case "oklch-h":
      return colorToOklch(color).h;
    case "c":
      return colorToOklch(color).c;
    case "oklch-l":
      return colorToOklch(color).l;
  }
}

/** Writes `newValue` into `channel`'s slot of `color`'s own model (reading the other two channels
 *  from that same model so they pass through unchanged), repacking to a 24-bit RGB number. Hue wraps
 *  mod 360, every other channel clamps to its own range (`colorChannelRange`) — same clamping
 *  `hslToColor`/`oklchToColor` already do on pack, applied here too since a modifier step's own
 *  arithmetic (e.g. `+40` on `l`) can push a channel out of range before packing. */
function writeColorChannel(color: number, channel: ColorChannel, newValue: number): number {
  const { min, max } = colorChannelRange(channel);
  const isHue = channel === "hsl-h" || channel === "oklch-h";
  const clamped = isHue ? ((newValue % 360) + 360) % 360 : Math.max(min, Math.min(max, newValue));
  switch (channel) {
    case "r": {
      const rgb = colorToRgb(color);
      return rgbToColor({ ...rgb, r: clamped });
    }
    case "g": {
      const rgb = colorToRgb(color);
      return rgbToColor({ ...rgb, g: clamped });
    }
    case "b": {
      const rgb = colorToRgb(color);
      return rgbToColor({ ...rgb, b: clamped });
    }
    case "hsl-h": {
      const hsl = colorToHsl(color);
      return hslToColor({ ...hsl, h: clamped });
    }
    case "s": {
      const hsl = colorToHsl(color);
      return hslToColor({ ...hsl, s: clamped });
    }
    case "l": {
      const hsl = colorToHsl(color);
      return hslToColor({ ...hsl, l: clamped });
    }
    case "oklch-h": {
      const oklch = colorToOklch(color);
      return oklchToColor({ ...oklch, h: clamped });
    }
    case "c": {
      const oklch = colorToOklch(color);
      return oklchToColor({ ...oklch, c: clamped });
    }
    case "oklch-l": {
      const oklch = colorToOklch(color);
      return oklchToColor({ ...oklch, l: clamped });
    }
  }
}

function applyOneColor(color: number, modifier: ColorModifier): number {
  const current = readColorChannel(color, modifier.channel);
  const next = applyOne(current, { op: modifier.op, value: modifier.value });
  return writeColorChannel(color, modifier.channel, next);
}

/** Applies a color link's `colorModifiers` chain, in list order, to a packed 24-bit RGB `color`
 *  copied from its `source` (GitHub issue #647) — each step converts to its own `model`, transforms
 *  just its `channel`, and repacks to RGB before the next step reads it, so chained steps in
 *  different models compound through the packed color rather than against each other's intermediate
 *  triples. `undefined`/empty is the pure-equality case (no transform), same as `applyModifiers`. */
export function applyColorModifiers(color: number, modifiers: ColorModifier[] | undefined): number {
  if (!modifiers) return color;
  return modifiers.reduce(applyOneColor, color);
}

/** One parameter-to-parameter link. Parameterized by `P` (a per-mode path union) so `source`/
 *  `target` are checked by the compiler against a concrete mode's real paths, not an arbitrary
 *  string. `enabled: false` means `target` currently carries a manually-set value and does NOT
 *  follow `source` — the same state the old "Shared style" mechanism called "override"; a single
 *  flag, since `target` has at most one incoming link (guaranteed by `validateLinkGraph`). Flipping
 *  it back to `true` does not by itself resync the value — the caller (see `setLinkEnabledByTarget`)
 *  does that, by re-applying `source`. `modifiers` (GitHub issue #645) is only ever set for a
 *  `"number"`-type pair; `colorModifiers` (GitHub issue #647) only ever for a `"color"`-type pair —
 *  the two chains are mutually exclusive since a link's `source`/`target` share one `ParamType`.
 *  `undefined`/empty on either means a pure equality link, same as every other `ParamType` — applied
 *  in list order by `applyModifiers`/`applyColorModifiers`, never independently. */
export interface ParamLink<P extends string = string> {
  id: string;
  source: P;
  target: P;
  enabled: boolean;
  modifiers?: ParamModifier[];
  colorModifiers?: ColorModifier[];
}
