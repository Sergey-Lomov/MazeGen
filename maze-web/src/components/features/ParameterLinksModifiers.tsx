import { useState } from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { EditIconButton } from "../EditIconButton";
import { RemoveIconButton } from "../RemoveIconButton";
import { SelectRow } from "../SelectRow";
import { NumberInput } from "../NumberInput";
import { Inline } from "../Layout";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier, ColorModel, ColorChannel } from "../../store/parameterLinks";
import * as m from "~/paraglide/messages";
import { styles } from "./ParameterLinksDialog.styles";

export const MODIFIER_SYMBOL: Record<ParamModifier["op"], string> = { add: "+", sub: "−", mul: "×", div: "÷" };

/** Short operator-chain suffix appended after a link row's "= Source" line (e.g. " +3 ×1.5") —
 *  GitHub issue #645. Each step renders in list order, same order `applyModifiers` evaluates them
 *  in. Empty string for a pure-equality link (`modifiers: undefined`/empty), so the row reads
 *  exactly as it did before #645 in that case. */
export function modifierSuffix(modifiers: ParamModifier[] | undefined): string {
  if (!modifiers || modifiers.length === 0) return "";
  return " " + modifiers.map((modifier) => `${MODIFIER_SYMBOL[modifier.op]} ${modifier.value}`).join(" ");
}

/** Display label for one `ColorChannel`, e.g. "R" / "H" — independent per-model even where two
 *  channels share a letter (`hsl-h`/`oklch-h` both read "H"), since the chain's `model` already
 *  disambiguates them visually (see `COLOR_CHANNEL_OPTIONS`). */
export const COLOR_CHANNEL_LABEL: Record<ColorChannel, string> = {
  r: m["image_export.param_links.color_channel_r"](),
  g: m["image_export.param_links.color_channel_g"](),
  b: m["image_export.param_links.color_channel_b"](),
  "hsl-h": m["image_export.param_links.color_channel_hsl_h"](),
  s: m["image_export.param_links.color_channel_s"](),
  l: m["image_export.param_links.color_channel_l"](),
  "oklch-h": m["image_export.param_links.color_channel_oklch_h"](),
  c: m["image_export.param_links.color_channel_c"](),
  "oklch-l": m["image_export.param_links.color_channel_oklch_l"](),
};

/** Short display text for one color-modifier step (e.g. "× 1.5L (OKLCH)") — mirrors
 *  `modifierStepText`'s role for a plain numeric step. */
export function colorModifierStepText(modifier: ColorModifier): string {
  return `${MODIFIER_SYMBOL[modifier.op]} ${modifier.value}${COLOR_CHANNEL_LABEL[modifier.channel]} (${COLOR_MODEL_LABEL[modifier.model]})`;
}

/** Short operator-chain suffix for a color link's row, same convention as `modifierSuffix`. */
export function colorModifierSuffix(modifiers: ColorModifier[] | undefined): string {
  if (!modifiers || modifiers.length === 0) return "";
  return " " + modifiers.map(colorModifierStepText).join(" ");
}

/** Combined numeric + color modifier suffix of a link (one of the two is always empty — a link's
 *  `ParamType` is either numeric or color). */
export function linkModifiersSuffix(link: Pick<ParamLink<string>, "modifiers" | "colorModifiers">): string {
  return `${modifierSuffix(link.modifiers)}${colorModifierSuffix(link.colorModifiers)}`;
}

/** Modifier operator options for one chain step's `SelectRow` — map 1:1 onto `ParamModifier["op"]`
 *  (GitHub issue #645, extended to a multi-step chain per follow-up feedback: a link may carry
 *  several of these, applied in list order, rather than at most one). */
export const MODIFIER_OPTIONS: { value: ParamModifier["op"]; label: string }[] = [
  { value: "add", label: m["image_export.param_links.modifier_add"]() },
  { value: "sub", label: m["image_export.param_links.modifier_sub"]() },
  { value: "mul", label: m["image_export.param_links.modifier_mul"]() },
  { value: "div", label: m["image_export.param_links.modifier_div"]() },
];

/** One modifier symbol/short-label pair for a chain step's display text (e.g. "× 1.5"). */
export function modifierStepText(modifier: ParamModifier): string {
  return `${MODIFIER_SYMBOL[modifier.op]} ${modifier.value}`;
}

/** Color model options for a color-modifier step's model `SelectRow` (GitHub issue #647) — map 1:1
 *  onto `ColorModel`. OKLCH is listed first and is the default for a brand-new step/chain
 *  (`ColorModifierStepDialog`/`LinkEditor`): channel-wise arithmetic is perceptually uniform there,
 *  while the same operation in RGB/HSL can shift perceived hue or brightness as a side effect — see
 *  `ColorModel`'s own doc comment in `parameterLinks.ts`. */
export const COLOR_MODEL_OPTIONS: { value: ColorModel; label: string }[] = [
  { value: "oklch", label: m["image_export.param_links.color_model_oklch"]() },
  { value: "rgb", label: m["image_export.param_links.color_model_rgb"]() },
  { value: "hsl", label: m["image_export.param_links.color_model_hsl"]() },
];

export const COLOR_MODEL_LABEL: Record<ColorModel, string> = {
  rgb: m["image_export.param_links.color_model_rgb"](),
  hsl: m["image_export.param_links.color_model_hsl"](),
  oklch: m["image_export.param_links.color_model_oklch"](),
};

/** Which `ColorChannel`s a step's channel `SelectRow` offers, keyed by the step's own `model` — a
 *  model switch resets the channel to that model's first entry (`ColorModifierStepDialog`), since a
 *  channel literal from one model (e.g. `"s"`) isn't meaningful under another. */
export const CHANNELS_BY_MODEL: Record<ColorModel, ColorChannel[]> = {
  rgb: ["r", "g", "b"],
  hsl: ["hsl-h", "s", "l"],
  oklch: ["oklch-l", "c", "oklch-h"],
};

/** Single-step add/edit sub-dialog (GitHub issue #645 follow-up) — a modifier step is always added
 *  or edited through this small modal, never inline in the chain list, so the list itself only ever
 *  shows read-only rows with edit/delete actions (mirrors how the link list's own rows work).
 *  `initial` pre-fills operator/value for `Edit`, left `null` for a brand-new step (defaults to
 *  `"add"`/`1`). Saving with `op: "div"` and `value: 0` is blocked (would make `target` NaN/Infinity
 *  on every propagation). */
export function ModifierStepDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: ParamModifier | null;
  onSave: (modifier: ParamModifier) => void;
  onClose: () => void;
}) {
  const [op, setOp] = useState<ParamModifier["op"]>(initial?.op ?? "add");
  const [value, setValue] = useState<string>(String(initial?.value ?? 1));
  const divideByZero = op === "div" && Number(value) === 0;
  const canSave = !divideByZero;

  function save() {
    if (!canSave) return;
    onSave({ op, value: Number(value) });
  }

  return (
    <Modal
      title={initial === null ? m["image_export.param_links.add_modifier"]() : m["image_export.param_links.edit_modifier_title"]()}
      size="approve"
      onClose={onClose}
      onConfirm={canSave ? save : undefined}
      rawBody={
        <div style={styles.editorBody}>
          <Inline gap="rowGap">
            <SelectRow label="" value={op} options={MODIFIER_OPTIONS} onChange={setOp} selectStyle={styles.modifierOpSelect} />
            <NumberInput value={value} onChange={setValue} style={styles.modifierValueInput} />
          </Inline>
          {divideByZero && <span style={styles.modifierError}>{m["image_export.param_links.modifier_divide_by_zero"]()}</span>}
          <div style={styles.editorFooter}>
            <Button variant="secondary" dialogAction onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
            <Button variant="primary" dialogAction disabled={!canSave} onClick={save}>
              {m["image_export.param_links.save_link"]()}
            </Button>
          </div>
        </div>
      }
    />
  );
}

/** One chain-step row inside the editor's "Modifiers" column — read-only display text plus edit
 *  (reopens `ModifierStepDialog` pre-filled) and remove actions, same convention the link list's own
 *  rows use (`EditIconButton`/`RemoveIconButton`). */
export function ModifierStepRow({
  modifier,
  onEdit,
  onRemove,
}: {
  modifier: ParamModifier;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div style={styles.modifierStep}>
      <span style={styles.modifierStepText}>{modifierStepText(modifier)}</span>
      <EditIconButton title={m["image_export.param_links.edit_modifier_title"]()} onClick={onEdit} />
      <RemoveIconButton title={m["image_export.param_links.remove_modifier"]()} size={16} onClick={onRemove} />
    </div>
  );
}

/** Status hint shown in the modifiers column in place of the chain list — picks the one message
 *  that actually applies right now (GitHub issue #645 follow-up): no dependent parameter picked
 *  yet, then no source, then (once both are picked but the pair isn't `"number"`-type) "not
 *  available for this parameter type". `null` once a chain can actually be built, so the caller
 *  renders the real list instead. */
export function modifiersHint<P extends string>(target: P | null, source: P | null, registry: Record<P, ParamDescriptor>): string | null {
  if (target === null) return m["image_export.param_links.pick_target_first"]();
  if (source === null) return m["image_export.param_links.pick_source_first"]();
  if (registry[target].type !== "number") return m["image_export.param_links.modifiers_not_available"]();
  return null;
}

/** Same role as `modifiersHint`, for the color-modifiers column (GitHub issue #647) — the chain is
 *  only offered once both endpoints are picked and the pair is `"color"`-type. */
export function colorModifiersHint<P extends string>(target: P | null, source: P | null, registry: Record<P, ParamDescriptor>): string | null {
  if (target === null) return m["image_export.param_links.pick_target_first"]();
  if (source === null) return m["image_export.param_links.pick_source_first"]();
  if (registry[target].type !== "color") return m["image_export.param_links.modifiers_not_available"]();
  return null;
}

/** One color-modifier chain-step row (GitHub issue #647) — mirrors `ModifierStepRow`. */
export function ColorModifierStepRow({
  modifier,
  onEdit,
  onRemove,
}: {
  modifier: ColorModifier;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div style={styles.modifierStep}>
      <span style={styles.modifierStepText}>{colorModifierStepText(modifier)}</span>
      <EditIconButton title={m["image_export.param_links.edit_color_modifier_title"]()} onClick={onEdit} />
      <RemoveIconButton title={m["image_export.param_links.remove_color_modifier"]()} size={16} onClick={onRemove} />
    </div>
  );
}

/** Single-step add/edit sub-dialog for a color-modifier chain step (GitHub issue #647) — mirrors
 *  `ModifierStepDialog`, but picks a `ColorModel` first (defaulting a brand-new step to `"oklch"`,
 *  with a hint recommending it — see `COLOR_MODEL_OPTIONS`'s own doc comment) and a `ColorChannel`
 *  within that model (`CHANNELS_BY_MODEL`); switching the model resets the channel to that model's
 *  first entry rather than keeping a now-meaningless selection from the old model. */
export function ColorModifierStepDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: ColorModifier | null;
  onSave: (modifier: ColorModifier) => void;
  onClose: () => void;
}) {
  const [model, setModel] = useState<ColorModel>(initial?.model ?? "oklch");
  const [channel, setChannel] = useState<ColorChannel>(initial?.channel ?? CHANNELS_BY_MODEL[model][0]);
  const [op, setOp] = useState<ParamModifier["op"]>(initial?.op ?? "add");
  const [value, setValue] = useState<string>(String(initial?.value ?? 1));
  const divideByZero = op === "div" && Number(value) === 0;
  const canSave = !divideByZero;

  function handleModelChange(nextModel: ColorModel) {
    setModel(nextModel);
    setChannel(CHANNELS_BY_MODEL[nextModel][0]);
  }

  function save() {
    if (!canSave) return;
    onSave({ model, channel, op, value: Number(value) });
  }

  const channelOptions = CHANNELS_BY_MODEL[model].map((ch) => ({ value: ch, label: COLOR_CHANNEL_LABEL[ch] }));

  return (
    <Modal
      title={initial === null ? m["image_export.param_links.add_color_modifier_title"]() : m["image_export.param_links.edit_color_modifier_title"]()}
      size="approve"
      onClose={onClose}
      onConfirm={canSave ? save : undefined}
      rawBody={
        <div style={styles.editorBody}>
          <SelectRow label={m["image_export.param_links.color_model_label"]()} value={model} options={COLOR_MODEL_OPTIONS} onChange={handleModelChange} />
          {model === "oklch" && <div style={styles.pickerHint}>{m["image_export.param_links.color_model_oklch_hint"]()}</div>}
          <Inline gap="rowGap">
            <SelectRow label="" value={channel} options={channelOptions} onChange={setChannel} selectStyle={styles.modifierOpSelect} />
            <SelectRow label="" value={op} options={MODIFIER_OPTIONS} onChange={setOp} selectStyle={styles.modifierOpSelect} />
            <NumberInput value={value} onChange={setValue} style={styles.modifierValueInput} />
          </Inline>
          {divideByZero && <span style={styles.modifierError}>{m["image_export.param_links.modifier_divide_by_zero"]()}</span>}
          <div style={styles.editorFooter}>
            <Button variant="secondary" dialogAction onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
            <Button variant="primary" dialogAction disabled={!canSave} onClick={save}>
              {m["image_export.param_links.save_link"]()}
            </Button>
          </div>
        </div>
      }
    />
  );
}
