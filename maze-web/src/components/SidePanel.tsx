import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ui, typography, spacing, inset } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
import { hasOpenModal } from "./Modal";
import type React from "react";

const MIN_PANEL_WIDTH = 360;

/** Module-level mount-order stack (GitHub issue #629) — every live `SidePanel` instance (in either
 *  mode) pushes its own id here on mount and pops it on unmount, regardless of which feature owns
 *  it. Several `SidePanel`s can be mounted at once (e.g. `DebugPanel` and `VertexBasedSettingsPanel`
 *  both live under `openCard === "generation"`, independently toggled) since nothing here stops a
 *  second feature from opening its own panel while another is already up — only the most recently
 *  mounted one is shown (absolutely positioned, filling the slot); the rest stay mounted but hidden
 *  so their own internal state (scroll position, drafts, ...) survives underneath. Unmounting the
 *  top one (closing it) drops it from the stack and the next-most-recent becomes visible again,
 *  without any feature needing to know about another's open/closed state. A plain module array +
 *  listener set rather than a React context: `SidePanel` instances mount across unrelated,
 *  non-nested component trees (portal target aside), so no single context provider could wrap
 *  all of them. */
interface PanelStackEntry {
  id: symbol;
  /** Mirrors this entry's own `overlay` prop — needed so a lower entry can tell whether it's fully
   *  occluded (an in-flow entry stacked on top of it) or merely visually covered (an absolutely
   *  positioned overlay on top of it, which takes no width of its own). */
  overlay: boolean;
}

let panelStack: PanelStackEntry[] = [];
const panelStackListeners = new Set<() => void>();

function notifyPanelStackChange() {
  for (const listener of panelStackListeners) listener();
}

function pushPanel(id: symbol, overlay: boolean) {
  panelStack = [...panelStack, { id, overlay }];
  notifyPanelStackChange();
}

function popPanel(id: symbol) {
  panelStack = panelStack.filter((p) => p.id !== id);
  notifyPanelStackChange();
}

function subscribePanelStack(listener: () => void) {
  panelStackListeners.add(listener);
  return () => { panelStackListeners.delete(listener); };
}

/** True while `id` is the topmost (most recently mounted, still-live) entry in `panelStack`. */
function useIsTopPanel(id: symbol): boolean {
  return useSyncExternalStore(
    subscribePanelStack,
    () => panelStack.length > 0 && panelStack[panelStack.length - 1].id === id,
  );
}

/** True while every entry above `id` on the stack is an overlay (or there is none) — i.e. `id`
 *  should stay in normal flow (still contributing its box/width to the slot) even though it isn't
 *  the topmost entry. An overlay is `position: absolute` and contributes no width of its own
 *  (GitHub issue #629 follow-up): if the entry underneath it also left the flow (`display: none`,
 *  the in-flow-panel-stacked-on-in-flow-panel case), the slot has nothing left to size itself by
 *  and collapses to zero width, taking the overlay's `inset: 0` down with it. Only an in-flow entry
 *  stacked on top should pull a lower entry out of the flow. */
function useKeepsFlowWidth(id: symbol): boolean {
  return useSyncExternalStore(
    subscribePanelStack,
    () => {
      const index = panelStack.findIndex((p) => p.id === id);
      if (index === -1) return true;
      return panelStack.slice(index + 1).every((p) => p.overlay);
    },
  );
}

/** DOM id of `App.tsx`'s slot beside the canvas column — every `SidePanel` portals here
 *  regardless of where in the component tree it's triggered from (GitHub issue #237), so it
 *  always docks next to the canvas rather than wherever its owning feature happens to live in the
 *  left features panel. */
export const SIDE_PANEL_SLOT_ID = "side-panel-slot";

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Diagnostic hints/warnings for the panel's current content — shown in a dismissible strip
   *  under the header, auto-reopened whenever the message set changes (GitHub issue #237). Purely
   *  informational, never blocks any action. */
  warnings?: string[];
  /** Render as a full-cover overlay (`position: absolute; inset: 0`) inside `#side-panel-slot`
   *  instead of a normal in-flow panel — used by `ColorPickerPanel` (GitHub issue #499) to sit on
   *  top of whatever `SidePanel` content is already shown, sized to the slot rather than its own
   *  `width` state. Which panel is actually visible when several are mounted at once (overlay or
   *  not) is decided separately by the shared mount-order stack (GitHub issue #629) — this prop
   *  only picks this panel's own box model, not its stacking. */
  overlay?: boolean;
  /** Notified whenever this instance's topmost status on the shared stack (GitHub issue #629)
   *  changes — including the initial mount, so a caller doesn't need a separate "assume top on
   *  mount" branch. Lets a panel react to being covered by another `SidePanel` (or uncovered again)
   *  without that other panel knowing anything about it: e.g. `ManageSplitNodesDialog` clears its
   *  on-canvas cell outline while covered (the outline would otherwise keep showing for whatever
   *  covered it), `PngExportSettingsPanel` hides its print-frame canvas overlay the same way. Called
   *  from a `useEffect` (after paint), not the `useLayoutEffect` the stack itself updates on — a
   *  caller's reaction here (e.g. a store write) is ordinary app state, not layout. */
  onTopChange?: (isTop: boolean) => void;
  children: React.ReactNode;
}

/** Generic resizable side panel (GitHub issue #237): docked to the canvas's right edge,
 *  drag-to-resize handle on its left edge, header with title/close. Used by the split-node
 *  management panels (post-edit, preset, pattern editor) and `DebugPanel` (GitHub issue #607) so
 *  editing a node's connections reads as directly manipulating the canvas rather than a modal
 *  dialog floating over it — every click's effect on the maze is visible immediately behind the
 *  panel.
 *
 *  Independent features may each keep their own panel mounted at once (e.g. `DebugPanel` and
 *  `VertexBasedSettingsPanel` under the generation card, or the post-edit "Changes" panel and
 *  "Manage split nodes" panel) with no coordination between them — every mounted instance shares
 *  one module-level stack (GitHub issue #629) keyed by mount order, and only the most recently
 *  mounted one is actually shown. Closing it unmounts that instance and pops it off the stack, so
 *  the next one down becomes visible again — restoring what was underneath rather than clearing
 *  the whole slot. */
export function SidePanel({ title, subtitle, onClose, warnings, overlay, onTopChange, children }: Props) {
  const [width, setWidth] = useState(MIN_PANEL_WIDTH);
  const resizing = useRef(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  // Register this instance on the shared mount-order stack for the panel's whole lifetime (GitHub
  // issue #629) — a stable id (not `useId`, which isn't guaranteed unique across independently
  // portal-mounted trees the way a fresh `Symbol` is) survives whatever the caller's own open-state
  // does, so a re-render doesn't create a new stack entry. The id itself is still allocated eagerly
  // during render (guarded by `panelIdRef.current === null`, so a re-render never allocates twice),
  // but push/pop both happen in a `useLayoutEffect` rather than splitting push into render and pop
  // into a cleanup effect — under `StrictMode`, React mounts a component's effects, immediately
  // cleans them up, then mounts them again, without re-running render in between (the ref guard
  // means a second render never re-pushes). A render-time push paired with only an effect-time pop
  // desyncs on that extra cycle: the first pop removes the id from `panelStack` but nothing ever
  // pushes it back, so the panel is stuck reading as non-top (hidden) even though it's the only
  // mounted instance — this was GitHub issue #629's actual regression, right after the stacking fix
  // for it landed. `useLayoutEffect` mounts/cleans up in the same symmetric pairs React runs for any
  // other effect, so a `StrictMode` push-pop-push cycle nets out to the same single push. It still
  // avoids the no-flash regression the render-time push was originally for: layout effects for a
  // whole commit all run (in mount order) before the browser paints, so when two `SidePanel`s mount
  // in the same commit, the second one's layout-effect push happens before paint, and the
  // `useSyncExternalStore` notification it fires re-renders both synchronously within that same
  // pre-paint window — there's still no frame where neither is visible.
  const panelIdRef = useRef<symbol | null>(null);
  if (panelIdRef.current === null) {
    panelIdRef.current = Symbol("side-panel");
  }
  const panelId = panelIdRef.current;
  useLayoutEffect(() => {
    pushPanel(panelId, !!overlay);
    return () => popPanel(panelId);
  }, [panelId, overlay]);
  const isTop = useIsTopPanel(panelId);
  // Whether this instance should stay in normal flow (contributing its box/width to the slot) even
  // when it isn't the topmost entry — see `useKeepsFlowWidth`. Irrelevant for an overlay instance
  // itself (it's always `position: absolute`, contributing no width either way).
  const keepsFlowWidth = useKeepsFlowWidth(panelId);

  const onTopChangeRef = useRef(onTopChange);
  onTopChangeRef.current = onTopChange;
  useEffect(() => {
    onTopChangeRef.current?.(isTop);
  }, [isTop]);

  // Escape closes this panel only when it's the topmost SidePanel and no Modal dialog is open on
  // top of it (GitHub issue #631) — a dialog's own Escape handler (Modal.tsx) must take precedence.
  // `defaultPrevented` also lets content nested inside this panel (e.g. `ColorPickerPanel`, itself
  // an overlay `SidePanel`) claim Escape for its own narrower cancel behavior instead of double-
  // firing this panel's `onClose` too — React's `stopPropagation` alone wouldn't reach this native
  // `window` listener, since it isn't part of React's synthetic event tree.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!isTop) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      if (hasOpenModal()) return;
      onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isTop]);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!resizing.current) return;
      setWidth((w) => Math.max(MIN_PANEL_WIDTH, w - e.movementX));
    }
    function handleMouseUp() {
      resizing.current = false;
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Re-open the strip whenever the actual set of warnings changes — a dismissal only ever
  // suppresses the current list, not future diagnostics.
  useEffect(() => { setWarningsDismissed(false); }, [warnings?.join("\n")]);

  const showWarnings = !warningsDismissed && !!warnings && warnings.length > 0;

  const slot = document.getElementById(SIDE_PANEL_SLOT_ID);
  if (!slot) return null;

  return createPortal(
    <div
      style={overlay
        ? { ...styles.panel, ...styles.panelOverlay, ...(isTop ? {} : styles.panelHidden) }
        // A non-overlay panel below the top one still needs `display: none` to drop out of the
        // slot's layout when another *in-flow* panel is stacked on it (`keepsFlowWidth` false) —
        // but not when only overlays sit above it, since those take no width of their own and the
        // slot needs this panel's `width` to stay sized (GitHub issue #629 follow-up).
        : { ...styles.panel, width, minWidth: MIN_PANEL_WIDTH, ...(isTop || keepsFlowWidth ? {} : styles.panelHidden), ...(isTop ? {} : styles.panelOccluded) }}
    >
      {/* Overlay mode stretches to fill the slot (`panelOverlay`), so there is no width to drag. */}
      {!overlay && (
        <div
          style={styles.resizeHandle}
          onMouseDown={(e) => { e.preventDefault(); resizing.current = true; }}
        />
      )}
      <div style={styles.header}>
        <div style={styles.headerText}>
          <span style={typography.title}>{title}</span>
          {subtitle && <span style={styles.subtitle}>{subtitle}</span>}
        </div>
        <button className="hoverable" style={sharedStyles.closeBtn} onClick={onClose}><X size={16} /></button>
      </div>
      {showWarnings && (
        <div style={styles.warningsStrip}>
          <div style={styles.warningsList}>
            {warnings.map((w, i) => (
              <div key={i} style={styles.warningItem}>{w}</div>
            ))}
          </div>
          <button className="hoverable" style={sharedStyles.closeBtn} onClick={() => setWarningsDismissed(true)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div style={styles.body}>
        {children}
      </div>
    </div>,
    slot,
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    height: "100%",
    background: ui.bg.panel,
    borderLeft: `1px solid ${ui.border.default}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flexShrink: 0,
    position: "relative",
  },
  // Not the topmost entry on `panelStack` (GitHub issue #629) — stays mounted (its own internal
  // state, e.g. scroll position or a draft, survives underneath) but contributes nothing to layout
  // or paint: `display: none` rather than `visibility: hidden`/`opacity: 0` so a hidden non-overlay
  // panel doesn't keep pushing the canvas narrower via its own `width`.
  panelHidden: {
    display: "none",
  },
  // Underneath an overlay (GitHub issue #629 follow-up) — stays in flow (still sizes the slot via
  // its own `width`, unlike `panelHidden`) but must not paint over or intercept input for the
  // overlay covering it. `visibility: hidden` rather than `display: none` for exactly that reason;
  // unlike `panelHidden`'s opacity-0/visibility-hidden avoidance, this element's width is the whole
  // point, so `display: none` isn't an option here.
  panelOccluded: {
    visibility: "hidden",
  },
  // Overlay mode: fully cover the slot's currently-shown panel rather than dock beside it. The
  // slot (`App.tsx`) is `position: relative` so `inset: 0` resolves against it. `left: 0` as well
  // as `right: 0` so a narrower overlay can't leave the covered panel peeking on its left edge;
  // `width` is then only a lower bound the flex layout already satisfies.
  panelOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: 2,
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -3,
    width: 6,
    cursor: "ew-resize",
    zIndex: 1,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.groupGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    background: ui.bg.panelAlt,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  subtitle: {
    ...typography.caption,
  },
  warningsStrip: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.itemGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    background: notificationPalette("warning").bg,
    flexShrink: 0,
  },
  warningsList: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    minWidth: 0,
  },
  warningItem: {
    ...embeddedNotificationStyle,
    background: "transparent",
    borderWidth: 0,
    padding: 0,
    color: notificationPalette("warning").text,
  },
  body: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
  },
};
