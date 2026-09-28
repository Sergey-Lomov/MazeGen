import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ui, typography, spacing, inset } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { embeddedNotificationStyle, notificationPalette } from "./EmbeddedNotification";
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
let panelStack: symbol[] = [];
const panelStackListeners = new Set<() => void>();

function notifyPanelStackChange() {
  for (const listener of panelStackListeners) listener();
}

function pushPanel(id: symbol) {
  panelStack = [...panelStack, id];
  notifyPanelStackChange();
}

function popPanel(id: symbol) {
  panelStack = panelStack.filter((p) => p !== id);
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
    () => panelStack.length > 0 && panelStack[panelStack.length - 1] === id,
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
export function SidePanel({ title, subtitle, onClose, warnings, overlay, children }: Props) {
  const [width, setWidth] = useState(MIN_PANEL_WIDTH);
  const resizing = useRef(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  // Register this instance on the shared mount-order stack for the panel's whole lifetime (GitHub
  // issue #629) — a stable id (not `useId`, which isn't guaranteed unique across independently
  // portal-mounted trees the way a fresh `Symbol` is) survives whatever the caller's own open-state
  // does, so a re-render doesn't create a new stack entry. Pushed eagerly during render (guarded by
  // `panelIdRef.current === null`, so a re-render never pushes twice — the ref, not module state,
  // is what makes this idempotent per instance) rather than in a `useEffect`: when two `SidePanel`s
  // mount in the same
  // commit (e.g. `DebugPanel` and `VertexBasedSettingsPanel` opening together), waiting for effects
  // would have both read `panelStack` as empty on that first render and paint with neither one
  // visible for a frame — pushing during render makes the second one's very first paint already see
  // the first one on the stack. `popPanel` still only happens in the matching cleanup effect, since
  // unmounting has no earlier hook to run it from.
  const panelIdRef = useRef<symbol | null>(null);
  if (panelIdRef.current === null) {
    panelIdRef.current = Symbol("side-panel");
    pushPanel(panelIdRef.current);
  }
  const panelId = panelIdRef.current;
  useEffect(() => {
    return () => popPanel(panelId);
  }, [panelId]);
  const isTop = useIsTopPanel(panelId);

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
        : { ...styles.panel, width, minWidth: MIN_PANEL_WIDTH, ...(isTop ? {} : styles.panelHidden) }}
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
