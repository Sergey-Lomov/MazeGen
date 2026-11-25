import { useState } from "react";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Bubble, BubbleArrow, IdBubble, bubbleColors, type BubbleColors } from "../Bubble";
import { TileFaceEditor } from "./TileFaceEditor";
import type { TileFaceNode } from "../../domain/tileFace";
import { splitNodeDiagnostics } from "../../pixi/splitNodeDiagnostics";
import { blueprintNumber, fittingRotation, orientationsOf, tileNodesForBlueprint, type SplitNodeBlueprint } from "../../domain/splitBlueprints";
import { messageForTitleKey } from "../../domain/splitPatternTitles";
import { Tooltip } from "../Tooltip";
import { WarningsSection } from "../WarningsSection";
import { ui, typography, radius, spacing, indent, muted } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import * as m from "~/paraglide/messages";
import type { FieldConfig } from "../../fieldConfig";
import type React from "react";
import type { NodeLockKind } from "../../wasm/types";
import { splitShapeBinding } from "../../domain/splitShape";
import { canvas } from "../../domain/colorTokens";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";
import { focusCell } from "../../pixi/viewportScaleBridge";
import type { EditRefusalSource } from "../../notifications/editRefusalNotifications";
import { AddIconButton } from "../AddIconButton";
import { FlatIconButton } from "../FlatIconButton";
import { EntityColorSwatch } from "../EntityColorSwatch";
import { ListCell, ListCellAction } from "../ListCell";
import { ToolIconButton } from "../ToolIconButton";
import { ToolGlyph } from "./ToolGlyph";
import { canRotateSplit } from "../../domain/splitShape";
import { Focus, RotateCcw, RotateCw } from "lucide-react";

/** One link (edge or teleport) from a node, resolved to a small display label — grouped into 3
 *  sections in the card (GitHub issue #234 follow-up): `required` (a decided passage/one-way,
 *  always present — the connection *will* exist), `undefined` (preset's optional/undecided face —
 *  *may* exist, not forced either way; every face starts here by default; post-edit has no such
 *  concept, so this section is always empty there), `forbidden` (`wall` — this node's face is
 *  explicitly closed here). Named `undefined` (not "allowed") to match the preset connection
 *  state's own name — "allowed" read as ambiguous next to "required"/"forbidden". */
export type LinkCategory = "required" | "undefined" | "forbidden";

export interface LinkInfo<E> {
  otherLabel: string;
  arrow: string;
  category: LinkCategory;
  /** Geometric face index of this row's endpoint; keeps bubble position stable across edge kinds. */
  faceIndex?: number;
  /** The link's partner endpoint — used to highlight this specific connection on the canvas while
   *  the bubble is hovered (GitHub issue #237), same coordinates the tile diagram/canvas renderer
   *  already resolve endpoints to. */
  otherEndpoint: E;
}

export interface ElementInfo<E = unknown> {
  title: string;
  entityId?: string;
  bubbles: string[];
  bubbleFloors?: (number | undefined)[];
  showArrow: boolean;
  arrow: "->" | "<-" | "<->";
  hoverEndpoints?: E[];
}

/** Groups a node's directed passage/teleport entries by partner, collapsing a bidirectional pair
 *  (both `mark(partner, "out")` and `mark(partner, "in")` called for the same partner — a
 *  two-way passage always writes both, a two-way teleport marks both explicitly) into a single
 *  `"<->"` link instead of showing the same connection twice. Shared by `ManageSplitNodesDialog`
 *  (post-edit, `PostEditEndpoint`) and `PresetSplitNodesDialog` (preset stage, `PresetEndpoint`) —
 *  the only difference between the two was this bookkeeping; each adapter's own `wall`/`undefined`
 *  handling (categories the tracker doesn't produce) stays inline at the call site since those
 *  differ enough between the two stages not to be worth abstracting. `endpointKey` must produce a
 *  stable, comparable string per endpoint (`endpointKey`/`presetEndpointKey`); `describeEndpoint`
 *  resolves a partner endpoint to its display label. */
export function createRequiredLinksTracker<E>(
  endpointKey: (ep: E) => string,
  describeEndpoint: (ep: E) => string,
) {
  const byPartner = new Map<string, { otherLabel: string; otherEndpoint: E; out: boolean; in: boolean }>();
  const mark = (partnerEp: E, direction: "out" | "in") => {
    const partnerKey = endpointKey(partnerEp);
    const entry = byPartner.get(partnerKey) ?? { otherLabel: describeEndpoint(partnerEp), otherEndpoint: partnerEp, out: false, in: false };
    entry[direction] = true;
    byPartner.set(partnerKey, entry);
  };
  const finalize = (): LinkInfo<E>[] => [...byPartner.values()].map(({ otherLabel, otherEndpoint, out, in: isIn }) => ({
    otherLabel,
    otherEndpoint,
    arrow: out && isIn ? "<->" : isIn ? "<-" : "->",
    category: "required" as const,
  }));
  return { mark, finalize };
}

/** Connection kind the dialog's own switcher can pick, independent of the canvas's globally
 * active tool (GitHub issue #234). `"undefined"` (preset optional connection — a preset that
 * allows an edge without forcing it) and `"wall"` (forbid a connection on this face, for this
 * node specifically) are offered only by the preset-stage adapter — post-edit has no equivalent
 * of either. */
export type SplitEdgeKind = "passage" | "one_way" | "undefined" | "wall";

export interface SplitNodesRow<E> {
  key: string;
  endpoint: E;
  title: string;
  /** Matches this row's color in the tile diagram (`TileFaceNode.color`) — shown as a small dot
   * before the row's title. */
  color: string;
  removable: boolean;
  active: boolean;
  ownLabel: string;
  links: LinkInfo<E>[];
  elements: ElementInfo<E>[];
  lockKind?: NodeLockKind;
  lockAutomatic?: boolean;
}

interface Props<E> {
  title: string;
  point: [number, number];
  cfg: FieldConfig;
  currentLevel: number;
  rows: SplitNodesRow<E>[];
  /** Every node's faces at once, in row order — the tile diagram draws all of them
   * simultaneously, each in its own color (GitHub issue #234). */
  tileNodes: TileFaceNode[];
  availableKinds: SplitEdgeKind[];
  activeKind: SplitEdgeKind;
  onKindChange: (kind: SplitEdgeKind) => void;
  onFaceClick: (offsetIndex: number) => void;
  /** Right-click on a non-boundary face — forbids the active node's connection there. */
  onFaceRightClick: (offsetIndex: number) => void;
  onClose: () => void;
  onSetActive: (endpoint: E) => void;
  onAdd: () => void;
  onRemove: (row: SplitNodesRow<E>) => void;
  /** Rotates every node's connections by one geometric face, clockwise (`1`) or counter-clockwise
   * (`-1`) — see `rotatePostEditSplitPoint`/`rotatePresetSplitPoint`. */
  onRotate: (direction: 1 | -1) => void;
  allowFaceReassignmentRotation?: boolean;
  /** Dry-runs a rotate and reports whether it would break a neighboring split point's currently
   *  recognized special shape (bridge/diagonal/etc. — GitHub issue #588), so `onRotate` can be
   *  gated behind a `ConfirmModal` instead of silently degrading the neighbor's rendering. Optional
   *  — omitted by the pattern editor, which has no neighbor-shape concept to check. */
  wouldBreakNeighborShape?: (direction: 1 | -1) => boolean;
  notificationSource: EditRefusalSource;
  /** Hovering a link bubble highlights that specific connection on the canvas (GitHub issue #237)
   *  — same mechanism as `EdgeHighlightRenderer`'s existing hover highlight, driven here by the
   *  panel instead of a canvas pointermove. `row` is the bubble's own card row (the link's "from"
   *  side); `link.otherEndpoint` is its partner. Optional — the pattern editor has no canvas to
   *  highlight anything on. */
  onHoverLink?: (row: SplitNodesRow<E>, link: LinkInfo<E>) => void;
  onUnhoverLink?: () => void;
  onHoverElement?: (row: SplitNodesRow<E>, element: ElementInfo<E>) => void;
  onUnhoverElement?: () => void;
  onEntityIdClick?: (id: string) => void;
  /** Built-in split-node blueprints (GitHub issue #235) available at this point's tile degree —
   *  `[]` if none are defined. Optional: the pattern editor has no point/field concept to offer
   *  these against. */
  blueprints?: SplitNodeBlueprint[];
  /** Applies `blueprint` (already rotated to fit the point's boundary, see `fittingRotation`) —
   *  a full replace of the point's current nodes/connections. */
  onApplyBlueprint?: (blueprint: SplitNodeBlueprint) => void;
  /** Forwarded straight to the underlying `SidePanel.onTopChange` (GitHub issue #629 follow-up) —
   *  lets an adapter react to this dialog being covered by another `SidePanel` (or uncovered
   *  again), e.g. `ManageSplitNodesDialog` clearing its on-canvas cell outline while covered. */
  onTopChange?: (isTop: boolean) => void;
}

/** Exported for `AbstractPatternEditorDialog` (GitHub issue #222) — the pattern editor doesn't
 *  reuse this whole component (it has no `NodeId`/start/finish/link-section concept, only
 *  face-index/sibling_target data), but its own tile+card layout should still look identical, so
 *  it borrows this label map and `dialogPanelStyles` below rather than redefining them. */
export const KIND_LABEL: Record<SplitEdgeKind, () => string> = {
  passage: () => m["post_edit.split_kind_passage"](),
  one_way: () => m["post_edit.split_kind_one_way"](),
  undefined: () => m["post_edit.split_kind_undefined"](),
  wall: () => m["post_edit.split_kind_wall"](),
};

const NOOP = () => {};
const EDGE_TOOL_ORDER: SplitEdgeKind[] = ["wall", "passage", "undefined", "one_way"];

function FilledLockIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" fill="currentColor" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function linkBubbleColors(category: LinkCategory): BubbleColors {
  if (category === "required") return bubbleColors("neutral");
  if (category === "forbidden") return bubbleColors("danger");
  return { bg: ui.bg.panelAlt, text: ui.text.secondary };
}

function linkTooltip(category: LinkCategory): string {
  if (category === "required") return m["post_edit.split_section_required"]();
  if (category === "forbidden") return m["post_edit.split_section_forbidden"]();
  return m["post_edit.split_section_undefined"]();
}

export function linkHighlightColor(category: LinkCategory): number {
  if (category === "required") return canvas.debug.refHighlight;
  if (category === "forbidden") return canvas.fieldEditor.danger;
  return canvas.wall.default;
}

/** "Manage split nodes" dialog core (GitHub issue #221/#231, redesigned for #234): a large tile
 * diagram on the left, rendered in the field's own tessellation, showing every node's faces at
 * once (each in its own color) — clicking a non-boundary face adds/edits a connection there for
 * the currently active node, using the kind picked by the switcher above the tile. A list of the
 * point's nodes sits on the right, one card per node (title row with a color dot/Active badge/
 * Remove button, links listed below); clicking a non-active card makes it the active node. Shared
 * by post-edit's `ManageSplitNodesDialog` (nodes resolved to real `NodeId`s) and the preset
 * stage's `PresetSplitNodesDialog` (nodes addressed by raw point+slot, no `NodeId` concept yet) —
 * both adapters compute `rows`/`tileNodes`/labels/links from their own data, this component owns
 * only layout/styling, the kind switcher, and the remove-confirmation flow. */
export function SplitNodesDialogView<E>({
  title, point, cfg, currentLevel, rows, tileNodes, availableKinds, activeKind, onKindChange,
  onFaceClick, onFaceRightClick, onClose, onSetActive, onAdd, onRemove, onRotate, allowFaceReassignmentRotation, wouldBreakNeighborShape, notificationSource,
  onHoverLink, onUnhoverLink, onHoverElement, onUnhoverElement, onEntityIdClick, blueprints, onApplyBlueprint,
  onTopChange,
}: Props<E>) {
  const [pendingRemove, setPendingRemove] = useState<SplitNodesRow<E> | null>(null);
  const [pendingBlueprint, setPendingBlueprint] = useState<SplitNodeBlueprint | null>(null);
  const [pendingRotate, setPendingRotate] = useState<1 | -1 | null>(null);
  // Tracks whether the user has made any manual edit to this point since the panel opened (face
  // click, add/remove node, rotate, start/finish toggle) — a fresh `useState` per mount, so it
  // resets whenever the panel reopens (React remounts on a `point` change since the caller keys
  // it, or on close/reopen). Gates the blueprint-apply confirm: applying a blueprint the instant
  // the panel opens has nothing of the user's own to lose, so no warning is needed there; once
  // they've touched anything by hand, a blueprint's full replace becomes destructive and gets the
  // confirmation. Picking a kind/making a card active doesn't count — neither changes the point's
  // actual data.
  const [hasManualEdit, setHasManualEdit] = useState(false);
  const activeRowIndex = rows.findIndex((row) => row.active);
  const activeIndex = activeRowIndex === -1 ? null : activeRowIndex;
  const warnings = splitNodeDiagnostics(tileNodes);

  // Every offered blueprint is tried at every rotation until one avoids the point's boundary
  // faces (see `fittingRotation`) — a point at the field's edge has some faces with no neighbor
  // at all, so a blueprint requiring a passage there can never be applied as authored. `null`
  // means no rotation fits; the button stays disabled.
  const shapeBinding = splitShapeBinding(cfg, point[0], point[1]);
  const orientations = shapeBinding === null ? undefined : orientationsOf(shapeBinding);
  const fittedBlueprints = (blueprints ?? []).map((bp) => ({
    original: bp,
    fitted: fittingRotation(bp, (faceIndex) => tileNodes[0]?.faces[faceIndex]?.boundary ?? false, orientations),
  }));
  const anyDisabled = fittedBlueprints.some((b) => b.fitted === null);
  const blueprintName = (blueprint: SplitNodeBlueprint) => blueprint.titleKey
    ? messageForTitleKey(blueprint.titleKey)
    : m["post_edit.split_blueprint_unnamed"]({ number: blueprintNumber(blueprint) });

  const markEdited = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    setHasManualEdit(true);
    fn(...args);
  };
  const handleFaceClick = markEdited(onFaceClick);
  const handleFaceRightClick = markEdited(onFaceRightClick);
  const handleRotateNow = markEdited(onRotate);
  const handleAdd = markEdited(onAdd);
  const handleRemove = markEdited(onRemove);
  // Dry-runs the rotation before applying it (GitHub issue #588) — if it would break a neighboring
  // split point's currently recognized special shape, confirm first instead of silently degrading
  // the neighbor's rendering.
  const handleRotate = (direction: 1 | -1) => {
    if (wouldBreakNeighborShape?.(direction)) setPendingRotate(direction);
    else handleRotateNow(direction);
  };
  const canRotate = allowFaceReassignmentRotation || canRotateSplit(cfg, point[0], point[1]);
  const lockTitle = (kind: NodeLockKind, automatic: boolean) => `${kind === "both"
    ? m["post_edit.split_lock_badge"]()
    : kind === "in"
      ? m["post_edit.split_lock_in_badge"]()
      : m["post_edit.split_lock_out_badge"]()}${automatic ? ` (${m["preset.auto_lock"]()})` : ""}`;
  const renderElement = (row: SplitNodesRow<E>, element: ElementInfo<E>, index: number) => (
    <span key={`${element.title}:${element.entityId ?? index}`} style={styles.elementRow}
      onMouseEnter={onHoverElement ? () => onHoverElement(row, element) : undefined}
      onMouseLeave={onUnhoverElement}>
      <span style={styles.elementText}>{element.title}</span>
      {element.bubbles.map((bubble, j) => {
        const floor = element.bubbleFloors?.[j];
        const floorClickable = floor !== undefined && floor !== currentLevel;
        return <span key={j} style={styles.bubbleGroup}>
          {j === 0 && element.showArrow && <BubbleArrow>{element.arrow}</BubbleArrow>}
          <Bubble
            interactive={floorClickable}
            onClick={floorClickable ? (event) => {
              event.stopPropagation();
              onUnhoverElement?.();
              onUnhoverLink?.();
              navigateToFloor(floor);
            } : undefined}
          >{bubble}</Bubble>
        </span>;
      })}
      {element.entityId !== undefined && (
        <IdBubble
          id={element.entityId}
          interactive={onEntityIdClick !== undefined}
          className={onEntityIdClick ? "hoverable" : undefined}
          onClick={onEntityIdClick ? (event) => { event.stopPropagation(); onEntityIdClick(element.entityId!); } : undefined}
        />
      )}
    </span>
  );

  return (
    <>
    <SidePanel
      title={title}
      stackKey={notificationSource === "post_edit" ? "post-edit-split-nodes" : "preset-split-nodes"}
      headerActions={<FlatIconButton title={m["post_edit.split_focus_cell"]()} onClick={() => focusCell(point)}><Focus size={16} /></FlatIconButton>}
      onClose={onClose}
      onTopChange={onTopChange}
    >
      <div style={styles.warningsSection}>
        <WarningsSection warnings={warnings} testId="split-node-warnings" />
      </div>
      <section style={styles.templatesSection}>
        <span style={sharedStyles.sectionHeader}>{m["post_edit.split_blueprints_label"]()}</span>
        {blueprints && blueprints.length > 0 && (
          <>
            <div style={styles.blueprintStrip}>
              {fittedBlueprints.map(({ original, fitted }) => (
                <Tooltip key={original.id} content={blueprintName(original)}><button
                  data-testid={`blueprint-thumb-${original.id}`}
                  className={fitted ? "hoverable" : undefined}
                  style={{ ...styles.blueprintThumb, ...(!fitted ? sharedStyles.btnDisabled : {}) }}
                  disabled={!fitted}
                  onClick={() => {
                    if (!fitted) return;
                    // Nothing of the user's own to lose if they haven't touched this point by
                    // hand yet since the panel opened — skip the destructive-replace confirm and
                    // apply immediately.
                    if (hasManualEdit) setPendingBlueprint(fitted);
                    else onApplyBlueprint?.(fitted);
                  }}
                >
                  <TileFaceEditor
                    // Same `point` as the panel's own tile diagram, not a fixed anchor — a
                    // triangle tile's shape (up vs down) depends on `(x+y) % 2` (see
                    // `getNeighborData`), so a fixed `[0,0]` anchor could show the blueprint
                    // preview in the opposite orientation from the point it'll actually apply to.
                    point={point} cfg={cfg} nodes={tileNodesForBlueprint(fitted ?? original)}
                    activeIndex={null} onFaceClick={NOOP} onFaceRightClick={NOOP} onRotate={NOOP} showRotateControls={false}
                  />
                </button></Tooltip>
              ))}
            </div>
            {anyDisabled && <span style={typography.caption}>{m["post_edit.split_blueprint_disabled_hint"]()}</span>}
          </>
        )}
      </section>
      <section style={styles.tileArea}>
        <span style={sharedStyles.sectionHeader}>{m["post_edit.split_editor_label"]()}</span>
        <div style={styles.tools}>
          {EDGE_TOOL_ORDER.filter((kind) => availableKinds.includes(kind)).map((kind) => (
            <ToolIconButton
              key={kind}
              selected={kind === activeKind}
              title={KIND_LABEL[kind]()}
              onClick={() => onKindChange(kind)}
            >
              <ToolGlyph tool={kind === "undefined" ? "reset" : kind} />
            </ToolIconButton>
          ))}
          {canRotate && <>
            <ToolIconButton selected={false} title={m["post_edit.split_rotate_ccw"]()} onClick={() => handleRotate(1)}><RotateCcw size={20} /></ToolIconButton>
            <ToolIconButton selected={false} title={m["post_edit.split_rotate_cw"]()} onClick={() => handleRotate(-1)}><RotateCw size={20} /></ToolIconButton>
          </>}
        </div>
        <TileFaceEditor
          point={point} cfg={cfg} nodes={tileNodes} activeIndex={activeIndex}
          onFaceClick={handleFaceClick} onFaceRightClick={handleFaceRightClick} onRotate={handleRotate}
          allowFaceReassignmentRotation={allowFaceReassignmentRotation}
          showRotateControls={false}
          notificationSource={notificationSource}
        />
      </section>

      <div style={styles.nodeListWrap}>
        <div style={styles.nodesHeader}>
          <span style={sharedStyles.sectionHeader}>{m["post_edit.split_nodes_label"]()}</span>
          <AddIconButton title={m["post_edit.split_add_node"]()} onClick={handleAdd} />
        </div>
        <div style={styles.nodeList}>
            {rows.map((row) => (
              <ListCell
                key={row.key}
                style={{ cursor: row.active ? "default" : "pointer" }}
                className={row.active ? undefined : "hoverable"}
                onClick={row.active ? undefined : () => onSetActive(row.endpoint)}
                current={row.active}
                title={row.title}
                titleAddon={<>
                  <EntityColorSwatch color={row.color} />
                  {row.lockKind && <Tooltip content={lockTitle(row.lockKind, row.lockAutomatic ?? false)}><span style={styles.lockIcon}><FilledLockIcon /></span></Tooltip>}
                </>}
                details={row.links.length > 0 && (
                  <div style={styles.linkBubbles}>
                    {[...row.links].sort((a, b) => (a.faceIndex ?? Infinity) - (b.faceIndex ?? Infinity) || a.otherLabel.localeCompare(b.otherLabel)).map((link, i) => (
                      <Tooltip key={`${link.faceIndex ?? "other"}:${link.otherLabel}:${i}`} content={linkTooltip(link.category)} focusable={false}>
                        <Bubble
                          colors={linkBubbleColors(link.category)}
                          onMouseEnter={onHoverLink ? () => onHoverLink(row, link) : undefined}
                          onMouseLeave={onUnhoverLink}
                        >
                          {link.arrow} {link.otherLabel}
                        </Bubble>
                      </Tooltip>
                    ))}
                  </div>
                )}
                actionsPlacement="title"
                actions={<ListCellAction
                  action="delete"
                  title={m["post_edit.split_remove"]()}
                  description={!row.removable ? m["post_edit.split_remove_original_hint"]() : undefined}
                  danger
                  disabled={!row.removable}
                  onAction={() => setPendingRemove(row)}
                />}
              >
                  {row.elements.length > 0 && (
                    <div style={styles.elementsSection}>
                      {row.elements.length === 1 ? (
                        <span style={styles.elementsLine}>
                          <span style={styles.elementTitle}>{m["post_edit.split_section_contains"]()}</span>
                          {renderElement(row, row.elements[0], 0)}
                        </span>
                      ) : (
                        <>
                          <span style={styles.elementTitle}>{m["post_edit.split_section_contains"]()}</span>
                          <div style={styles.elementsCell}>{row.elements.map((element, i) => renderElement(row, element, i))}</div>
                        </>
                      )}
                    </div>
                  )}
              </ListCell>
            ))}
        </div>

        {/* Fixed footer (GitHub issue #237 follow-up) — Add/Remove/Start/Finish controls stay
         * reachable regardless of how far the card list above is scrolled, instead of scrolling
         * off with it. */}
      </div>
    </SidePanel>
    {pendingRemove !== null && (
      <ConfirmModal
        message={m["post_edit.confirm_remove_split_node"]()}
        onConfirm={() => { handleRemove(pendingRemove); setPendingRemove(null); }}
        onCancel={() => setPendingRemove(null)}
      />
    )}
    {pendingBlueprint !== null && (
      <ConfirmModal
        message={m["post_edit.confirm_apply_blueprint"]()}
        onConfirm={() => { onApplyBlueprint?.(pendingBlueprint); setPendingBlueprint(null); }}
        onCancel={() => setPendingBlueprint(null)}
      />
    )}
    {pendingRotate !== null && (
      <ConfirmModal
        message={m["post_edit.confirm_rotate_breaks_neighbor_shape"]()}
        onConfirm={() => { handleRotateNow(pendingRotate); setPendingRotate(null); }}
        onCancel={() => setPendingRotate(null)}
      />
    )}
    </>
  );
}

/** Shared with `AbstractPatternEditorDialog` (GitHub issue #222) — that editor builds its own
 *  tile+card layout (no `NodeId`/start/finish/link-section concept to reuse this whole component
 *  for), but borrows this subset of styling so the two dialogs read as visually one family. */
export const dialogPanelStyles: Record<string, React.CSSProperties> = {
  // Panel body stacked vertically (GitHub issue #237: tile diagram on top, node list below) —
  // replaces the old modal's side-by-side left/right columns now that this content lives in a
  // narrow `SidePanel` docked beside the canvas instead of a wide centered modal.
  //
  // `minHeight: 0` on `tileArea` is required, not cosmetic — without it, a flex item's default
  // `min-height: auto` keeps it sized to its content's min-content height (buttons + tile's own
  // intrinsic size) instead of taking its allotted share of the column, so `TileFaceEditor`'s
  // `flex: 1` wrap below has no extra height to grow into and the diagram renders tiny.
  tileArea: {
    flex: "0 0 auto",
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
    padding: spacing.sectionGap,
    borderBottom: `1px solid ${ui.border.default}`,
    minHeight: 260,
  },
  // Column split into a scrolling card list and a fixed footer (GitHub issue #237 follow-up) —
  // `nodeListWrap` is the flex column, `nodeList` (`overflowY: auto`, `flex: 1`) holds only the
  // scrollable card list, `nodeListFooter` (`flex: "0 0 auto"`, outside the scroll area) holds
  // the Add/Remove/Start/Finish controls so they stay reachable regardless of scroll position.
  nodeListWrap: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  nodeList: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    padding: spacing.groupGap,
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
  },
  // One bordered card per node — the whole card (except its corner controls) is a click target
  // that activates the node. `position: relative` anchors `cardCorner`. Deliberately no
  // `paddingRight` reservation on the card itself — padding on a flex column narrows every
  // child's content box, including `linksCell`, which pushes link bubbles onto extra wrapped
  // lines even when the corner had nothing above the links row to collide with.
  // Top-right corner — Remove button (removable cards only) to the left of the Active badge (when
  // active). Absolutely positioned so it doesn't consume card width the title/links rows would
  // otherwise wrap around.
};

const styles: Record<string, React.CSSProperties> = {
  ...dialogPanelStyles,
  templatesSection: { display: "flex", flexDirection: "column", gap: spacing.groupGap, padding: spacing.sectionGap, borderBottom: `1px solid ${ui.border.default}` },
  tools: { display: "flex", justifyContent: "center", flexWrap: "wrap", gap: spacing.itemGap },
  nodesHeader: { display: "flex", alignItems: "center", gap: spacing.itemGap, padding: `${spacing.itemGap}px ${spacing.groupGap}px` },
  linkBubbles: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap / 2, minWidth: 0 },
  lockIcon: { display: "flex", color: ui.text.secondary },
  // Separate the warnings header from the panel chrome; SidePanel's body has no intrinsic top
  // padding, so without this inset the header row touches the panel header.
  warningsSection: { paddingTop: spacing.groupGap, paddingRight: spacing.groupGap },
  // `WarningsSection` owns the breathing room above its divider. Do not add a second top inset
  // here: blueprints should begin directly after that section rather than reading as a new pane.
  tileArea: { ...dialogPanelStyles.tileArea, paddingTop: 0 },
  // Horizontally scrolling strip of small blueprint thumbnails (GitHub issue #235) — each button
  // renders `TileFaceEditor` at a fixed small size instead of a text label, so a blueprint reads
  // as a preview of what it'll produce rather than a name to guess from.
  blueprintStrip: {
    display: "flex",
    flexDirection: "row",
    gap: spacing.itemGap,
    overflowX: "auto",
    paddingBottom: 2,
    paddingLeft: indent.tree,
  },
  blueprintThumb: {
    flex: "0 0 auto",
    width: 64,
    height: 64,
    padding: 4,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.md,
    background: ui.bg.panelAlt,
    cursor: "pointer",
  },
  nodeList: { ...dialogPanelStyles.nodeList, padding: 0, paddingLeft: indent.tree },
  elementsSection: { display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap },
  elementsLine: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap / 2 },
  elementsCell: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2, paddingLeft: indent.tree },
  elementRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.rowGap },
  elementText: muted(typography.body),
  elementTitle: { ...muted(typography.body), whiteSpace: "nowrap" },
  bubbleGroup: { display: "inline-flex", alignItems: "center", gap: spacing.rowGap },
};
