import { useState } from "react";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Button } from "../Button";
import { TileFaceEditor, type TileFaceNode } from "./TileFaceEditor";
import { splitNodeDiagnostics } from "../../pixi/splitNodeDiagnostics";
import { fittingRotation, tileNodesForBlueprint, type SplitNodeBlueprint } from "../../pixi/splitBlueprints";
import { ui, typography, radius, spacing, indent, muted } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { Inline, Stack } from "../Layout";
import * as m from "~/paraglide/messages";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type React from "react";
import type { NodeLockKind } from "../../wasm/types";
import { navigateToFloor } from "../../pixi/renderers/floorNavigation";

/** 1-based node number for a split point's node, in row order (GitHub issue #468). Slot 0 is not a
 *  special node any more — every node of a split point, the point's original node included, gets the
 *  same numbering: the original node is `1`, a slot's number is its `slotId + 2` (matching
 *  `NodeDto.i + 1`, since `slotId` is `i - 1`). Shared by `ManageSplitNodesDialog` and
 *  `PresetSplitNodesDialog`. */
export const splitNodeNumber = (slotId: number | undefined): number => (slotId === undefined ? 1 : slotId + 2);

/** Full "Node N" label — for a row title / the cell-inspector-style status readout. */
export const splitNodeLabel = (slotId: number | undefined): string =>
  m["post_edit.split_node_label"]({ slotId: splitNodeNumber(slotId) });

/** Compact "N{N}" label — for the link-bubble coordinate suffix, where space is tight. */
export const splitNodeLabelShort = (slotId: number | undefined): string =>
  m["post_edit.split_node_label_short"]({ slotId: splitNodeNumber(slotId) });

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
}

interface Props<E> {
  title: string;
  point: [number, number];
  cfg: TessellationConfig;
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
  /** Dry-runs a rotate and reports whether it would break a neighboring split point's currently
   *  recognized special shape (bridge/diagonal/etc. — GitHub issue #588), so `onRotate` can be
   *  gated behind a `ConfirmModal` instead of silently degrading the neighbor's rendering. Optional
   *  — omitted by the pattern editor, which has no neighbor-shape concept to check. */
  wouldBreakNeighborShape?: (direction: 1 | -1) => boolean;
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

const SECTION_LABEL: Record<LinkCategory, () => string> = {
  required: () => m["post_edit.split_section_required"](),
  undefined: () => m["post_edit.split_section_undefined"](),
  forbidden: () => m["post_edit.split_section_forbidden"](),
};

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
  onFaceClick, onFaceRightClick, onClose, onSetActive, onAdd, onRemove, onRotate, wouldBreakNeighborShape,
  onHoverLink, onUnhoverLink, onHoverElement, onUnhoverElement, onEntityIdClick, blueprints, onApplyBlueprint,
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
  const activeRow = rows.find((row) => row.active);
  const activeRowIndex = rows.findIndex((row) => row.active);
  const activeIndex = activeRowIndex === -1 ? null : activeRowIndex;
  const warnings = splitNodeDiagnostics(tileNodes);

  // Every offered blueprint is tried at every rotation until one avoids the point's boundary
  // faces (see `fittingRotation`) — a point at the field's edge has some faces with no neighbor
  // at all, so a blueprint requiring a passage there can never be applied as authored. `null`
  // means no rotation fits; the button stays disabled.
  const isBoundary = (faceIndex: number) => tileNodes[0]?.faces[faceIndex]?.boundary ?? false;
  const fittedBlueprints = (blueprints ?? []).map((bp) => ({ original: bp, fitted: fittingRotation(bp, isBoundary) }));
  const anyDisabled = fittedBlueprints.some((b) => b.fitted === null);

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

  return (
    <>
    <SidePanel title={title} onClose={onClose} warnings={warnings}>
      <div style={styles.tileArea}>
        {blueprints && blueprints.length > 0 && (
          <Stack gap="itemGap">
            <span style={typography.body}>{m["post_edit.split_blueprints_label"]()}</span>
            <div style={styles.blueprintStrip}>
              {fittedBlueprints.map(({ original, fitted }) => (
                <button
                  key={original.id}
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
                </button>
              ))}
            </div>
            {anyDisabled && <span style={typography.caption}>{m["post_edit.split_blueprint_disabled_hint"]()}</span>}
          </Stack>
        )}
        <Inline gap="itemGap" justify="center" style={{ flexWrap: "wrap" }}>
          {availableKinds.map((kind) => (
            <Button
              key={kind}
              variant={kind === activeKind ? "toggle-selected" : "toggle"}
              onClick={() => onKindChange(kind)}
            >
              {KIND_LABEL[kind]()}
            </Button>
          ))}
        </Inline>
        <TileFaceEditor
          point={point} cfg={cfg} nodes={tileNodes} activeIndex={activeIndex}
          onFaceClick={handleFaceClick} onFaceRightClick={handleFaceRightClick} onRotate={handleRotate}
        />
      </div>

      <div style={styles.nodeListWrap}>
        <div style={styles.nodeList}>
          <Stack gap="itemGap">
            {rows.map((row) => (
              <div
                key={row.key}
                style={{ ...styles.card, cursor: row.active ? "default" : "pointer" }}
                className={row.active ? undefined : "hoverable"}
                onClick={row.active ? undefined : () => onSetActive(row.endpoint)}
              >
                {row.active && (
                  <div style={styles.cardCorner}>
                    <span style={styles.activeBadge}>{m["post_edit.split_active_badge"]()}</span>
                  </div>
                )}
                <div style={styles.titleLine}>
                  <span style={{ ...styles.colorDot, background: row.color }} />
                  <span style={typography.body}>{row.title}</span>
                  {row.lockKind && <span style={{ ...styles.badge, ...styles.lockBadge }}>{row.lockKind === "both" ? m["post_edit.split_lock_badge"]() : row.lockKind === "in" ? m["post_edit.split_lock_in_badge"]() : m["post_edit.split_lock_out_badge"]()}</span>}
                </div>
                <div>
                  {(["required", "undefined", "forbidden"] as const).map((category) => {
                    const links = row.links.filter((l) => l.category === category);
                    if (links.length === 0) return null;
                    return (
                      <div key={category} style={styles.linksSection}>
                        <span style={typography.body}>{SECTION_LABEL[category]()}</span>
                        <div style={styles.linksCell}>
                          {links.map((link, i) => (
                              <span
                                key={i}
                                style={styles.bubble}
                                onMouseEnter={onHoverLink ? () => onHoverLink(row, link) : undefined}
                                onMouseLeave={onUnhoverLink}
                              >
                                {row.ownLabel} {link.arrow} {link.otherLabel}
                              </span>
                            ))}
                        </div>
                      </div>
                    );
                  })}
                  {row.elements.length > 0 && (
                    <div style={styles.elementsSection}>
                      <span style={typography.body}>{m["post_edit.split_section_elements"]()}</span>
                      <div style={styles.elementsCell}>
                        {row.elements.map((element, i) => (
                          <span key={`${element.title}:${element.entityId ?? i}`} style={styles.elementRow}
                            onMouseEnter={onHoverElement ? () => onHoverElement(row, element) : undefined}
                            onMouseLeave={onUnhoverElement}>
                            <span style={styles.elementTitle}>{element.title}</span>
                            {element.bubbles.map((bubble, j) => {
                              const floor = element.bubbleFloors?.[j];
                              const floorClickable = floor !== undefined && floor !== currentLevel;
                              return (
                              <span key={j} style={styles.bubbleGroup}>
                                {j === 0 && element.showArrow && <span style={styles.arrow}>{element.arrow}</span>}
                                <span
                                  style={{ ...styles.bubble, ...(floorClickable ? styles.clickableBubble : {}) }}
                                  onClick={floorClickable ? (event) => {
                                    event.stopPropagation();
                                    onUnhoverElement?.();
                                    onUnhoverLink?.();
                                    navigateToFloor(floor);
                                  } : undefined}
                                >{bubble}</span>
                              </span>
                              );
                            })}
                            {element.entityId !== undefined && (
                              <span
                                className={onEntityIdClick ? "hoverable" : undefined}
                                style={{ ...styles.idBubble, ...(onEntityIdClick ? styles.clickableBubble : {}) }}
                                onClick={onEntityIdClick ? (event) => { event.stopPropagation(); onEntityIdClick(element.entityId!); } : undefined}
                              >
                                id: {element.entityId}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </Stack>
        </div>

        {/* Fixed footer (GitHub issue #237 follow-up) — Add/Remove/Start/Finish controls stay
         * reachable regardless of how far the card list above is scrolled, instead of scrolling
         * off with it. */}
        <div style={styles.nodeListFooter}>
          <Stack gap="itemGap">
            <Inline gap="itemGap">
              <Button variant="primary" layoutStyle={{ flex: 1 }} onClick={handleAdd}>
                {m["post_edit.split_add_node"]()}
              </Button>
              <Button
                variant="destructive"
                layoutStyle={{ flex: 1 }}
                disabled={!activeRow?.removable}
                onClick={() => activeRow && setPendingRemove(activeRow)}
              >
                {m["post_edit.split_remove"]()}
              </Button>
            </Inline>
          </Stack>
        </div>
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
  nodeListFooter: {
    flex: "0 0 auto",
    padding: spacing.groupGap,
    borderTop: `1px solid ${ui.border.default}`,
  },
  // One bordered card per node — the whole card (except its corner controls) is a click target
  // that activates the node. `position: relative` anchors `cardCorner`. Deliberately no
  // `paddingRight` reservation on the card itself — padding on a flex column narrows every
  // child's content box, including `linksCell`, which pushes link bubbles onto extra wrapped
  // lines even when the corner had nothing above the links row to collide with.
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    padding: spacing.itemGap,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.md,
  },
  // Top-right corner — Remove button (removable cards only) to the left of the Active badge (when
  // active). Absolutely positioned so it doesn't consume card width the title/links rows would
  // otherwise wrap around.
  cardCorner: {
    position: "absolute",
    top: spacing.itemGap,
    right: spacing.itemGap,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  titleLine: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    flexWrap: "wrap",
    paddingRight: 28,
  },
  colorDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-block",
  },
  activeBadge: {
    ...typography.control,
    fontSize: 11,
    padding: "0 6px",
    border: `1px solid ${ui.accent.base}`,
    background: ui.accent.base,
    color: ui.text.inverse,
    borderRadius: radius.sm,
    whiteSpace: "nowrap",
  },
};

const styles: Record<string, React.CSSProperties> = {
  ...dialogPanelStyles,
  // Horizontally scrolling strip of small blueprint thumbnails (GitHub issue #235) — each button
  // renders `TileFaceEditor` at a fixed small size instead of a text label, so a blueprint reads
  // as a preview of what it'll produce rather than a name to guess from.
  blueprintStrip: {
    display: "flex",
    flexDirection: "row",
    gap: spacing.itemGap,
    overflowX: "auto",
    paddingBottom: 2,
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
  // `marginTop` is a fixed value (not conditional on `row.active`) — a per-card conditional here
  // previously made active/inactive cards different heights, causing every card's layout to shift
  // on every active-node change (GitHub issue #234 follow-up).
  linksSection: {
    marginTop: spacing.groupGap,
  },
  linksCell: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.itemGap,
    paddingLeft: indent.tree,
    marginTop: 2,
  },
  // Same shape as `DebugRefBubble`'s coordinate bubble — reused for visual consistency, not its
  // hover/click behavior (this dialog's bubbles are plain, non-interactive labels).
  bubble: {
    ...typography.caption,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text,
    color: ui.debug.refHighlight.text,
    whiteSpace: "nowrap",
  },
  clickableBubble: { cursor: "pointer" },
  badge: {
    ...typography.control,
    fontSize: 11,
    padding: "0 6px",
    borderRadius: radius.sm,
    whiteSpace: "nowrap",
  },
  startBadge: {
    background: ui.text.success,
    color: ui.text.inverse,
  },
  finishBadge: {
    background: ui.text.error,
    color: ui.text.inverse,
  },
  elementsSection: {
    display: "flex", flexDirection: "column", gap: spacing.itemGap, marginTop: spacing.itemGap,
  },
  elementsCell: { display: "flex", flexDirection: "column", gap: spacing.itemGap / 2, paddingLeft: indent.tree },
  elementRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.rowGap },
  elementTitle: { ...muted(typography.body), whiteSpace: "nowrap" },
  bubbleGroup: { display: "inline-flex", alignItems: "center", gap: spacing.rowGap },
  idBubble: {
    ...typography.caption, fontFamily: "Consolas, Menlo, Monaco, monospace", display: "inline-flex",
    alignItems: "center", borderStyle: "solid", borderWidth: 1, borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`, background: ui.bg.success, borderColor: ui.text.success,
    color: ui.text.success, whiteSpace: "nowrap",
  },
  lockBadge: {
    background: ui.text.secondary,
    color: ui.bg.app,
  },
};
