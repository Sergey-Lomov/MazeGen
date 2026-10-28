import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, EyeOff, Repeat, X } from "lucide-react";
import { Tooltip } from "../Tooltip";
import { ui, indent } from "../../styles/theme";
import type { ParamDescriptor } from "../../store/parameterLinks";
import * as m from "~/paraglide/messages";
import { styles } from "./ParameterLinksDialog.styles";

/** One node of the picker's group tree — either a leaf (an actual `P` path) or a group folder
 *  (one `registry[path].group` segment) holding further children, built by `buildPickerTree`. */
export type PickerNode<P extends string> =
  | { kind: "leaf"; path: P; label: string }
  | { kind: "group"; label: string; groupKey: string; children: PickerNode<P>[] };

/** Groups `paths` into a tree by each path's `registry[path].group` segments (the same section/
 *  subsection path the settings panel itself uses) — siblings alphabetized, groups before leaves
 *  at each level. `groupKey` is the joined path segments so far, used as the node's React key and
 *  its expand/collapse identity. */
export function buildPickerTree<P extends string>(paths: P[], registry: Record<P, ParamDescriptor>): PickerNode<P>[] {
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

/** Filters a picker tree by a case-insensitive substring `query` (GitHub issue #732) — a leaf is
 *  kept when its own label or any ancestor group's label matches, and groups are kept only while
 *  they still hold a kept leaf, so every surviving leaf stays under its full parent chain. A blank
 *  query returns the tree unchanged. */
export function filterPickerTree<P extends string>(tree: PickerNode<P>[], query: string): PickerNode<P>[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return tree;
  function walk(nodes: PickerNode<P>[], ancestorMatches: boolean): PickerNode<P>[] {
    const result: PickerNode<P>[] = [];
    for (const node of nodes) {
      const selfMatches = ancestorMatches || node.label.toLowerCase().includes(needle);
      if (node.kind === "leaf") {
        if (selfMatches) result.push(node);
        continue;
      }
      const children = walk(node.children, selfMatches);
      if (children.length > 0) result.push({ ...node, children });
    }
    return result;
  }
  return walk(tree, false);
}

/** Every group's `groupKey` in `tree`, recursively — used to force-expand a filtered tree. */
export function allGroupKeys<P extends string>(tree: PickerNode<P>[]): Set<string> {
  const keys = new Set<string>();
  for (const node of tree) {
    if (node.kind !== "group") continue;
    keys.add(node.groupKey);
    for (const key of allGroupKeys(node.children)) keys.add(key);
  }
  return keys;
}

/** Resolves `buildPickerTree`'s nodes down to the group addressed by `path` (empty = root) —
 *  returns that group's own children (sub-groups and leaves), or `null` if `path` no longer
 *  matches any group (e.g. it pointed at what's now a leaf, or links changed underneath it). */
export function childrenAtPath<P extends string>(tree: PickerNode<P>[], path: string[]): PickerNode<P>[] | null {
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
export function BreadcrumbNav<P extends string>({
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
          <Tooltip content={m["image_export.param_links.breadcrumb_back"]()}><button
            type="button"
            className="hoverable"
            style={styles.breadcrumbPop}
            onClick={(e) => {
              e.stopPropagation();
              onPopLast();
            }}
          >
            <ArrowLeft size={16} />
          </button></Tooltip>
        )}
        {value.length > 0 && (
          <Tooltip content={m["image_export.param_links.breadcrumb_clear"]()}><button
            type="button"
            className="hoverable"
            style={styles.breadcrumbClear}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            <X size={16} />
          </button></Tooltip>
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
export function expandedGroupKeysFor<P extends string>(path: P | null, registry: Record<P, ParamDescriptor>): Set<string> {
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
export function ParamPicker<P extends string>({
  paths,
  registry,
  selected,
  onPick,
  activePaths,
  disabledPaths,
  locked,
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
  /** GitHub issue #732 follow-up — whole picker read-only: search input disabled, no row or group
   *  can be clicked. The selected leaf stays highlighted (its groups pre-expanded). Used for the
   *  dependent parameter while editing an existing link. */
  locked?: boolean;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const tree = filterPickerTree(buildPickerTree(paths, registry), query);
  const forcedExpanded = searching ? allGroupKeys(tree) : null;
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
          <Tooltip key={node.path} block content={disabled ? m["image_export.param_links.cycle_hint"]() : undefined}><div
            className={disabled || locked ? undefined : "hoverable"}
            aria-disabled={disabled || undefined}
            style={{
              ...styles.pickerRow,
              paddingLeft: depth * indent.tree + 4,
              ...(inactive ? styles.pickerRowInactive : {}),
              ...(disabled ? styles.pickerRowDisabled : {}),
              ...(locked && node.path !== selected ? styles.pickerRowLocked : {}),
              ...(node.path === selected ? styles.pickerRowSelected : {}),
            }}
            onClick={disabled || locked ? undefined : () => onPick(node.path)}
          >
            {node.label}
            {disabled && (
              <span style={styles.inactiveBadge}>
                <Repeat size={13} strokeWidth={2.5} />
              </span>
            )}
            {inactive && (
              <Tooltip content={m["image_export.param_links.inactive_hint"]()}><span style={styles.inactiveBadge}>
                <EyeOff size={13} strokeWidth={2.5} />
              </span></Tooltip>
            )}
          </div></Tooltip>
        );
      }
      const isExpanded = forcedExpanded?.has(node.groupKey) ?? expanded.has(node.groupKey);
      const groupInactive = allLeavesInactive(node, activePaths);
      const groupDisabled = allLeavesDisabled(node, disabledPaths);
      return (
        <div key={node.groupKey}>
          <div
            className={locked ? undefined : "hoverable"}
            style={{
              ...styles.pickerGroupRow,
              ...(locked ? styles.pickerRowLocked : {}),
              paddingLeft: depth * indent.tree + 4,
              ...(groupInactive ? styles.pickerRowInactive : {}),
              ...(groupDisabled ? { color: styles.pickerRowDisabled.color } : {}),
            }}
            onClick={locked ? undefined : () => toggle(node.groupKey)}
          >
            {isExpanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
            {node.label}
            {groupDisabled && (
              <span style={styles.inactiveBadge}>
                <Repeat size={13} strokeWidth={2.5} />
              </span>
            )}
            {groupInactive && (
              <Tooltip content={m["image_export.param_links.inactive_hint"]()}><span style={styles.inactiveBadge}>
                <EyeOff size={13} strokeWidth={2.5} />
              </span></Tooltip>
            )}
          </div>
          {isExpanded && renderNodes(node.children, depth + 1)}
        </div>
      );
    });
  }

  return (
    <>
      <input
        type="text"
        value={query}
        disabled={locked}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={m["image_export.param_links.picker_search_placeholder"]()}
        aria-label={m["image_export.param_links.picker_search_placeholder"]()}
        style={styles.pickerSearch}
      />
      <div style={styles.pickerList}>{renderNodes(tree, 0)}</div>
    </>
  );
}
