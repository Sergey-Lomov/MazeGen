import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, EyeOff, Repeat, X } from "lucide-react";
import { Modal } from "../Modal";
import { Switch } from "../Switch";
import { ToggleRow } from "../ToggleRow";
import { Button } from "../Button";
import { EditIconButton } from "../EditIconButton";
import { RemoveIconButton } from "../RemoveIconButton";
import { AddIconButton } from "../AddIconButton";
import { SelectRow } from "../SelectRow";
import { NumberInput } from "../NumberInput";
import { Inline } from "../Layout";
import { ui, radius, typography, muted, disabled as disabledText, spacing, indent, dialogSpacing, controlRowHeight } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier, ColorModel, ColorChannel } from "../../store/parameterLinks";
import { getParamValue, reachableFrom, wouldCreateCycle } from "../../store/slices/parameterLinksEngine";
import { colorToHex } from "../../store/colorMath";
import * as m from "~/paraglide/messages";

/** Full hierarchical display name for a registry path — its `group` path segments joined with
 *  " / ", followed by its own `label` (e.g. `["Vertical connections", "Elevator"]` + "Marker" →
 *  "Vertical connections / Elevator / Marker"). Used everywhere a path's name is shown: the link
 *  list's own rows and the Add/Edit picker. An empty `group` (the four `SharedStyleSourceFields`
 *  entries) falls back to the bare `label`. */
function hierarchicalLabel<P extends string>(path: P, registry: Record<P, ParamDescriptor>): string {
  const { group, label } = registry[path];
  return group.length === 0 ? label : `${group.join(" / ")} / ${label}`;
}

/** Structural equality of two modifier chains, treating an empty chain as no chain. */
function sameChain<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  return JSON.stringify(a?.length ? a : undefined) === JSON.stringify(b?.length ? b : undefined);
}

const MODIFIER_SYMBOL: Record<ParamModifier["op"], string> = { add: "+", sub: "−", mul: "×", div: "÷" };

/** Short operator-chain suffix appended after a link row's "= Source" line (e.g. " +3 ×1.5") —
 *  GitHub issue #645. Each step renders in list order, same order `applyModifiers` evaluates them
 *  in. Empty string for a pure-equality link (`modifiers: undefined`/empty), so the row reads
 *  exactly as it did before #645 in that case. */
function modifierSuffix(modifiers: ParamModifier[] | undefined): string {
  if (!modifiers || modifiers.length === 0) return "";
  return " " + modifiers.map((modifier) => `${MODIFIER_SYMBOL[modifier.op]} ${modifier.value}`).join(" ");
}

/** Display label for one `ColorChannel`, e.g. "R" / "H" — independent per-model even where two
 *  channels share a letter (`hsl-h`/`oklch-h` both read "H"), since the chain's `model` already
 *  disambiguates them visually (see `COLOR_CHANNEL_OPTIONS`). */
const COLOR_CHANNEL_LABEL: Record<ColorChannel, string> = {
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
function colorModifierStepText(modifier: ColorModifier): string {
  return `${MODIFIER_SYMBOL[modifier.op]} ${modifier.value}${COLOR_CHANNEL_LABEL[modifier.channel]} (${COLOR_MODEL_LABEL[modifier.model]})`;
}

/** Short operator-chain suffix for a color link's row, same convention as `modifierSuffix`. */
function colorModifierSuffix(modifiers: ColorModifier[] | undefined): string {
  if (!modifiers || modifiers.length === 0) return "";
  return " " + modifiers.map(colorModifierStepText).join(" ");
}

/** Renders a path's `hierarchicalLabel` as one clickable "bubble" per segment (each `group` entry
 *  plus the field's own `label`, "/"-separated) instead of one plain string — each bubble has a
 *  faint background so it reads as its own distinct token without shouting, and a stronger hover
 *  highlight on top of that. Clicking a segment sets the dialog's breadcrumb filter path to that
 *  segment *and every segment before it* (`onSegmentClick`) — clicking "Elevator" in "Vertical
 *  connections / Elevator / Marker" filters to "Vertical connections / Elevator", not just
 *  "Elevator", since the earlier segments narrow down which "Elevator" is meant (there could be one
 *  under a different top-level group too). A first-segment click is just that one segment, with
 *  nothing before it to prepend. */
function HierarchicalLabelSegments<P extends string>({
  path,
  registry,
  onSegmentClick,
  inactive,
}: {
  path: P;
  registry: Record<P, ParamDescriptor>;
  onSegmentClick: (path: string[]) => void;
  /** GitHub issue #670 — renders a closed-eye badge right after the path's last segment when
   *  `true` (the parameter is currently hidden by the render-mode settings panel itself, e.g. a
   *  teleport field while the maze has no teleports), with a tooltip explaining why. */
  inactive?: boolean;
}) {
  const { group, label } = registry[path];
  const segments = [...group, label];
  return (
    <>
      {segments.map((segment, i) => (
        <span key={i}>
          {i > 0 && " / "}
          <span
            className="hoverable-tint"
            style={styles.labelBubble}
            onClick={(e) => {
              e.stopPropagation();
              onSegmentClick(segments.slice(0, i + 1));
            }}
          >
            {segment}
          </span>
        </span>
      ))}
      {inactive && (
        <span title={m["image_export.param_links.inactive_hint"]()} style={styles.inactiveBadge}>
          <EyeOff size={13} strokeWidth={2.5} />
        </span>
      )}
    </>
  );
}

/** One node of the picker's group tree — either a leaf (an actual `P` path) or a group folder
 *  (one `registry[path].group` segment) holding further children, built by `buildPickerTree`. */
export type PickerNode<P extends string> =
  | { kind: "leaf"; path: P; label: string }
  | { kind: "group"; label: string; groupKey: string; children: PickerNode<P>[] };

/** Groups `paths` into a tree by each path's `registry[path].group` segments (the same section/
 *  subsection path the settings panel itself uses) — siblings alphabetized, groups before leaves
 *  at each level. `groupKey` is the joined path segments so far, used as the node's React key and
 *  its expand/collapse identity. */
function buildPickerTree<P extends string>(paths: P[], registry: Record<P, ParamDescriptor>): PickerNode<P>[] {
  type Bucket = { groups: Map<string, Bucket>; leaves: P[] };
  const root: Bucket = { groups: new Map(), leaves: [] };
  for (const path of paths) {
    let bucket = root;
    for (const segment of registry[path].group) {
      let next = bucket.groups.get(segment);
      if (!next) {
        next = { groups: new Map(), leaves: [] };
        bucket.groups.set(segment, next);
      }
      bucket = next;
    }
    bucket.leaves.push(path);
  }
  function toNodes(bucket: Bucket, groupKeyPrefix: string): PickerNode<P>[] {
    const groupNodes: PickerNode<P>[] = [...bucket.groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([segment, child]) => ({
        kind: "group" as const,
        label: segment,
        groupKey: `${groupKeyPrefix}/${segment}`,
        children: toNodes(child, `${groupKeyPrefix}/${segment}`),
      }));
    const leafNodes: PickerNode<P>[] = bucket.leaves
      .map((path) => ({ kind: "leaf" as const, path, label: registry[path].label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...groupNodes, ...leafNodes];
  }
  return toNodes(root, "");
}

/** Whether every leaf under `node` is inactive (GitHub issue #688) — a group node gets the same
 *  closed-eye badge and dimming as a leaf once none of its descendants are currently shown in the
 *  settings panel, so a fully-hidden section doesn't look identical to an active one just because
 *  its own row has no `activePaths` entry of its own. An empty group (no leaves at all, impossible
 *  via `buildPickerTree` but kept defensive) counts as not-inactive — nothing to hide. */
export function allLeavesInactive<P extends string>(node: PickerNode<P>, activePaths: Set<P>): boolean {
  if (node.kind === "leaf") return !activePaths.has(node.path);
  if (node.children.length === 0) return false;
  return node.children.every((child) => allLeavesInactive(child, activePaths));
}

/** Whether every leaf under `node` is in `disabledPaths` (GitHub issue #721) — a group row gets the
 *  same disabled dimming as its leaves, so a collapsed all-unavailable section doesn't look
 *  selectable. An empty group counts as not-disabled. */
export function allLeavesDisabled<P extends string>(node: PickerNode<P>, disabledPaths: Set<P> | undefined): boolean {
  if (!disabledPaths) return false;
  if (node.kind === "leaf") return disabledPaths.has(node.path);
  if (node.children.length === 0) return false;
  return node.children.every((child) => allLeavesDisabled(child, disabledPaths));
}

/** Resolves `buildPickerTree`'s nodes down to the group addressed by `path` (empty = root) —
 *  returns that group's own children (sub-groups and leaves), or `null` if `path` no longer
 *  matches any group (e.g. it pointed at what's now a leaf, or links changed underneath it). */
function childrenAtPath<P extends string>(tree: PickerNode<P>[], path: string[]): PickerNode<P>[] | null {
  let nodes = tree;
  for (const segment of path) {
    const next = nodes.find((n) => n.kind === "group" && n.label === segment);
    if (!next || next.kind !== "group") return null;
    nodes = next.children;
  }
  return nodes;
}

/** Breadcrumb-trail navigator replacing a free-text search box (GitHub issue #644 follow-up) — the
 *  link list can only ever be filtered by an actual parameter address, never an arbitrary typed
 *  word, so this walks the same group tree `ParamPicker` uses (here built only from paths actually
 *  referenced by some link's `target`/`source`, not the full registry) one level at a time instead
 *  of offering free text. The path (`value`) renders as a chip trail; clicking the bar opens a
 *  dropdown of the current level's children, picking a sub-group chip appends a segment and
 *  re-opens the dropdown one level deeper, picking a leaf parameter sets the path to its full
 *  address and closes the dropdown (narrowing the list to that exact parameter, same as clicking a
 *  `HierarchicalLabelSegments` leaf's last segment). The trailing "×" (the same `X`/`sharedStyles
 *  .closeBtn` convention `Modal`'s own close button uses) clears the whole path. A sibling flat
 *  `ArrowLeft` button right after the bar (rendered by the caller, see `toolbar`) pops exactly one
 *  trailing segment — also reachable via Backspace while hovering the bar, without needing to open
 *  the dropdown first. */
function BreadcrumbNav<P extends string>({
  tree,
  value,
  onChange,
  onPopLast,
}: {
  tree: PickerNode<P>[];
  value: string[];
  onChange: (path: string[]) => void;
  onPopLast: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  // Backspace-to-pop works on hover or while the level dropdown is open — not just focus, no
  // reliable CSS-only way to react to Backspace, so this listens on `document` but only while one
  // of those is true. `open` matters on its own: picking a sub-group leaves the mouse over a
  // dropdown row, not the bar, so `hovered` alone would stop tracking mid-drill-down.
  useEffect(() => {
    if (!hovered && !open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Backspace") {
        e.preventDefault();
        onPopLast();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hovered, open, onPopLast]);

  const children = childrenAtPath(tree, value);

  return (
    <div ref={rootRef} style={styles.breadcrumbRoot}>
      <div
        className="hoverable-tint"
        style={styles.breadcrumbBar}
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {value.length === 0 ? (
          <span style={styles.breadcrumbPlaceholder}>{m["image_export.param_links.breadcrumb_placeholder"]()}</span>
        ) : (
          value.map((segment, i) => (
            <span key={i} style={styles.breadcrumbChip}>
              {i > 0 && <span style={styles.breadcrumbSep}>/</span>}
              {segment}
            </span>
          ))
        )}
        {value.length > 0 && (
          <button
            type="button"
            className="hoverable"
            style={styles.breadcrumbPop}
            title={m["image_export.param_links.breadcrumb_back"]()}
            onClick={(e) => {
              e.stopPropagation();
              onPopLast();
            }}
          >
            <ArrowLeft size={16} />
          </button>
        )}
        {value.length > 0 && (
          <button
            type="button"
            className="hoverable"
            style={styles.breadcrumbClear}
            title={m["image_export.param_links.breadcrumb_clear"]()}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {open && children && children.length > 0 && (
        <div style={styles.breadcrumbDropdown}>
          {children.map((node) =>
            node.kind === "leaf" ? (
              <div
                key={node.path}
                className="hoverable"
                style={styles.pickerRow}
                onClick={() => {
                  onChange([...value, node.label]);
                  setOpen(false);
                }}
              >
                {node.label}
              </div>
            ) : (
              <div
                key={node.groupKey}
                className="hoverable"
                style={styles.pickerGroupRow}
                onClick={() => onChange([...value, node.label])}
              >
                <ChevronRight size={14} color={ui.text.tertiary} />
                {node.label}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Every `groupKey` (same joined-segments identity `buildPickerTree`'s group nodes use) on the
 *  path to `path`'s own leaf — used to pre-expand `ParamPicker`'s tree down to an already-selected
 *  parameter (e.g. the field the link-status icon was clicked from) so it's visible and highlighted
 *  instead of collapsed inside a closed group. `path === null` yields no keys. */
function expandedGroupKeysFor<P extends string>(path: P | null, registry: Record<P, ParamDescriptor>): Set<string> {
  if (path === null) return new Set();
  const keys = new Set<string>();
  let prefix = "";
  for (const segment of registry[path].group) {
    prefix = `${prefix}/${segment}`;
    keys.add(prefix);
  }
  return keys;
}

/** Hierarchical, collapsible parameter picker (target or source) — used only inside `LinkEditor`.
 *  Mirrors the settings panel's own section/subsection nesting (`registry[path].group`) rather
 *  than a flat alphabetical list, so a field is found where it's expected instead of scanning one
 *  long list by its full "Section / Subsection / Field" string. Scoped to whichever paths the
 *  caller passes in (all paths for `Target`, same-type-and-not-target paths for `Source`), reports
 *  the picked leaf path via `onPick`. */
function ParamPicker<P extends string>({
  paths,
  registry,
  selected,
  onPick,
  activePaths,
  disabledPaths,
}: {
  paths: P[];
  registry: Record<P, ParamDescriptor>;
  selected: P | null;
  onPick: (path: P) => void;
  /** Paths currently shown in the settings panel (GitHub issue #670) — a leaf not in this set gets
   *  a closed-eye badge after its label, regardless of whether it was already filtered out of
   *  `paths` by the caller's own "Show inactive" toggle. */
  activePaths: Set<P>;
  /** Leaves shown but not pickable (GitHub issue #721) — dimmed, with a cycle icon and a tooltip
   *  on the whole row explaining that picking them would create a cyclic dependency. */
  disabledPaths?: Set<P>;
}) {
  const tree = buildPickerTree(paths, registry);
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedGroupKeysFor(selected, registry));

  useEffect(() => {
    if (selected === null) return;
    setExpanded((prev) => new Set([...prev, ...expandedGroupKeysFor(selected, registry)]));
  }, [selected, registry]);

  function toggle(groupKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function renderNodes(nodes: PickerNode<P>[], depth: number): React.ReactNode[] {
    return nodes.map((node) => {
      if (node.kind === "leaf") {
        const inactive = !activePaths.has(node.path);
        const disabled = disabledPaths?.has(node.path) ?? false;
        return (
          <div
            key={node.path}
            className={disabled ? undefined : "hoverable"}
            title={disabled ? m["image_export.param_links.cycle_hint"]() : undefined}
            aria-disabled={disabled || undefined}
            style={{
              ...styles.pickerRow,
              paddingLeft: depth * indent.tree + 4,
              ...(inactive ? styles.pickerRowInactive : {}),
              ...(disabled ? styles.pickerRowDisabled : {}),
              ...(node.path === selected ? styles.pickerRowSelected : {}),
            }}
            onClick={disabled ? undefined : () => onPick(node.path)}
          >
            {node.label}
            {disabled && (
              <span style={styles.inactiveBadge}>
                <Repeat size={13} strokeWidth={2.5} />
              </span>
            )}
            {inactive && (
              <span title={m["image_export.param_links.inactive_hint"]()} style={styles.inactiveBadge}>
                <EyeOff size={13} strokeWidth={2.5} />
              </span>
            )}
          </div>
        );
      }
      const isExpanded = expanded.has(node.groupKey);
      const groupInactive = allLeavesInactive(node, activePaths);
      const groupDisabled = allLeavesDisabled(node, disabledPaths);
      return (
        <div key={node.groupKey}>
          <div
            className="hoverable"
            style={{
              ...styles.pickerGroupRow,
              paddingLeft: depth * indent.tree + 4,
              ...(groupInactive ? styles.pickerRowInactive : {}),
              ...(groupDisabled ? { color: styles.pickerRowDisabled.color } : {}),
            }}
            onClick={() => toggle(node.groupKey)}
          >
            {isExpanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
            {node.label}
            {groupDisabled && (
              <span style={styles.inactiveBadge}>
                <Repeat size={13} strokeWidth={2.5} />
              </span>
            )}
            {groupInactive && (
              <span title={m["image_export.param_links.inactive_hint"]()} style={styles.inactiveBadge}>
                <EyeOff size={13} strokeWidth={2.5} />
              </span>
            )}
          </div>
          {isExpanded && renderNodes(node.children, depth + 1)}
        </div>
      );
    });
  }

  return <div style={styles.pickerList}>{renderNodes(tree, 0)}</div>;
}

/** Modifier operator options for one chain step's `SelectRow` — map 1:1 onto `ParamModifier["op"]`
 *  (GitHub issue #645, extended to a multi-step chain per follow-up feedback: a link may carry
 *  several of these, applied in list order, rather than at most one). */
const MODIFIER_OPTIONS: { value: ParamModifier["op"]; label: string }[] = [
  { value: "add", label: m["image_export.param_links.modifier_add"]() },
  { value: "sub", label: m["image_export.param_links.modifier_sub"]() },
  { value: "mul", label: m["image_export.param_links.modifier_mul"]() },
  { value: "div", label: m["image_export.param_links.modifier_div"]() },
];

/** One modifier symbol/short-label pair for a chain step's display text (e.g. "× 1.5"). */
function modifierStepText(modifier: ParamModifier): string {
  return `${MODIFIER_SYMBOL[modifier.op]} ${modifier.value}`;
}

/** Color model options for a color-modifier step's model `SelectRow` (GitHub issue #647) — map 1:1
 *  onto `ColorModel`. OKLCH is listed first and is the default for a brand-new step/chain
 *  (`ColorModifierStepDialog`/`LinkEditor`): channel-wise arithmetic is perceptually uniform there,
 *  while the same operation in RGB/HSL can shift perceived hue or brightness as a side effect — see
 *  `ColorModel`'s own doc comment in `parameterLinks.ts`. */
const COLOR_MODEL_OPTIONS: { value: ColorModel; label: string }[] = [
  { value: "oklch", label: m["image_export.param_links.color_model_oklch"]() },
  { value: "rgb", label: m["image_export.param_links.color_model_rgb"]() },
  { value: "hsl", label: m["image_export.param_links.color_model_hsl"]() },
];

const COLOR_MODEL_LABEL: Record<ColorModel, string> = {
  rgb: m["image_export.param_links.color_model_rgb"](),
  hsl: m["image_export.param_links.color_model_hsl"](),
  oklch: m["image_export.param_links.color_model_oklch"](),
};

/** Which `ColorChannel`s a step's channel `SelectRow` offers, keyed by the step's own `model` — a
 *  model switch resets the channel to that model's first entry (`ColorModifierStepDialog`), since a
 *  channel literal from one model (e.g. `"s"`) isn't meaningful under another. */
const CHANNELS_BY_MODEL: Record<ColorModel, ColorChannel[]> = {
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
function ModifierStepDialog({
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
            <Button variant="secondary" onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
            <Button variant="primary" disabled={!canSave} onClick={save}>
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
function ModifierStepRow({
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
function modifiersHint<P extends string>(target: P | null, source: P | null, registry: Record<P, ParamDescriptor>): string | null {
  if (target === null) return m["image_export.param_links.pick_target_first"]();
  if (source === null) return m["image_export.param_links.pick_source_first"]();
  if (registry[target].type !== "number") return m["image_export.param_links.modifiers_not_available"]();
  return null;
}

/** Same role as `modifiersHint`, for the color-modifiers column (GitHub issue #647) — the chain is
 *  only offered once both endpoints are picked and the pair is `"color"`-type. */
function colorModifiersHint<P extends string>(target: P | null, source: P | null, registry: Record<P, ParamDescriptor>): string | null {
  if (target === null) return m["image_export.param_links.pick_target_first"]();
  if (source === null) return m["image_export.param_links.pick_source_first"]();
  if (registry[target].type !== "color") return m["image_export.param_links.modifiers_not_available"]();
  return null;
}

/** One color-modifier chain-step row (GitHub issue #647) — mirrors `ModifierStepRow`. */
function ColorModifierStepRow({
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
function ColorModifierStepDialog({
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
            <Button variant="secondary" onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
            <Button variant="primary" disabled={!canSave} onClick={save}>
              {m["image_export.param_links.save_link"]()}
            </Button>
          </div>
        </div>
      }
    />
  );
}

/** Add/Edit link sub-dialog (GitHub issue #644 redesign, modifier-chain support added in #645,
 *  per-channel color-modifier chain support added in #647) — three side-by-side columns: dependent
 *  parameter and source parameter (wide, for the picker trees) and the modifier chain (narrow — just
 *  a list of short step rows plus an add button, see `modifiersColumn`). The third column renders
 *  whichever chain the picked pair's `ParamType` actually supports: the plain numeric chain
 *  (`ParamModifier`/`modifiersHint`) for `"number"`, the per-channel color chain
 *  (`ColorModifier`/`colorModifiersHint`) for `"color"`, or a hint explaining why neither applies
 *  otherwise — never both at once, since a link's `source`/`target` share one `ParamType`.
 *  `initialSource`/`initialTarget`/`initialModifiers`/`initialColorModifiers` pre-select an existing
 *  link's endpoints (and whichever chain it carries) for `Edit`, left `null`/empty for `Add link`.
 *  The dependent parameter is picked first (any path in the registry not already fixed); Source is
 *  then restricted to same-`ParamType` paths excluding the chosen dependent parameter — same
 *  constraint the engine itself enforces (`validateLinkGraph`). Paths that would close a cycle
 *  (`wouldCreateCycle`, also enforced by `addLink`) stay listed but disabled, with a cycle icon and
 *  an explanatory tooltip (GitHub issue #721), so they don't look like they vanished. Switching to
 *  a pair whose type doesn't support the chain currently being built drops it. Each step is only
 *  ever added/edited through `ModifierStepDialog`/`ColorModifierStepDialog`, never inline here. Saving is blocked while
 *  any numeric step divides by 0 (would make `target` NaN/Infinity on every propagation), via the
 *  save button's own `disabled`. */
export function LinkEditor<P extends string>({
  registry,
  activePaths,
  initialSource,
  initialTarget,
  initialModifiers,
  initialColorModifiers,
  existingLinks,
  onSave,
  onClose,
}: {
  registry: Record<P, ParamDescriptor>;
  /** All current links (GitHub issue #720) — saving onto a target that already has one asks for
   *  confirmation first, naming the source it currently depends on, since the save replaces it. */
  existingLinks: ParamLink<P>[];
  /** Paths currently shown in the settings panel (GitHub issue #670) — governs the Target/Source
   *  pickers below together with `showInactive`: listed with a closed-eye badge (and dimmed, GitHub
   *  issue #688) once on (default), hidden entirely once turned off. The currently selected
   *  target/source stays listed either way, even if it's since gone inactive, so editing an
   *  existing link never looks like its own endpoint vanished. */
  activePaths: Set<P>;
  initialSource: P | null;
  initialTarget: P | null;
  initialModifiers?: ParamModifier[];
  initialColorModifiers?: ColorModifier[];
  onSave: (source: P, target: P, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<P | null>(initialTarget);
  const [source, setSource] = useState<P | null>(initialSource);
  const [modifiers, setModifiers] = useState<ParamModifier[]>(initialModifiers ?? []);
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [addingStep, setAddingStep] = useState(false);
  const [colorModifiers, setColorModifiers] = useState<ColorModifier[]>(initialColorModifiers ?? []);
  const [editingColorStepIndex, setEditingColorStepIndex] = useState<number | null>(null);
  const [addingColorStep, setAddingColorStep] = useState(false);
  const [showInactive, setShowInactive] = useState(true);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const allPaths = Object.keys(registry) as P[];
  const visiblePaths = showInactive ? allPaths : allPaths.filter((p) => activePaths.has(p) || p === target || p === source);
  const sourceCandidates = target === null ? [] : visiblePaths.filter((p) => p !== target && registry[p].type === registry[target].type);
  const reachableFromTarget = target === null ? new Set<P>() : reachableFrom(existingLinks, target);
  const cyclicSources = new Set<P>(sourceCandidates.filter((p) => reachableFromTarget.has(p)));
  const modifiersAllowed = target !== null && source !== null && registry[target].type === "number";
  const colorModifiersAllowed = target !== null && source !== null && registry[target].type === "color";
  const hint = modifiersHint(target, source, registry);
  const colorHint = colorModifiersHint(target, source, registry);
  const hasDivideByZero = modifiers.some((mod) => mod.op === "div" && mod.value === 0) || colorModifiers.some((mod) => mod.op === "div" && mod.value === 0);
  const canSave = target !== null && source !== null && !hasDivideByZero;
  const existingLink = target === null ? null : existingLinks.find((l) => l.target === target) ?? null;
  const savedModifiers = modifiersAllowed && modifiers.length > 0 ? modifiers : undefined;
  const savedColorModifiers = colorModifiersAllowed && colorModifiers.length > 0 ? colorModifiers : undefined;
  // Only a link that actually differs from the one being replaced needs confirming — re-saving the
  // same source with the same chain changes nothing.
  const replacesDifferentLink =
    existingLink !== null &&
    !(
      existingLink.source === source &&
      sameChain(existingLink.modifiers, savedModifiers) &&
      sameChain(existingLink.colorModifiers, savedColorModifiers)
    );

  function handleTargetPick(p: P) {
    setTarget(p);
    if (source !== null && (registry[source].type !== registry[p].type || wouldCreateCycle(existingLinks, source, p))) setSource(null);
  }

  function save() {
    if (!canSave || target === null || source === null) return;
    if (replacesDifferentLink && !confirmingReplace) {
      setConfirmingReplace(true);
      return;
    }
    onSave(
      source,
      target,
      savedModifiers,
      savedColorModifiers,
    );
  }

  const showColorChain = colorModifiersAllowed;
  const thirdColumnTitle = showColorChain
    ? m["image_export.param_links.color_modifiers_label"]()
    : m["image_export.param_links.modifiers_label"]();
  const thirdColumnHint = showColorChain ? colorHint : hint;

  return (
    <>
      <Modal
        title={initialTarget === null ? m["image_export.param_links.add_link_title"]() : m["image_export.param_links.edit_link_title"]()}
        size="threeColumn"
        onClose={onClose}
        onConfirm={canSave && !confirmingReplace ? save : undefined}
        rawBody={
          <div style={styles.editorBody}>
            <div style={styles.editorColumns}>
              <div style={{ ...styles.editorColumn, ...styles.wideColumn }}>
                <div style={styles.editorColumnTitle}>{m["image_export.param_links.target_label"]()}</div>
                <ParamPicker paths={visiblePaths} registry={registry} selected={target} onPick={handleTargetPick} activePaths={activePaths} />
              </div>
              <div style={{ ...styles.editorColumn, ...styles.wideColumn }}>
                <div style={styles.editorColumnTitle}>{m["image_export.param_links.source_label"]()}</div>
                {target === null ? (
                  <div style={styles.pickerHint}>{m["image_export.param_links.pick_target_first"]()}</div>
                ) : (
                  <ParamPicker paths={sourceCandidates} registry={registry} selected={source} onPick={setSource} activePaths={activePaths} disabledPaths={cyclicSources} />
                )}
              </div>
              <div style={{ ...styles.editorColumn, ...styles.modifiersColumn }}>
                <div style={styles.editorColumnTitle}>{thirdColumnTitle}</div>
                {thirdColumnHint !== null ? (
                  <div style={styles.pickerHint}>{thirdColumnHint}</div>
                ) : showColorChain ? (
                  <>
                    {colorModifiers.map((modifier, i) => (
                      <ColorModifierStepRow
                        key={i}
                        modifier={modifier}
                        onEdit={() => setEditingColorStepIndex(i)}
                        onRemove={() => setColorModifiers((prev) => prev.filter((_, j) => j !== i))}
                      />
                    ))}
                    <div
                      className="hoverable"
                      style={styles.addModifierRow}
                      onClick={() => setAddingColorStep(true)}
                      title={m["image_export.param_links.add_color_modifier"]()}
                    >{`+ ${m["image_export.param_links.add_color_modifier_short"]()}`}</div>
                  </>
                ) : (
                  <>
                    {modifiers.map((modifier, i) => (
                      <ModifierStepRow
                        key={i}
                        modifier={modifier}
                        onEdit={() => setEditingStepIndex(i)}
                        onRemove={() => setModifiers((prev) => prev.filter((_, j) => j !== i))}
                      />
                    ))}
                    <div
                      className="hoverable"
                      style={styles.addModifierRow}
                      onClick={() => setAddingStep(true)}
                      title={m["image_export.param_links.add_modifier"]()}
                    >{`+ ${m["image_export.param_links.add_modifier_short"]()}`}</div>
                  </>
                )}
              </div>
            </div>
            <div style={styles.editorFooterRow}>
              <ToggleRow
                label={m["image_export.param_links.show_inactive_toggle"]()}
                checked={showInactive}
                onChange={setShowInactive}
                layoutStyle={styles.showInactiveToggle}
              />
              <div style={styles.editorFooter}>
                <Button variant="secondary" onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
                <Button variant="primary" disabled={!canSave} onClick={save}>
                  {m["image_export.param_links.save_link"]()}
                </Button>
              </div>
            </div>
          </div>
        }
      />
      {confirmingReplace && replacesDifferentLink && existingLink !== null && (
        <Modal
          title={m["image_export.param_links.replace_title"]()}
          onClose={() => setConfirmingReplace(false)}
          onConfirm={save}
        >
          <div style={typography.body}>
            {m["image_export.param_links.replace_message"]({ source: hierarchicalLabel(existingLink.source, registry), modifiers: `${modifierSuffix(existingLink.modifiers)}${colorModifierSuffix(existingLink.colorModifiers)}` })}
          </div>
          <div style={styles.editorFooter}>
            <Button variant="secondary" onClick={() => setConfirmingReplace(false)}>{m["image_export.param_links.cancel"]()}</Button>
            <Button variant="primary" onClick={save}>{m["image_export.param_links.replace_confirm"]()}</Button>
          </div>
        </Modal>
      )}
      {addingStep && (
        <ModifierStepDialog
          initial={null}
          onSave={(modifier) => {
            setModifiers((prev) => [...prev, modifier]);
            setAddingStep(false);
          }}
          onClose={() => setAddingStep(false)}
        />
      )}
      {editingStepIndex !== null && (
        <ModifierStepDialog
          initial={modifiers[editingStepIndex]}
          onSave={(modifier) => {
            setModifiers((prev) => prev.map((step, j) => (j === editingStepIndex ? modifier : step)));
            setEditingStepIndex(null);
          }}
          onClose={() => setEditingStepIndex(null)}
        />
      )}
      {addingColorStep && (
        <ColorModifierStepDialog
          initial={null}
          onSave={(modifier) => {
            setColorModifiers((prev) => [...prev, modifier]);
            setAddingColorStep(false);
          }}
          onClose={() => setAddingColorStep(false)}
        />
      )}
      {editingColorStepIndex !== null && (
        <ColorModifierStepDialog
          initial={colorModifiers[editingColorStepIndex]}
          onSave={(modifier) => {
            setColorModifiers((prev) => prev.map((step, j) => (j === editingColorStepIndex ? modifier : step)));
            setEditingColorStepIndex(null);
          }}
          onClose={() => setEditingColorStepIndex(null)}
        />
      )}
    </>
  );
}

/** Parameter-relationship management dialog (GitHub issue #644, redesigned per follow-up feedback
 *  to be link-centric rather than parameter-centric, then trimmed further to just the link list plus
 *  a search/add toolbar — no bulk sync/enable/disable-all actions and no summary line, since those
 *  duplicated the section-level "Synchronize" button and added chrome around what's otherwise a
 *  short list). The main screen lists only *existing* links, sorted by the dependent (target)
 *  field's own `hierarchicalLabel` — unlinked parameters aren't shown at all, so the list never
 *  grows past however many relationships the user actually set up. A toolbar above the list holds a
 *  search box (filters by substring match against either the target's or the source's
 *  `hierarchicalLabel` — a link stays visible if either side matches) and a "+" icon button (the
 *  quality panel's own `Plus` convention) that opens `LinkEditor` to add a new link. Each row carries
 *  its own enable/disable switch, an edit action (reopens `LinkEditor` pre-filled with that link's
 *  endpoints), and a delete action (removes the link entirely — distinct from disabling it, see
 *  `removeLink`'s own doc comment in `parameterLinksEngine.ts`). The full parameter list only ever
 *  appears inside `LinkEditor`, opened via the toolbar's "+" button or a row's edit action. */
export function ParameterLinksDialog<P extends string>({
  registry,
  settings,
  links,
  onSetLinkEnabled,
  onAddLink,
  onRemoveLink,
  onClose,
  activePaths,
}: {
  registry: Record<P, ParamDescriptor>;
  /** Active render mode's settings object — read-only here, just to display each link's current
   *  (target) value on its row. */
  settings: object;
  links: ParamLink<P>[];
  onSetLinkEnabled: (target: P, enabled: boolean) => void;
  onAddLink: (source: P, target: P, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  onRemoveLink: (target: P) => void;
  onClose: () => void;
  /** Paths currently shown in the settings panel (GitHub issue #670) — a path missing from this
   *  set is marked with a closed-eye badge on every row that mentions it (target or source),
   *  regardless of `LinkEditor`'s own "Show inactive" toggle, which only governs the Add/Edit
   *  pickers' own list. */
  activePaths: Set<P>;
}) {
  const [editing, setEditing] = useState<{ source: P; target: P; modifiers?: ParamModifier[]; colorModifiers?: ColorModifier[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [filterPath, setFilterPath] = useState<string[]>([]);

  function handleSave(source: P, target: P, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) {
    onAddLink(source, target, modifiers, colorModifiers);
    setEditing(null);
    setAdding(false);
  }

  function pathOf(path: P): string[] {
    const { group, label } = registry[path];
    return [...group, label];
  }

  const sortedLinks = [...links].sort((a, b) => hierarchicalLabel(a.target, registry).localeCompare(hierarchicalLabel(b.target, registry)));
  const visibleLinks = filterPath.length === 0 ? sortedLinks : sortedLinks.filter((link) => {
    const matches = (path: string[]) => filterPath.every((segment, i) => path[i] === segment);
    return matches(pathOf(link.target)) || matches(pathOf(link.source));
  });
  const breadcrumbTree = buildPickerTree(
    [...new Set(links.flatMap((link) => [link.target, link.source]))],
    registry,
  );

  return (
    <>
    <Modal
      title={m["image_export.param_links.dialog_title"]()}
      size="complex"
      onClose={onClose}
      rawBody={
        links.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyStateText}>{m["image_export.param_links.empty_title"]()}</div>
            <div style={styles.emptyStateSubtext}>{m["image_export.param_links.empty_subtitle"]()}</div>
            <Button variant="toggle" layoutStyle={{ flex: "none" }} onClick={() => setAdding(true)}>
              {m["image_export.param_links.add_link"]()}
            </Button>
          </div>
        ) : (
          <div style={styles.dialogBody}>
            <div style={styles.toolbar}>
              <BreadcrumbNav
                tree={breadcrumbTree}
                value={filterPath}
                onChange={setFilterPath}
                onPopLast={() => setFilterPath((p) => p.slice(0, -1))}
              />
              <AddIconButton title={m["image_export.param_links.add_link"]()} onClick={() => setAdding(true)} />
            </div>
            <div style={styles.toolbarDivider} />
            <div style={styles.rowsScroll}>
              <div style={styles.rows}>
                {visibleLinks.map((link) => (
                  <div key={link.id} style={{ ...styles.row, ...(link.enabled ? {} : styles.rowDisabled) }}>
                    <div style={styles.rowLine}>
                      <span style={styles.linkLabel}>
                        <HierarchicalLabelSegments path={link.target} registry={registry} onSegmentClick={setFilterPath} inactive={!activePaths.has(link.target)} />
                      </span>
                      <Switch
                        checked={link.enabled}
                        onChange={(enabled) => onSetLinkEnabled(link.target, enabled)}
                        ariaLabel={m["image_export.param_links.enabled_toggle"]()}
                      />
                      <EditIconButton
                        title={m["image_export.param_links.edit_link_title"]()}
                        onClick={() => setEditing({ source: link.source, target: link.target, modifiers: link.modifiers, colorModifiers: link.colorModifiers })}
                      />
                      <RemoveIconButton
                        title={m["image_export.param_links.remove_link"]()}
                        size={16}
                        onClick={() => onRemoveLink(link.target)}
                      />
                    </div>
                    <div style={styles.rowLine}>
                      <span style={styles.valueLabel}>
                        {m["image_export.param_links.value_prefix"]()}{registry[link.target].format(getParamValue(settings, link.target))}
                        {registry[link.target].type === "color" && (
                          <span style={{ ...styles.valueColorSwatch, backgroundColor: colorToHex(getParamValue(settings, link.target) as number) }} />
                        )}
                        {" = "}<HierarchicalLabelSegments path={link.source} registry={registry} onSegmentClick={setFilterPath} inactive={!activePaths.has(link.source)} />{modifierSuffix(link.modifiers)}{colorModifierSuffix(link.colorModifiers)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      }
    />
      {adding && (
        <LinkEditor registry={registry} activePaths={activePaths} existingLinks={links} initialSource={null} initialTarget={null} onSave={handleSave} onClose={() => setAdding(false)} />
      )}
      {editing && (
        <LinkEditor
          registry={registry}
          activePaths={activePaths}
          existingLinks={links}
          initialSource={editing.source}
          initialTarget={editing.target}
          initialModifiers={editing.modifiers}
          initialColorModifiers={editing.colorModifiers}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  labelBubble: { cursor: "default", padding: "0 2px", borderRadius: 3, background: ui.bg.panelAlt },
  inactiveBadge: { display: "inline-flex", alignItems: "center", marginLeft: 4, color: ui.text.tertiary, cursor: "default" },
  // Replaces `Modal`'s own padded `body` now that this dialog uses `rawBody` (GitHub issue #645
  // follow-up) — needed so the toolbar below can stay `flexShrink: 0` while only the row list
  // scrolls, which `Modal.body`'s single `overflowY: auto` container couldn't give us.
  dialogBody: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
  },
  toolbar: { display: "flex", alignItems: "center", gap: spacing.itemGap, flexShrink: 0 },
  // Horizontal rule under the toolbar (GitHub issue #645 follow-up) — `dialogBody`'s own `gap`
  // already separates it from the toolbar above and the scroll area below, so the scrollable
  // list starts right beneath this line rather than floating in extra whitespace.
  toolbarDivider: { height: 1, background: ui.border.default, flexShrink: 0, margin: 0 },
  rowsScroll: { flex: 1, minHeight: 0, overflowY: "auto" as const },
  breadcrumbRoot: { position: "relative" as const, flex: 1, minWidth: 0 },
  breadcrumbBar: {
    ...typography.field,
    display: "flex",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
    background: ui.bg.input,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    padding: "2px 6px",
    cursor: "default",
  },
  breadcrumbPlaceholder: { ...muted(typography.field) },
  breadcrumbChip: { display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const },
  breadcrumbSep: { ...muted(typography.field) },
  breadcrumbPop: { ...sharedStyles.closeBtn, display: "flex", alignItems: "center", marginLeft: "auto", flexShrink: 0 },
  breadcrumbClear: { ...sharedStyles.closeBtn, display: "flex", alignItems: "center", flexShrink: 0 },
  breadcrumbDropdown: {
    position: "absolute" as const,
    top: "100%",
    left: 0,
    right: 0,
    marginTop: 2,
    zIndex: 10,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    background: ui.bg.panel,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
    padding: 4,
    maxHeight: 220,
    overflowY: "auto" as const,
  },
  emptyState: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.groupGap,
    padding: `${spacing.sectionGap * 2}px ${dialogSpacing.paddingX}px`,
  },
  emptyStateText: { ...typography.body },
  emptyStateSubtext: { ...muted(typography.caption) },
  rows: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
    background: ui.bg.panel,
    borderRadius: radius.md,
    border: `1px solid ${ui.border.default}`,
    padding: "7px 6px 7px 10px",
  },
  rowDisabled: { opacity: 0.5 },
  rowLine: { display: "flex", alignItems: "center", gap: spacing.groupGap },
  linkLabel: { ...typography.body, flex: 1, minWidth: 0 },
  valueLabel: { ...muted(typography.caption), flex: 1, minWidth: 0 },
  valueColorSwatch: {
    display: "inline-block",
    width: 14,
    height: 14,
    borderRadius: 3,
    marginLeft: 4,
    verticalAlign: "middle",
    border: `1px solid ${ui.border.default}`,
  },
  editorBody: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    padding: `${dialogSpacing.bodyPadding}px ${dialogSpacing.paddingX}px`,
    gap: dialogSpacing.gap,
  },
  editorColumns: { display: "flex", gap: spacing.sectionGap, flex: 1, minHeight: 0 },
  editorColumn: { flex: 1, display: "flex", flexDirection: "column", gap: spacing.itemGap, minWidth: 0, minHeight: 0, overflowY: "auto" as const },
  // `position: sticky` alone lets scrolled rows show through since the title has no fill of its
  // own — an opaque background matching the dialog's (`Modal`'s `ui.bg.panel`) is what actually
  // clips them instead of letting them bleed through underneath (GitHub issue #645 follow-up).
  editorColumnTitle: { ...typography.body, position: "sticky" as const, top: 0, background: ui.bg.panel, paddingBottom: spacing.elementsGap, zIndex: 1 },
  pickerList: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  pickerRow: { ...typography.body, cursor: "default", padding: "2px 4px", borderRadius: 3 },
  // GitHub issue #688 — dims a hidden leaf/group row so it reads as inactive at a glance, on top of
  // the closed-eye badge; applied before `pickerRowSelected` so a selected-but-inactive row still
  // shows its selection highlight.
  pickerRowInactive: { ...muted(typography.body) },
  pickerRowDisabled: { ...disabledText(typography.body), cursor: "not-allowed" },
  pickerRowSelected: { background: ui.state.selected },
  pickerGroupRow: {
    ...typography.body,
    display: "flex",
    alignItems: "center",
    gap: spacing.elementsGap,
    cursor: "default",
    padding: "2px 4px",
    borderRadius: 3,
  },
  pickerHint: { ...muted(typography.caption) },
  // Narrower than the target/source picker columns (GitHub issue #645 follow-up) — the modifiers
  // column only ever holds short step rows ("× 1.5") plus an icon-sized add button, so it needs far
  // less width than the picker trees do.
  wideColumn: { flex: 1.4 },
  modifiersColumn: { flex: 0.6 },
  // Same horizontal inset/radius as `pickerRow`/`pickerGroupRow` (GitHub issue #645 follow-up) —
  // the Target/Source columns' content is never flush with the column edge, and this column's
  // chain-step rows shouldn't be the one exception.
  modifierStep: { display: "flex", alignItems: "center", gap: spacing.elementsGap, padding: "2px 4px", borderRadius: 3 },
  modifierStepText: { ...typography.body, flex: 1 },
  modifierError: { ...typography.caption, color: ui.text.error },
  // Same look as the quality panel's rule-title rename input (`ruleCardTitleInput`), minus its
  // `fontWeight: 600` — this is `sharedStyles.inputSm` itself, the un-bolded base that
  // `ruleCardTitleInput` builds on. `height`/`boxSizing` pinned to `controlRowHeight` so it lines
  // up exactly with the op `<select>` beside it (`modifierOpSelect`) — their native heights
  // otherwise differ slightly (GitHub issue #645 follow-up).
  modifierValueInput: { ...sharedStyles.inputSm, height: controlRowHeight, boxSizing: "border-box" as const },
  modifierOpSelect: { height: controlRowHeight, boxSizing: "border-box" as const },
  // Same `pickerRow` convention as every other row in this dialog (GitHub issue #645 follow-up) —
  // the row's own box IS the column's full width with the hover fill on it, and `padding: "2px
  // 4px"` is purely the text's internal inset, not an outer margin — so its hover highlight spans
  // edge-to-edge exactly like the Target/Source columns' own rows, with no gap on either side.
  addModifierRow: { ...typography.body, color: ui.text.tertiary, cursor: "default", padding: "2px 4px", borderRadius: 3 },
  editorFooter: { display: "flex", justifyContent: "flex-end", gap: spacing.groupGap, flexShrink: 0 },
  editorFooterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing.groupGap, paddingTop: spacing.groupGap, flexShrink: 0 },
  // `ToggleRow`'s own `Inline` defaults to `flex: 1` on its label group, which would stretch it
  // across the whole footer row and push the Cancel/Save buttons off to the far right rather than
  // sitting right next to the toggle (GitHub issue #688) — capped to its content width instead.
  showInactiveToggle: { flex: "none" },
};
