import React, { useEffect, useRef, useState } from "react";
import type { ParamDescriptor, EntityVisibility, SplitPattern } from "../../wasm/types";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { typography, font, spacing, ui, radius } from "../../styles/theme";
import { resolveParamOptionLabel, resolveParamOptionExplanation, resolvePriorityOptionLabel } from "./qualityI18n";
import { Switch } from "../Switch";
import { NumberInput } from "../NumberInput";
import { Inline } from "../Layout";
import { Modal } from "../Modal";
import { SplitPatternListEditor } from "../dialogs/SplitPatternListEditor";
import { SplitGenerationSettingsBody, type SplitGenerationSettingsValue } from "../dialogs/SplitGenerationSettingsBody";
import { splitPatternsToCore, splitPatternsToWeb } from "../../pixi/tessellationGeometry";
import { useMazeStore } from "../../store/mazeStore";
import { activeFloorTessellationOf } from "../../store/storeHelpers";
import * as m from "~/paraglide/messages";

// Resolves an `EntityVisibility` condition against current maze state (GitHub issue #349) — the
// single interpreter for every visibility tag, shared by params (this file's own row filtering)
// and whole checks/strategies (the selection dialogs' candidate filtering), so a new tag is a new
// match arm here, not a new bespoke check scattered across call sites. `undefined` (no tag) is
// always visible.
export function isEntityVisible(visibility: EntityVisibility | undefined, floorCount: number): boolean {
  if (!visibility) return true;
  switch (visibility.type) {
    case "multi_floor_only":
      return floorCount >= 2;
  }
}

const OPTION_WIDTH_BUFFER = 10;
const SELECT_MAX_WIDTH_RATIO = 0.4;

// Mirrors `maze_core::repair::PriorityLevel::ALL`'s own order.
export const PRIORITY_LEVELS = ["required", "preferred", "indifferent", "discouraged", "forbidden"];

// Float params rendered as a 0-100 percent slider instead of the default number input — an
// explicit id allowlist rather than a blanket "every Float is a slider" rule, since most Float
// params (reserve_percent, min_distance, etc.) are edited as exact numbers elsewhere in the app.
const PERCENT_SLIDER_PARAM_IDS = new Set(["one_way_chance", "loop_one_way_chance", "vertical_loop_one_way_chance"]);

// Float params on a [0, 1] range rendered as a 0-100% slider -- the value stored/sent is the raw
// fraction (0..1), only the slider bounds and displayed text are scaled by 100.
const PERCENT_FRACTION_SLIDER_PARAM_IDS = new Set(["one_way_balance", "direction_balance", "vertical_direction_balance", "existing_reuse_balance", "cross_floor_balance"]);

let measureCanvasCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCanvasCtx === undefined) {
    measureCanvasCtx = document.createElement("canvas").getContext("2d");
    if (measureCanvasCtx) {
      measureCanvasCtx.font = `${font.lg}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    }
  }
  return measureCanvasCtx;
}

function widestOptionWidth(labels: string[]): number {
  const ctx = getMeasureCtx();
  if (!ctx) return 0;
  let max = 0;
  for (const label of labels) {
    max = Math.max(max, ctx.measureText(label).width);
  }
  return max;
}

interface Props {
  params: ParamDescriptor[];
  values?: Record<string, string>;
  getValue?: (p: ParamDescriptor) => string;
  onChange: (paramId: string, value: string) => void;
  /** Show each param's description as secondary text below its row. Only the expanded
   * detail view (e.g. QualityDetailPanel, AddCheckToRuleDialog) should set this — compact
   * views (rule cards, feature cards) must not. */
  getDescription?: (p: ParamDescriptor) => string | undefined;
  /** Renders every control non-interactive (native `disabled`) — e.g. a rule-card check row
   * whose check is toggled off (`CheckInstance.disabled`). Values are still shown, just not
   * editable, until the check is re-enabled. */
  disabled?: boolean;
  /** Param ids to render non-interactive individually, on top of `disabled` — e.g. the
   * `add_vertical_passage` strategy's `one_way_balance`/`direction_balance` sliders, forced and
   * locked when the rule-level `passage_type` already determines their value. */
  disabledIds?: Set<string>;
  /** Owning strategy id, for shared params (e.g. `priority`) whose option explanations read
   * differently per strategy — see `resolveParamOptionExplanation`'s per-strategy override. */
  contextId?: string;
  /** Rule-level `split_patterns` topology (GitHub issue #389), for an `add_split_config`-kind
   * param — empty means the param renders as a plain `max_split_nodes` integer input, non-empty
   * means it renders as a locked `SplitPatternListEditor` (topology from this prop, weights from
   * the param's own JSON `number[]` value). Only `RuleStrategyPanel` has rule-level param access,
   * so it resolves this and passes it down — see `addSplitPatternsOverride`. */
  addSplitPatternsOverride?: SplitPattern[];
  /** Selects this param row (GitHub issue #375) — clicking the row or its info icon shows the
   * param's label/description (read-only) in the quality detail panel. Only compact rule-card
   * views pass this (RuleCheckRow/RuleStrategyPanel/RuleParamsSection/NestedStrategyPanel); the
   * detail panel's own `ParamFields` instance (`ParamizedDetail`, already showing one entity's
   * full description) has no need for it. */
  onSelectParam?: (paramId: string) => void;
  /** The currently-selected param's id, for this same owner — highlights that one row. */
  selectedParamId?: string | null;
}

const SELECT_HORIZONTAL_CHROME = 4 + 18 + 2; // padding-left + padding-right + border
const ROW_GAP = 10; // styles.row's `gap`

function enumSelectWidth(p: ParamDescriptor, containerWidth: number): number | undefined {
  if (p.kind.type !== "enum" && p.kind.type !== "priority") return undefined;
  const labels = p.kind.type === "enum"
    ? p.kind.options.map((opt) => resolveParamOptionLabel(p.id, opt))
    : PRIORITY_LEVELS.map((opt) => resolvePriorityOptionLabel(opt));
  const textWidth = widestOptionWidth(labels);
  const desired = Math.ceil(textWidth + OPTION_WIDTH_BUFFER + SELECT_HORIZONTAL_CHROME);
  if (containerWidth <= 0) return desired;

  const softCap = Math.floor(containerWidth * SELECT_MAX_WIDTH_RATIO);
  if (desired <= softCap) return desired;

  // Widest option needs more than the soft cap — allow growing further, but never
  // past the point where the label would get squeezed below its own text width.
  const labelWidth = widestOptionWidth([p.label]);
  const hardCap = Math.floor(containerWidth - labelWidth - ROW_GAP);
  return Math.min(desired, Math.max(softCap, hardCap));
}

export function ParamFields({ params, values, getValue, onChange, getDescription, disabled, disabledIds, contextId, addSplitPatternsOverride, onSelectParam, selectedParamId }: Props) {
  const tessellationConfig = useMazeStore((s) => activeFloorTessellationOf(s));
  const floorCount = useMazeStore((s) => s.floors.length);
  const visibleParams = params.filter((p) => isEntityVisible(p.visibility, floorCount));
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [openPatternListParam, setOpenPatternListParam] = useState<string | null>(null);
  const [openSplitConfigParam, setOpenSplitConfigParam] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (visibleParams.length === 0) return null;

  function get(p: ParamDescriptor): string {
    if (getValue) return getValue(p);
    return values?.[p.id] ?? "";
  }

  function isDisabled(p: ParamDescriptor): boolean {
    return Boolean(disabled) || Boolean(disabledIds?.has(p.id));
  }

  // "min,max" -- mirrors maze-core's `parse_param` Interval encoding (repair/params.rs).
  function getIntervalParts(p: ParamDescriptor): [string, string] {
    const raw = get(p);
    const [lo, hi] = raw.split(",");
    return [lo ?? "", hi ?? ""];
  }

  // Mirrors `parse_split_patterns_param`'s own "invalid falls back to empty" contract (GitHub
  // issue #247) — a malformed or missing value reads as "no patterns" rather than throwing. The
  // stored value is in core `face_index` ordering (see the `onChange` handlers below, GitHub issue
  // #273) — converted back to web ordering here so `TileFaceEditor`-based UI reads it correctly.
  function getPatterns(p: ParamDescriptor): SplitPattern[] {
    try {
      const parsed = JSON.parse(get(p));
      return Array.isArray(parsed) ? splitPatternsToWeb(parsed, tessellationConfig) : [];
    } catch {
      return [];
    }
  }

  // Mirrors `parse_split_config_param`'s own "invalid falls back to SplitGenerationConfig::default()"
  // contract (GitHub issue #247). `patterns` is stored in core ordering, converted back to web here
  // (see `getPatterns`, GitHub issue #273).
  function getSplitConfig(p: ParamDescriptor): SplitGenerationSettingsValue {
    const fallback: SplitGenerationSettingsValue = { pattern_mode: false, max_split_nodes: 2, patterns: [] };
    try {
      const parsed = JSON.parse(get(p));
      if (!parsed || typeof parsed !== "object") return fallback;
      const patterns = Array.isArray(parsed.patterns) ? parsed.patterns : [];
      return {
        pattern_mode: Boolean(parsed.pattern_mode),
        max_split_nodes: Number.isFinite(parsed.max_split_nodes) ? Math.max(1, Math.trunc(parsed.max_split_nodes)) : 2,
        patterns: splitPatternsToWeb(patterns, tessellationConfig),
      };
    } catch {
      return fallback;
    }
  }

  // Mirrors `parse_add_split_config_param`'s integer-first shape sniffing (GitHub issue #389) —
  // used only in pattern mode (`addSplitPatternsOverride` non-empty), where the value is the
  // `pattern_weights` JSON `number[]`, indexed against the rule-level topology.
  function getPatternWeights(p: ParamDescriptor): number[] {
    try {
      const parsed = JSON.parse(get(p));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Non-pattern mode's stored value can still be pattern mode's own JSON `number[]` weights --
  // switching the rule's `split_patterns` to empty (e.g. removing all patterns) flips the
  // control's mode without touching this param's own value, so the leftover array must fall back
  // to displaying the kind's own default rather than the raw unparsed JSON text.
  function getMaxSplitNodes(p: ParamDescriptor): string {
    const raw = get(p);
    return /^\d+$/.test(raw.trim()) ? raw : String(p.kind.type === "add_split_config" ? p.kind.max_split_nodes_default : 0);
  }

  // `add_split_config`'s single param id carries two different meanings depending on the
  // rule-level `split_patterns` override (GitHub issue #389) — the generic `p.label` ("Split
  // settings") is too vague for either, so this overrides it per mode, same "sibling rule state
  // decides display" contract the control-type switch above already follows.
  function displayLabel(p: ParamDescriptor): string {
    if (p.kind.type !== "add_split_config") return p.label;
    return addSplitPatternsOverride?.length ? m["quality.add_split_config.weights_label"]() : m["quality.add_split_config.node_count_label"]();
  }

  // Same override as `displayLabel` -- a caller's `getDescription(p)` (`resolveParamDescription`)
  // resolves purely from `p.id`, with no visibility into the rule-level mode switch, so it can
  // only ever return one of the two texts. Overridden here instead of asking every call site to
  // special-case this one param id.
  function displayDescription(p: ParamDescriptor): string | undefined {
    if (!getDescription) return undefined;
    if (p.kind.type !== "add_split_config") return getDescription(p);
    return addSplitPatternsOverride?.length ? m["quality.add_split_config.weights_description"]() : m["quality.add_split_config.node_count_description"]();
  }

  return (
    <div ref={containerRef} style={{ ...styles.fieldsWrap, gap: getDescription ? spacing.sectionGap : spacing.itemGap }}>
      {visibleParams.map((p) => {
        const description = displayDescription(p);
        const selected = onSelectParam && selectedParamId === p.id;
        return (
          <div
            key={p.id}
            role={onSelectParam ? "button" : undefined}
            tabIndex={onSelectParam ? 0 : undefined}
            style={{
              ...styles.field,
              ...(isDisabled(p) ? styles.fieldDisabled : {}),
              ...(onSelectParam ? styles.fieldSelectable : {}),
              ...(selected ? styles.fieldSelected : {}),
            }}
            onClick={onSelectParam ? () => onSelectParam(p.id) : undefined}
            onKeyDown={onSelectParam ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectParam(p.id); } } : undefined}
          >
            <Inline gap="rowGap" justify="space-between">
              <span style={styles.labelWrap}>
                <label style={styles.label}>{displayLabel(p)}</label>
              </span>
              {/* Each control stops its own click from bubbling — not the whole row/field — so a
                  container that turns clicks into a "select this" action elsewhere (e.g.
                  `NestedStrategyPanel`'s strategy block) still catches clicks on the label or
                  empty space around a control, just not on the control itself. */}
              {p.kind.type === "float" && PERCENT_SLIDER_PARAM_IDS.has(p.id) && (
                <span style={styles.percentSliderWrap} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="range"
                    className="maze-slider"
                    style={styles.percentSlider}
                    min={p.kind.min}
                    max={p.kind.max}
                    step={1}
                    value={get(p)}
                    disabled={isDisabled(p)}
                    onChange={(e) => onChange(p.id, e.target.value)}
                  />
                  <span style={styles.percentSliderValue}>{Math.round(Number(get(p)))}%</span>
                </span>
              )}
              {p.kind.type === "float" && PERCENT_FRACTION_SLIDER_PARAM_IDS.has(p.id) && (
                <span style={styles.percentSliderWrap} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="range"
                    className="maze-slider"
                    style={styles.percentSlider}
                    min={p.kind.min * 100}
                    max={p.kind.max * 100}
                    step={1}
                    value={Number(get(p)) * 100}
                    disabled={isDisabled(p)}
                    onChange={(e) => onChange(p.id, String(Number(e.target.value) / 100))}
                  />
                  <span style={styles.percentSliderValue}>{Math.round(Number(get(p)) * 100)}%</span>
                </span>
              )}
              {(p.kind.type === "float" || p.kind.type === "integer") &&
                !PERCENT_SLIDER_PARAM_IDS.has(p.id) &&
                !PERCENT_FRACTION_SLIDER_PARAM_IDS.has(p.id) && (
                  <NumberInput
                    style={styles.input}
                    value={get(p)}
                    min={p.kind.min}
                    max={p.kind.max}
                    integer={p.kind.type === "integer"}
                    disabled={isDisabled(p)}
                    onChange={(v) => onChange(p.id, v)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              {p.kind.type === "interval" && (
                <span style={styles.intervalWrap} onClick={(e) => e.stopPropagation()}>
                  {(() => {
                    const [lo, hi] = getIntervalParts(p);
                    const kind = p.kind;
                    return (
                      <>
                        <NumberInput
                          style={styles.input}
                          value={lo}
                          min={kind.min}
                          max={kind.max}
                          disabled={isDisabled(p)}
                          onChange={(v) => onChange(p.id, `${v},${hi}`)}
                          onBlurCommit={(loRaw) => {
                            // `NumberInput` has already restored an emptied field to its last
                            // valid value and clamped to [min, max] -- the only adjustment left
                            // is the cross-field one it can't see: an inverted range (min > max)
                            // collapses to a single point at the other endpoint. Deferred to blur
                            // (not onChange) so both ends can be edited in sequence through a
                            // temporarily-inverted state.
                            const loNum = Number(loRaw);
                            const hiNum = Number(hi);
                            if (Number.isFinite(loNum) && Number.isFinite(hiNum) && loNum > hiNum) {
                              onChange(p.id, `${hiNum},${hiNum}`);
                            }
                          }}
                        />
                        <span style={styles.intervalSeparator}>–</span>
                        <NumberInput
                          style={styles.input}
                          value={hi}
                          min={kind.min}
                          max={kind.max}
                          disabled={isDisabled(p)}
                          onChange={(v) => onChange(p.id, `${lo},${v}`)}
                          onBlurCommit={(hiRaw) => {
                            // Same as the min field's own cross-field clamp above.
                            const loNum = Number(lo);
                            const hiNum = Number(hiRaw);
                            if (Number.isFinite(loNum) && Number.isFinite(hiNum) && hiNum < loNum) {
                              onChange(p.id, `${loNum},${loNum}`);
                            }
                          }}
                        />
                      </>
                    );
                  })()}
                </span>
              )}
              {p.kind.type === "bool" && (
                <span style={styles.switchWrap} onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={get(p) === "true"}
                    disabled={isDisabled(p)}
                    onChange={(checked) => onChange(p.id, checked ? "true" : "false")}
                  />
                </span>
              )}
              {p.kind.type === "enum" && (
                <select
                  style={{ ...styles.select, width: enumSelectWidth(p, containerWidth) }}
                  value={get(p)}
                  disabled={isDisabled(p)}
                  onChange={(e) => onChange(p.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.kind.options.map((opt) => (
                    <option key={opt} value={opt}>{resolveParamOptionLabel(p.id, opt)}</option>
                  ))}
                </select>
              )}
              {p.kind.type === "priority" && (
                <select
                  style={{ ...styles.select, width: enumSelectWidth(p, containerWidth) }}
                  value={get(p)}
                  disabled={isDisabled(p)}
                  onChange={(e) => onChange(p.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {PRIORITY_LEVELS.map((opt) => (
                    <option key={opt} value={opt}>{resolvePriorityOptionLabel(opt)}</option>
                  ))}
                </select>
              )}
              {p.kind.type === "pattern_list" && (
                <Button
                  variant="secondary"
                  layoutStyle={styles.paramButton}
                  disabled={isDisabled(p)}
                  onClick={(e) => { e.stopPropagation(); setOpenPatternListParam(p.id); }}
                >
                  {m["quality.pattern_list_edit"]()} ({getPatterns(p).length})
                </Button>
              )}
              {p.kind.type === "split_generation_config" && (
                <Button
                  variant="secondary"
                  layoutStyle={styles.paramButton}
                  disabled={isDisabled(p)}
                  onClick={(e) => { e.stopPropagation(); setOpenSplitConfigParam(p.id); }}
                >
                  {m["quality.split_config_edit"]()}
                </Button>
              )}
              {p.kind.type === "add_split_config" && !addSplitPatternsOverride?.length && (
                <NumberInput
                  style={styles.input}
                  value={getMaxSplitNodes(p)}
                  min={1}
                  integer
                  disabled={isDisabled(p)}
                  onChange={(v) => onChange(p.id, v)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              {p.kind.type === "add_split_config" && Boolean(addSplitPatternsOverride?.length) && (
                <Button
                  variant="secondary"
                  layoutStyle={styles.paramButton}
                  disabled={isDisabled(p)}
                  onClick={(e) => { e.stopPropagation(); setOpenSplitConfigParam(p.id); }}
                >
                  {m["quality.add_split_config.weights_edit"]()}
                </Button>
              )}
            </Inline>
            {description && <div style={styles.description}>{description}</div>}
            {description && p.kind.type === "enum" && (
              <ul style={styles.optionList}>
                {p.kind.options.map((opt) => {
                  const explanation = resolveParamOptionExplanation(p.id, opt, contextId);
                  if (!explanation) return null;
                  return (
                    <li key={opt}>
                      <strong>{resolveParamOptionLabel(p.id, opt)}</strong> — {explanation}
                    </li>
                  );
                })}
              </ul>
            )}
            {description && p.kind.type === "priority" && (
              <ul style={styles.optionList}>
                {PRIORITY_LEVELS.map((opt) => {
                  const explanation = resolveParamOptionExplanation(p.id, opt, contextId);
                  if (!explanation) return null;
                  return (
                    <li key={opt}>
                      <strong>{resolvePriorityOptionLabel(opt)}</strong> — {explanation}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      {openPatternListParam !== null && (() => {
        const p = params.find((param) => param.id === openPatternListParam);
        if (!p || p.kind.type !== "pattern_list") return null;
        const withWeights = p.kind.with_weights;
        return (
          <Modal title={p.label} onClose={() => setOpenPatternListParam(null)}>
            <SplitPatternListEditor
              patterns={getPatterns(p)}
              withWeights={withWeights}
              onChange={(next) => onChange(p.id, JSON.stringify(splitPatternsToCore(next, tessellationConfig)))}
            />
          </Modal>
        );
      })()}
      {openSplitConfigParam !== null && (() => {
        const p = params.find((param) => param.id === openSplitConfigParam);
        if (!p || p.kind.type !== "split_generation_config") return null;
        return (
          <Modal title={p.label} onClose={() => setOpenSplitConfigParam(null)}>
            <SplitGenerationSettingsBody
              value={getSplitConfig(p)}
              onChange={(next) => onChange(p.id, JSON.stringify({ ...next, patterns: splitPatternsToCore(next.patterns, tessellationConfig) }))}
            />
          </Modal>
        );
      })()}
      {openSplitConfigParam !== null && (() => {
        const p = params.find((param) => param.id === openSplitConfigParam);
        if (!p || p.kind.type !== "add_split_config" || !addSplitPatternsOverride?.length) return null;
        const topology = addSplitPatternsOverride;
        const weights = getPatternWeights(p);
        const patterns = topology.map((pattern, i) => ({ ...pattern, weight: weights[i] ?? pattern.weight ?? 1.0 }));
        return (
          <Modal title={displayLabel(p)} onClose={() => setOpenSplitConfigParam(null)}>
            <SplitPatternListEditor
              patterns={patterns}
              withWeights
              locked
              onChange={(next) => onChange(p.id, JSON.stringify(next.map((pattern) => pattern.weight ?? 1.0)))}
            />
          </Modal>
        );
      })()}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fieldsWrap: {
    display: "flex",
    flexDirection: "column",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
  },
  fieldDisabled: {
    opacity: 0.5,
  },
  fieldSelectable: {
    cursor: "default",
    borderRadius: radius.sm,
    margin: `0 -${spacing.elementsGap}px`,
    padding: `${spacing.elementsGap}px`,
  },
  fieldSelected: {
    background: ui.bg.panelAlt,
  },
  // `typography.message` — the theme's own "label"-weight token (body size, secondary color) —
  // see theme.ts's own guidance against composing fontSize/color ad hoc.
  label: {
    ...typography.message,
  },
  labelWrap: {
    display: "flex",
    alignItems: "center",
    gap: spacing.rowGap,
    flex: 1,
    minWidth: 0,
  },
  description: {
    ...typography.caption,
    lineHeight: 1.4,
  },
  optionList: {
    margin: `${spacing.elementsGap}px 0 0`,
    paddingLeft: 16,
    ...typography.caption,
    lineHeight: 1.4,
  },
  input: {
    ...sharedStyles.inputSm,
    width: 80,
    boxSizing: "border-box",
    height: 22,
  },
  select: {
    ...sharedStyles.selectSm,
    padding: "2px 18px 2px 4px",
  },
  // `pattern_list`/`split_generation_config` edit buttons -- same row height as `input`/`select`
  // (not the semantic button layout defaults, which would stretch the row
  // taller than every other param's control and reads as inconsistent).
  paramButton: {
    boxSizing: "border-box",
    height: 22,
    padding: "0 8px",
    borderRadius: radius.sm,
    cursor: "default",
    flexShrink: 0,
  },
  // `display: flex` (not the default `inline`) so this stopPropagation wrapper doesn't disturb
  // `row`'s flex layout — `Switch`'s own `flexShrink: 0` still applies to it as a flex item.
  switchWrap: {
    display: "flex",
    flexShrink: 0,
  },
  intervalWrap: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    flexShrink: 0,
  },
  intervalSeparator: {
    ...typography.caption,
  },
  percentSliderWrap: {
    display: "flex",
    alignItems: "center",
    gap: spacing.groupGap,
    flex: 1,
    justifyContent: "flex-end",
  },
  percentSlider: {
    width: 100,
  },
  percentSliderValue: {
    ...typography.caption,
    width: 32,
    textAlign: "right",
    flexShrink: 0,
  },
};
