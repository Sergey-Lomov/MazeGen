import type { FieldHintReason } from "./FieldHint";
import * as m from "~/paraglide/messages";

/** Machine-readable explanation of a user input adjustment. Values needed to describe the
 * adjustment travel with the reason, so callers never have to infer it by comparing store state. */
export type InputNormalizationReason =
  | { kind: "decimal_separator_rejected" }
  | { kind: "rounded"; value: string }
  | { kind: "clamped_min"; min: string; max: string; value: string }
  | { kind: "clamped_max"; min: string; max: string; value: string }
  | { kind: "restored"; value: string }
  | { kind: "text_truncated" }
  | { kind: "character_rejected" }
  | { kind: "range_reverted"; min: string; max: string; value: string };

/** Canonical result returned by field normalizers (GitHub issue #770). `raw` is always the exact
 * user input, while `value` is the value accepted or restored by the field. */
export interface NormalizerResult<T> {
  raw: string;
  value: T;
  reason: InputNormalizationReason | null;
}

/** Convert a structured reason to the lazy, locale-aware shape consumed by `useFieldHint`. */
export function inputHintReason(reason: InputNormalizationReason): FieldHintReason {
  switch (reason.kind) {
    case "decimal_separator_rejected":
      return { key: reason.kind, message: () => m["input_hint.decimal_separator_rejected"]() };
    case "rounded":
      return { key: reason.kind, message: () => m["input_hint.rounded"]({ value: reason.value }) };
    case "clamped_min":
      return { key: reason.kind, message: () => m["input_hint.clamped_min"]({ min: reason.min, max: reason.max }) };
    case "clamped_max":
      return { key: reason.kind, message: () => m["input_hint.clamped_max"]({ min: reason.min, max: reason.max }) };
    case "restored":
      return { key: reason.kind, message: () => m["input_hint.restored"]() };
    case "text_truncated":
      return { key: reason.kind, message: () => m["input_hint.text_truncated"]() };
    case "character_rejected":
      return { key: reason.kind, message: () => m["input_hint.character_rejected"]() };
    case "range_reverted":
      return {
        key: reason.kind,
        message: () => m["input_hint.range_reverted"]({ min: reason.min, max: reason.max }),
      };
  }
}

export function isParseableNumber(raw: string): boolean {
  return raw.trim() !== "" && Number.isFinite(Number(raw));
}

/** Normalize a numeric draft on commit. Clamp reasons take precedence over rounding because they
 * explain the final boundary value; otherwise an integer conversion reports rounding. */
export function normalizeNumberCommit(
  raw: string,
  lastValid: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): NormalizerResult<string> {
  if (!isParseableNumber(raw)) {
    return { raw, value: lastValid, reason: { kind: "restored", value: lastValid } };
  }

  const parsed = Number(raw);
  const rounded = options.integer ? Math.round(parsed) : parsed;
  if (options.min !== undefined && rounded < options.min) {
    const value = String(options.min);
    return { raw, value, reason: { kind: "clamped_min", min: value, max: options.max === undefined ? "∞" : String(options.max), value } };
  }
  if (options.max !== undefined && rounded > options.max) {
    const value = String(options.max);
    return { raw, value, reason: { kind: "clamped_max", min: options.min === undefined ? "−∞" : String(options.min), max: value, value } };
  }

  const value = String(rounded);
  return {
    raw,
    value,
    reason: options.integer && rounded !== parsed ? { kind: "rounded", value } : null,
  };
}

/** Parse and clamp a typed color-channel value. Empty/non-numeric drafts remain buffered and carry
 * no range reason; only typed range clamps are surfaced by the color editors. */
export function normalizeChannelInput(raw: string, max: number): NormalizerResult<number | null> {
  if (raw.trim() === "") return { raw, value: null, reason: null };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { raw, value: null, reason: null };
  if (parsed < 0) return { raw, value: 0, reason: { kind: "clamped_min", min: "0", max: String(max), value: "0" } };
  if (parsed > max) {
    const value = String(max);
    return { raw, value: max, reason: { kind: "clamped_max", min: "0", max: value, value } };
  }
  return { raw, value: parsed, reason: null };
}
