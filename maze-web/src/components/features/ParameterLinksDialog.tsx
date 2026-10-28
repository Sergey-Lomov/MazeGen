import { useState } from "react";
import { EyeOff } from "lucide-react";
import { Modal } from "../Modal";
import { Switch } from "../Switch";
import { ToggleRow } from "../ToggleRow";
import { Button } from "../Button";
import { EditIconButton } from "../EditIconButton";
import { RemoveIconButton } from "../RemoveIconButton";
import { AddIconButton } from "../AddIconButton";
import { Tooltip } from "../Tooltip";
import { typography } from "../../styles/theme";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier } from "../../store/parameterLinks";
import { getParamValue, reachableFrom, wouldCreateCycle } from "../../store/slices/parameterLinksEngine";
import { colorToHex } from "../../store/colorMath";
import * as m from "~/paraglide/messages";
import { styles } from "./ParameterLinksDialog.styles";
import { buildPickerTree, BreadcrumbNav, ParamPicker } from "./ParameterLinksPicker";
import { linkModifiersSuffix, ModifierStepDialog, ModifierStepRow, modifiersHint, colorModifiersHint, ColorModifierStepRow, ColorModifierStepDialog } from "./ParameterLinksModifiers";

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
        <Tooltip content={m["image_export.param_links.inactive_hint"]()}><span style={styles.inactiveBadge}>
          <EyeOff size={13} strokeWidth={2.5} />
        </span></Tooltip>
      )}
    </>
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
                <ParamPicker paths={visiblePaths} registry={registry} selected={target} onPick={handleTargetPick} activePaths={activePaths} locked={initialTarget !== null} />
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
                <Button variant="secondary" dialogAction onClick={onClose}>{m["image_export.param_links.cancel"]()}</Button>
                <Button variant="primary" dialogAction disabled={!canSave} onClick={save}>
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
            {m["image_export.param_links.replace_message"]({ source: hierarchicalLabel(existingLink.source, registry), modifiers: linkModifiersSuffix(existingLink) })}
          </div>
          <div style={styles.editorFooter}>
            <Button variant="secondary" dialogAction onClick={() => setConfirmingReplace(false)}>{m["image_export.param_links.cancel"]()}</Button>
            <Button variant="primary" dialogAction onClick={save}>{m["image_export.param_links.replace_confirm"]()}</Button>
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
                        {" = "}<HierarchicalLabelSegments path={link.source} registry={registry} onSegmentClick={setFilterPath} inactive={!activePaths.has(link.source)} />{linkModifiersSuffix(link)}
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

