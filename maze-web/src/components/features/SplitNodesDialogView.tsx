import { useState } from "react";
import { Modal } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { TileFaceEditor, type TileFaceNode } from "./TileFaceEditor";
import { ui, typography, radius, spacing, indent } from "../../styles/theme";
import { buttonStyle, sharedStyles } from "../../styles/shared";
import { Inline, Stack } from "../Layout";
import * as m from "~/paraglide/messages";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type React from "react";

/** One link (edge or teleport) from a node, resolved to a small display label — grouped into 3
 *  sections in the card (GitHub issue #234 follow-up): `required` (a decided passage/one-way,
 *  always present — the connection *will* exist), `undefined` (preset's optional/undecided face —
 *  *may* exist, not forced either way; every face starts here by default; post-edit has no such
 *  concept, so this section is always empty there), `forbidden` (`wall` — this node's face is
 *  explicitly closed here). Named `undefined` (not "allowed") to match the preset connection
 *  state's own name — "allowed" read as ambiguous next to "required"/"forbidden". */
export type LinkCategory = "required" | "undefined" | "forbidden";

export interface LinkInfo {
  otherLabel: string;
  arrow: string;
  category: LinkCategory;
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
  const byPartner = new Map<string, { otherLabel: string; out: boolean; in: boolean }>();
  const mark = (partnerEp: E, direction: "out" | "in") => {
    const partnerKey = endpointKey(partnerEp);
    const entry = byPartner.get(partnerKey) ?? { otherLabel: describeEndpoint(partnerEp), out: false, in: false };
    entry[direction] = true;
    byPartner.set(partnerKey, entry);
  };
  const finalize = (): LinkInfo[] => [...byPartner.values()].map(({ otherLabel, out, in: isIn }) => ({
    otherLabel,
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
  links: LinkInfo[];
  isStart: boolean;
  isFinish: boolean;
}

interface Props<E> {
  title: string;
  point: [number, number];
  cfg: TessellationConfig;
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
  /** Assigns/clears start or finish on the currently active node (the same one tile-face clicks
   * target) — a separate instant-action block next to the kind switcher, not a per-tool pick like
   * `activeKind` (GitHub issue #234 follow-up). */
  onToggleStart: () => void;
  onToggleFinish: () => void;
  /** Rotates every node's connections by one geometric face, clockwise (`1`) or counter-clockwise
   * (`-1`) — see `rotatePostEditSplitPoint`/`rotatePresetSplitPoint`. */
  onRotate: (direction: 1 | -1) => void;
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
  title, point, cfg, rows, tileNodes, availableKinds, activeKind, onKindChange,
  onFaceClick, onFaceRightClick, onClose, onSetActive, onAdd, onRemove, onToggleStart, onToggleFinish, onRotate,
}: Props<E>) {
  const [pendingRemove, setPendingRemove] = useState<SplitNodesRow<E> | null>(null);
  const activeRow = rows.find((row) => row.active);
  const activeRowIndex = rows.findIndex((row) => row.active);
  const activeIndex = activeRowIndex === -1 ? null : activeRowIndex;

  return (
    <>
    <Modal title={title} size="wide" onClose={onClose} rawBody={
      <div style={styles.split}>
        <div style={styles.left}>
          <Inline gap="itemGap" justify="center" style={{ flexWrap: "wrap" }}>
            {availableKinds.map((kind) => (
              <button
                key={kind}
                className={kind === activeKind ? "hoverable-accent" : "hoverable"}
                style={buttonStyle(kind === activeKind ? "toggle-active" : "toggle")}
                onClick={() => onKindChange(kind)}
              >
                {KIND_LABEL[kind]()}
              </button>
            ))}
          </Inline>
          <TileFaceEditor
            point={point} cfg={cfg} nodes={tileNodes} activeIndex={activeIndex}
            onFaceClick={onFaceClick} onFaceRightClick={onFaceRightClick} onRotate={onRotate}
          />
        </div>

        <div style={styles.right}>
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
                  {row.isStart && <span style={{ ...styles.badge, ...styles.startBadge }}>{m["post_edit.split_start_badge"]()}</span>}
                  {row.isFinish && <span style={{ ...styles.badge, ...styles.finishBadge }}>{m["post_edit.split_finish_badge"]()}</span>}
                </div>
                <div>
                  {(["required", "undefined", "forbidden"] as const).map((category) => {
                    const links = row.links.filter((l) => l.category === category);
                    return (
                      <div key={category} style={styles.linksSection}>
                        <span style={typography.body}>{SECTION_LABEL[category]()}</span>
                        <div style={styles.linksCell}>
                          {links.length === 0 ? (
                            <span style={typography.caption}>{m["post_edit.split_section_empty"]()}</span>
                          ) : (
                            links.map((link, i) => (
                              <span key={i} style={styles.bubble}>{row.ownLabel} {link.arrow} {link.otherLabel}</span>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <Inline gap="itemGap">
              <button className="hoverable-accent" style={{ ...buttonStyle("primary"), flex: 1 }} onClick={onAdd}>
                {m["post_edit.split_add_node"]()}
              </button>
              <button
                className="hoverable-danger"
                style={{ ...buttonStyle("destructive"), flex: 1, ...(!activeRow?.removable ? sharedStyles.btnDisabled : {}) }}
                disabled={!activeRow?.removable}
                onClick={() => activeRow && setPendingRemove(activeRow)}
              >
                {m["post_edit.split_remove"]()}
              </button>
            </Inline>
            {activeRow && (
              <Inline gap="itemGap">
                <button
                  className={activeRow.isStart ? "hoverable-accent" : "hoverable"}
                  style={{ ...buttonStyle(activeRow.isStart ? "toggle-active" : "toggle"), flex: 1 }}
                  onClick={onToggleStart}
                >
                  {activeRow.isStart ? m["post_edit.split_clear_start"]() : m["post_edit.split_set_start"]()}
                </button>
                <button
                  className={activeRow.isFinish ? "hoverable-accent" : "hoverable"}
                  style={{ ...buttonStyle(activeRow.isFinish ? "toggle-active" : "toggle"), flex: 1 }}
                  onClick={onToggleFinish}
                >
                  {activeRow.isFinish ? m["post_edit.split_clear_finish"]() : m["post_edit.split_set_finish"]()}
                </button>
              </Inline>
            )}
          </Stack>
        </div>
      </div>
    } />
    {pendingRemove !== null && (
      <ConfirmModal
        message={m["post_edit.confirm_remove_split_node"]()}
        onConfirm={() => { onRemove(pendingRemove); setPendingRemove(null); }}
        onCancel={() => setPendingRemove(null)}
      />
    )}
    </>
  );
}

/** Shared with `AbstractPatternEditorDialog` (GitHub issue #222) — that editor builds its own
 *  tile+card layout (no `NodeId`/start/finish/link-section concept to reuse this whole component
 *  for), but borrows this subset of styling so the two dialogs read as visually one family. */
export const dialogPanelStyles: Record<string, React.CSSProperties> = {
  split: {
    flex: 1,
    display: "flex",
    flexDirection: "row",
    minHeight: 0,
  },
  // `minHeight: 0` is required, not cosmetic — without it, a flex item's default `min-height:
  // auto` keeps `left` sized to its content's min-content height (buttons + tile's own intrinsic
  // size) instead of stretching to `split`'s full height, so `TileFaceEditor`'s `flex: 1` wrap
  // below has no extra height to grow into and the diagram renders tiny.
  left: {
    flex: "1 1 38%",
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
    padding: spacing.sectionGap,
    borderRight: `1px solid ${ui.border.default}`,
    minWidth: 0,
    minHeight: 0,
  },
  right: {
    flex: "1 1 62%",
    display: "flex",
    flexDirection: "column",
    padding: spacing.groupGap,
    minWidth: 0,
    overflowY: "auto",
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
};
