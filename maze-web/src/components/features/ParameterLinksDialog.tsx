import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, X } from "lucide-react";
import { Modal } from "../Modal";
import { Switch } from "../Switch";
import { Button } from "../Button";
import { EditIconButton } from "../EditIconButton";
import { RemoveIconButton } from "../RemoveIconButton";
import { AddIconButton } from "../AddIconButton";
import { ui, radius, typography, muted, spacing, indent, dialogSpacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import type { ParamDescriptor, ParamLink } from "../../store/parameterLinks";
import { getParamValue } from "../../store/slices/parameterLinksEngine";
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
}: {
  path: P;
  registry: Record<P, ParamDescriptor>;
  onSegmentClick: (path: string[]) => void;
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
    </>
  );
}

/** One node of the picker's group tree — either a leaf (an actual `P` path) or a group folder
 *  (one `registry[path].group` segment) holding further children, built by `buildPickerTree`. */
type PickerNode<P extends string> =
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
}: {
  paths: P[];
  registry: Record<P, ParamDescriptor>;
  selected: P | null;
  onPick: (path: P) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = buildPickerTree(paths, registry);

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
        return (
          <div
            key={node.path}
            className="hoverable"
            style={{
              ...styles.pickerRow,
              paddingLeft: depth * indent.tree + 4,
              ...(node.path === selected ? styles.pickerRowSelected : {}),
            }}
            onClick={() => onPick(node.path)}
          >
            {node.label}
          </div>
        );
      }
      const isExpanded = expanded.has(node.groupKey);
      return (
        <div key={node.groupKey}>
          <div
            className="hoverable"
            style={{ ...styles.pickerGroupRow, paddingLeft: depth * indent.tree + 4 }}
            onClick={() => toggle(node.groupKey)}
          >
            {isExpanded ? <ChevronDown size={14} color={ui.text.tertiary} /> : <ChevronRight size={14} color={ui.text.tertiary} />}
            {node.label}
          </div>
          {isExpanded && renderNodes(node.children, depth + 1)}
        </div>
      );
    });
  }

  return <div style={styles.pickerList}>{renderNodes(tree, 0)}</div>;
}

/** Add/Edit link sub-dialog (GitHub issue #644 redesign) — same picker UI for both flows;
 *  `initialSource`/`initialTarget` pre-select an existing link's endpoints for `Edit`, left `null`
 *  for `Add link`. `Target` is picked first (any path in the registry not already fixed); `Source`
 *  is then restricted to same-`ParamType` paths excluding the chosen target — same constraint the
 *  engine itself enforces (`validateLinkGraph`). */
function LinkEditor<P extends string>({
  registry,
  initialSource,
  initialTarget,
  onSave,
  onClose,
}: {
  registry: Record<P, ParamDescriptor>;
  initialSource: P | null;
  initialTarget: P | null;
  onSave: (source: P, target: P) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<P | null>(initialTarget);
  const [source, setSource] = useState<P | null>(initialSource);
  const allPaths = Object.keys(registry) as P[];
  const sourceCandidates = target === null ? [] : allPaths.filter((p) => p !== target && registry[p].type === registry[target].type);

  function handleTargetPick(p: P) {
    setTarget(p);
    if (source !== null && (source === p || registry[source].type !== registry[p].type)) setSource(null);
  }

  return (
    <Modal
      title={initialTarget === null ? m["image_export.param_links.add_link_title"]() : m["image_export.param_links.edit_link_title"]()}
      size="complex"
      onClose={onClose}
      onConfirm={target !== null && source !== null ? () => onSave(source, target) : undefined}
      rawBody={
        <div style={styles.editorBody}>
          <div style={styles.editorColumns}>
            <div style={styles.editorColumn}>
              <div style={styles.editorColumnTitle}>{m["image_export.param_links.target_label"]()}</div>
              <ParamPicker paths={allPaths} registry={registry} selected={target} onPick={handleTargetPick} />
            </div>
            <div style={styles.editorColumn}>
              <div style={styles.editorColumnTitle}>{m["image_export.param_links.source_label"]()}</div>
              {target === null ? (
                <div style={styles.pickerHint}>{m["image_export.param_links.pick_target_first"]()}</div>
              ) : (
                <ParamPicker paths={sourceCandidates} registry={registry} selected={source} onPick={setSource} />
              )}
            </div>
          </div>
          <div style={styles.editorFooter}>
            <Button variant="secondary" onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
            <Button
              variant="primary"
              disabled={target === null || source === null}
              onClick={() => target !== null && source !== null && onSave(source, target)}
            >
              {m["image_export.param_links.save_link"]()}
            </Button>
          </div>
        </div>
      }
    />
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
}: {
  registry: Record<P, ParamDescriptor>;
  /** Active render mode's settings object — read-only here, just to display each link's current
   *  (target) value on its row. */
  settings: object;
  links: ParamLink<P>[];
  onSetLinkEnabled: (target: P, enabled: boolean) => void;
  onAddLink: (source: P, target: P) => void;
  onRemoveLink: (target: P) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<{ source: P; target: P } | null>(null);
  const [adding, setAdding] = useState(false);
  const [filterPath, setFilterPath] = useState<string[]>([]);

  function handleSave(source: P, target: P) {
    onAddLink(source, target);
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
    <Modal title={m["image_export.param_links.dialog_title"]()} size="complex" onClose={onClose}>
      {links.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyStateText}>{m["image_export.param_links.empty_title"]()}</div>
          <div style={styles.emptyStateSubtext}>{m["image_export.param_links.empty_subtitle"]()}</div>
          <Button variant="toggle" layoutStyle={{ flex: "none" }} onClick={() => setAdding(true)}>
            {m["image_export.param_links.add_link"]()}
          </Button>
        </div>
      ) : (
        <>
          <div style={styles.toolbar}>
            <BreadcrumbNav
              tree={breadcrumbTree}
              value={filterPath}
              onChange={setFilterPath}
              onPopLast={() => setFilterPath((p) => p.slice(0, -1))}
            />
            <AddIconButton title={m["image_export.param_links.add_link"]()} onClick={() => setAdding(true)} />
          </div>
          <div style={styles.rows}>
            {visibleLinks.map((link) => (
              <div key={link.id} style={{ ...styles.row, ...(link.enabled ? {} : styles.rowDisabled) }}>
                <div style={styles.rowLine}>
                  <span style={styles.linkLabel}>
                    <HierarchicalLabelSegments path={link.target} registry={registry} onSegmentClick={setFilterPath} />
                  </span>
                  <Switch
                    checked={link.enabled}
                    onChange={(enabled) => onSetLinkEnabled(link.target, enabled)}
                    ariaLabel={m["image_export.param_links.enabled_toggle"]()}
                  />
                  <EditIconButton
                    title={m["image_export.param_links.edit_link_title"]()}
                    onClick={() => setEditing({ source: link.source, target: link.target })}
                  />
                  <RemoveIconButton
                    title={m["image_export.param_links.remove_link"]()}
                    size={16}
                    onClick={() => onRemoveLink(link.target)}
                  />
                </div>
                <div style={styles.rowLine}>
                  <span style={styles.valueLabel}>
                    {m["image_export.param_links.value_prefix"]()}{registry[link.target].format(getParamValue(settings, link.target))} = <HierarchicalLabelSegments path={link.source} registry={registry} onSegmentClick={setFilterPath} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {adding && (
        <LinkEditor registry={registry} initialSource={null} initialTarget={null} onSave={handleSave} onClose={() => setAdding(false)} />
      )}
      {editing && (
        <LinkEditor
          registry={registry}
          initialSource={editing.source}
          initialTarget={editing.target}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  labelBubble: { cursor: "default", padding: "0 2px", borderRadius: 3, background: ui.bg.panelAlt },
  toolbar: { display: "flex", alignItems: "center", gap: spacing.itemGap },
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
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.groupGap,
    padding: `${spacing.sectionGap * 2}px 0`,
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
  editorColumnTitle: { ...typography.body, position: "sticky" as const, top: 0 },
  pickerList: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  pickerRow: { ...typography.body, cursor: "default", padding: "2px 4px", borderRadius: 3 },
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
  editorFooter: { display: "flex", justifyContent: "flex-end", gap: spacing.groupGap, paddingTop: spacing.groupGap, flexShrink: 0 },
};
