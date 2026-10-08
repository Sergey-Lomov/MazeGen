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
export const SIDE_PANEL_DIAGNOSTICS_STORAGE_KEY = "maze.debug.sidePanelHitTesting";

function sidePanelDiagnosticsEnabled(): boolean {
  if (new URLSearchParams(window.location.search).get("debugSidePanel") === "1") return true;
  try {
    return window.localStorage.getItem(SIDE_PANEL_DIAGNOSTICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function describeRect(rect: DOMRect | undefined) {
  if (!rect) return null;
  return {
    left: Math.round(rect.left * 100) / 100,
    top: Math.round(rect.top * 100) / 100,
    right: Math.round(rect.right * 100) / 100,
    bottom: Math.round(rect.bottom * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
  };
}

function describeElement(element: Element | null) {
  if (!element) return null;
  const htmlElement = element as HTMLElement;
  const style = window.getComputedStyle(element);
  return {
    node: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className: typeof element.className === "string" ? element.className || undefined : undefined,
    role: element.getAttribute("role") || undefined,
    ariaLabel: element.getAttribute("aria-label") || undefined,
    title: element.getAttribute("title") || undefined,
    testId: element.getAttribute("data-testid") || undefined,
    rect: describeRect(htmlElement.getBoundingClientRect()),
    pointerEvents: style.pointerEvents,
    position: style.position,
    zIndex: style.zIndex,
    display: style.display,
    visibility: style.visibility,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
  };
}

function pointFromEvent(event: Event): { x: number; y: number } | null {
  if (!("clientX" in event) || !("clientY" in event)) return null;
  const x = Number((event as MouseEvent).clientX);
  const y = Number((event as MouseEvent).clientY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

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
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

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

  // Opera can deliver a mouseup inside the panel without delivering the corresponding
  // pointerdown/mousedown (GitHub issue #679). Native buttons normally synthesize click only from
  // a complete press sequence, so the action silently disappears. Remember down events globally
  // to avoid treating a genuine drag/release that started elsewhere as a click; when both down
  // events are missing, replay the browser's own click on the element that received mouseup.
  useEffect(() => {
    if (!isTop) return;
    const panel = panelRef.current;
    if (!panel) return;

    let downSeen = false;
    let clickSeen = false;
    let sequence = 0;
    let downPoint: { x: number; y: number } | null = null;
    let downTarget: Element | null = null;
    const clickableSelector = "button, [role=button], [data-side-panel-clickable]";

    const markDown = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      if (mouseEvent.button !== 0) return;
      downSeen = true;
      clickSeen = false;
      sequence += 1;
      downPoint = pointFromEvent(event);
      downTarget = event.target instanceof Element ? event.target : null;
      if (sidePanelDiagnosticsEnabled()) {
        const hit = downPoint ? document.elementFromPoint(downPoint.x, downPoint.y) : null;
        console.log(`[SidePanel #679 ${title}] window-capture:${event.type}\n${JSON.stringify({
          point: downPoint,
          target: describeElement(downTarget),
          targetInsidePanel: downTarget ? panel.contains(downTarget) : false,
          elementFromPoint: describeElement(hit),
          hitInsidePanel: hit ? panel.contains(hit) : false,
        }, null, 2)}`);
      }
    };
    const markClick = (event: Event) => {
      if (event.target instanceof Element && panel.contains(event.target)) clickSeen = true;
    };
    const recoverMouseupClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const hadDown = downSeen;
      downSeen = false;
      clickSeen = false;
      downPoint = null;
      downTarget = null;
      // Any page-level down event means this release belongs to a real press or drag. The
      // compatibility path is strictly for Opera's missing-down sequence.
      if (hadDown) return;

      const target = event.target instanceof Element
        ? event.target.closest(clickableSelector)
        : null;
      const clickable = target instanceof HTMLElement
        && panel.contains(target)
        && !target.matches(":disabled, [aria-disabled='true']")
        ? target
        : null;
      if (!clickable) return;
      const recoverySequence = ++sequence;

      window.setTimeout(() => {
        if (recoverySequence !== sequence || clickSeen || !clickable.isConnected) return;
        if (sidePanelDiagnosticsEnabled()) {
          console.log(`[SidePanel #679 ${title}] recovered click after missing pointerdown`, {
            target: describeElement(clickable),
            x: event.clientX,
            y: event.clientY,
          });
        }
        // `.click()` runs after mouseup and therefore cannot activate the browser's `:active`
        // state. Keep the same pressed visual for one short frame so Opera's recovered click
        // feels like a normal press instead of changing selection without feedback.
        clickable.setAttribute("data-side-panel-recovered-press", "true");
        window.setTimeout(() => clickable.removeAttribute("data-side-panel-recovered-press"), 120);
        clickable.click();
      }, 0);
    };

    window.addEventListener("pointerdown", markDown, true);
    window.addEventListener("mousedown", markDown, true);
    window.addEventListener("click", markClick, true);
    window.addEventListener("mouseup", recoverMouseupClick, true);
    return () => {
      window.removeEventListener("pointerdown", markDown, true);
      window.removeEventListener("mousedown", markDown, true);
      window.removeEventListener("click", markClick, true);
      window.removeEventListener("mouseup", recoverMouseupClick, true);
    };
  }, [isTop, title]);

  // Optional hit-testing diagnostics for GitHub issue #679. The document capture listener is
  // intentional: if it stops reporting while the pointer is visibly inside the panel, the
  // browser failed before React (and even the panel DOM) could receive the event.
  useEffect(() => {
    if (!isTop || !sidePanelDiagnosticsEnabled()) return;
    const panel = panelRef.current;
    const header = headerRef.current;
    const body = bodyRef.current;
    if (!panel || !header || !body) return;

    const prefix = `[SidePanel #679 ${title}]`;
    const describePoint = (point: { x: number; y: number } | null) => {
      if (!point) return null;
      let hit: Element | null = null;
      let hits: Element[] = [];
      try {
        hit = document.elementFromPoint(point.x, point.y);
        hits = document.elementsFromPoint?.(point.x, point.y) ?? [];
      } catch {
        // Some browsers can reject coordinates outside the current viewport.
      }
      return {
        x: point.x,
        y: point.y,
        elementFromPoint: describeElement(hit),
        elementsFromPoint: hits.slice(0, 3).map(describeElement),
      };
    };
    const logSnapshot = (reason: string, point: { x: number; y: number } | null = null) => {
      const bodyRect = body.getBoundingClientRect();
      const firstChild = body.firstElementChild;
      const snapshot = {
        point: describePoint(point),
        panel: describeElement(panel),
        header: describeElement(header),
        body: describeElement(body),
        firstChild: describeElement(firstChild),
        bodyDirectChildren: Array.from(body.children).slice(0, 4).map(describeElement),
        boundarySamples: [-4, -1, 0, 1, 4, 16].map((offset) => {
          const sample = { x: bodyRect.left + Math.min(bodyRect.width / 2, 8), y: bodyRect.top + offset };
          return { offset, ...describePoint(sample) };
        }),
      };
      // Print JSON rather than a live object so DevTools cannot hide the useful nested fields
      // behind a collapsed object preview when this bug is reproduced.
      console.log(`${prefix} ${reason}\n${JSON.stringify(snapshot, null, 2)}`);
    };
    const logEvent = (reason: string, event: Event) => {
      const point = pointFromEvent(event);
      const mouseEvent = event as MouseEvent;
      const hit = point && typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(point.x, point.y)
        : null;
      const compact = {
        type: event.type,
        timeStamp: Math.round(event.timeStamp * 100) / 100,
        point,
        target: describeElement(event.target as Element | null),
        elementFromPoint: describeElement(hit),
        button: mouseEvent.button,
        buttons: mouseEvent.buttons,
        detail: mouseEvent.detail,
        pointerType: "pointerType" in event ? (event as PointerEvent).pointerType : undefined,
        pointerId: "pointerId" in event ? (event as PointerEvent).pointerId : undefined,
        defaultPrevented: event.defaultPrevented,
        cancelBubble: event.cancelBubble,
      };
      console.log(`${prefix} ${reason} ${JSON.stringify(compact)}`);
    };

    logSnapshot("mounted");
    const frame = window.requestAnimationFrame(() => logSnapshot("after-animation-frame"));
    let lastMoveLog = 0;
    const isInsidePanel = (point: { x: number; y: number } | null) => {
      if (!point) return false;
      const rect = panel.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    };
    const handleWindowEvent = (event: Event) => {
      const point = pointFromEvent(event);
      if (!isInsidePanel(point)) return;
      logEvent(`window-capture:${event.type}`, event);
    };
    const handleDocumentEvent = (event: Event) => {
      const point = pointFromEvent(event);
      if (!isInsidePanel(point)) return;
      logEvent(`document-capture:${event.type}`, event);
    };
    const handlePointerMove = (event: Event) => {
      const point = pointFromEvent(event);
      const bodyTop = body.getBoundingClientRect().top;
      if (!point || Math.abs(point.y - bodyTop) > 32 || Date.now() - lastMoveLog < 100) return;
      lastMoveLog = Date.now();
      logEvent("document-capture:pointermove-near-body-top", event);
    };
    const handleResize = () => logSnapshot("window-resize");
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "pointercancel", "click"];
    for (const type of eventTypes) {
      window.addEventListener(type, handleWindowEvent, true);
      document.addEventListener(type, handleDocumentEvent, true);
    }
    document.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(frame);
      for (const type of eventTypes) {
        window.removeEventListener(type, handleWindowEvent, true);
        document.removeEventListener(type, handleDocumentEvent, true);
      }
      document.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [isTop, title]);

  const showWarnings = !warningsDismissed && !!warnings && warnings.length > 0;

  const slot = document.getElementById(SIDE_PANEL_SLOT_ID);
  if (!slot) return null;

  return createPortal(
    <div
      ref={panelRef}
      data-side-panel="true"
      data-side-panel-title={title}
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
      <div ref={headerRef} data-side-panel-region="header" style={styles.header}>
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
      <div ref={bodyRef} data-side-panel-region="body" style={styles.body}>
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
    position: "relative",
    zIndex: 1,
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
    position: "relative",
    zIndex: 0,
  },
};
