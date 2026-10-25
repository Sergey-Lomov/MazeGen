import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Copy, X } from "lucide-react";
import { useLocale } from "../../i18n/useLocale";
import { useMazeStore } from "../../store/mazeStore";
import { notificationMessage } from "../../notifications/notificationRegistry";
import {
  ERROR_VISIBLE_CARDS,
  closeAllErrors,
  closeAllNotices,
  closeErrorCard,
  closeNotice,
  noticeActiveNow,
  setNoticeZonePaused,
  useNotificationStore,
  type ErrorCard,
  type NoticeItem,
} from "../../notifications/notificationStore";
import { embeddedNotificationStyle, notificationPalette, type NotificationSeverity } from "../EmbeddedNotification";
import { overlay, radius, spacing, typography } from "../../styles/theme";
import { Tooltip } from "../Tooltip";
import * as m from "~/paraglide/messages";

export const NOTIFICATION_ZONE_OFFSET = 16;
/** Fixed zone width — toasts never resize when a longer one appears; long text wraps instead. */
export const NOTIFICATION_ZONE_WIDTH = 360;
/** Above `Modal` (`overlay.zIndex`) — a refusal can happen inside a dialog. */
export const NOTIFICATION_Z_INDEX = overlay.zIndex + 1;

/** Keeps `el` the last child of `body`, so the toast layer also follows any modal portal in DOM
 *  order (modals append their own portal nodes to `body` when they open). Skipped while focus is
 *  inside `el` — moving a node drops its focus; the z-index keeps the layer on top meanwhile, and
 *  the next `body` mutation re-appends it. */
function useLastBodyChild(el: HTMLElement): void {
  useEffect(() => {
    document.body.appendChild(el);
    const observer = new MutationObserver(() => {
      if (document.body.lastElementChild === el || el.contains(document.activeElement)) return;
      document.body.appendChild(el);
    });
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      el.remove();
    };
  }, [el]);
}

/** Toast channel UI (GitHub issue #767): the `error` zone above the `notice` zone in the canvas's
 *  top-left corner (stacks grow downward), portaled into its own `body`-level container above
 *  modals. Mounted once in `App`. Text is rebuilt from `code + params` on every render, so a locale switch re-translates
 *  visible toasts in place. */
export function NotificationHost({ canvasLeft }: {
  /** Viewport x of the canvas column's left edge — the zones sit `NOTIFICATION_ZONE_OFFSET` from it. */
  canvasLeft: number;
}) {
  useLocale();
  const [container] = useState(() => {
    const el = document.createElement("div");
    el.dataset.testid = "notification-host";
    return el;
  });
  useLastBodyChild(container);
  const notices = useNotificationStore((s) => s.notices);
  const queuedCount = useNotificationStore((s) => s.queue.length);
  const errors = useNotificationStore((s) => s.errors);

  return createPortal(
    <div
      style={{
        ...styles.root,
        left: canvasLeft + NOTIFICATION_ZONE_OFFSET,
        // Narrow windows: shrink to stay inside the viewport instead of overflowing it.
        maxWidth: `calc(100vw - ${canvasLeft + 2 * NOTIFICATION_ZONE_OFFSET}px)`,
      }}
    >
      {errors.length > 0 && <ErrorZone cards={errors} />}
      {notices.length > 0 && <NoticeZone notices={notices} queuedCount={queuedCount} />}
    </div>,
    container,
  );
}

function NoticeZone({ notices, queuedCount }: { notices: NoticeItem[]; queuedCount: number }) {
  const paused = useNotificationStore((s) => s.noticesPaused);
  // The zone unmounts as soon as it empties — possibly under the pointer, with no `mouseleave` —
  // so resume the timers on unmount too.
  useEffect(() => () => setNoticeZonePaused(false), []);
  return (
    <section
      aria-label={m["notifications.notice_zone"]()}
      data-testid="notice-zone"
      style={styles.zone}
      onMouseEnter={() => setNoticeZonePaused(true)}
      onMouseLeave={() => setNoticeZonePaused(false)}
    >
      {notices.map((n) => (
        <div key={n.id} data-testid="notice-toast" style={{ ...styles.toast, ...paletteStyle("warning") }}>
          <span style={styles.message}>{notificationMessage(n.code, n.params)}</span>
          <CloseButton onClick={() => closeNotice(n.id)} />
          <CountdownBar key={n.expiresAt} notice={n} paused={paused} />
        </div>
      ))}
      {notices.length + queuedCount >= 2 && <CloseAllButton severity="warning" onClick={closeAllNotices} />}
    </section>
  );
}

function ErrorZone({ cards }: { cards: ErrorCard[] }) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = expanded ? 0 : Math.max(0, cards.length - ERROR_VISIBLE_CARDS);
  const shown = hiddenCount > 0 ? cards.slice(hiddenCount) : cards;
  useEffect(() => {
    if (cards.length <= ERROR_VISIBLE_CARDS) setExpanded(false);
  }, [cards.length]);
  return (
    <section aria-label={m["notifications.error_zone"]()} data-testid="error-zone" style={styles.zone}>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="hoverable"
          data-testid="more-errors"
          aria-expanded={false}
          style={{ ...styles.moreRow, ...paletteStyle("critical") }}
          onClick={() => setExpanded(true)}
        >
          {hiddenCount === 1
            ? m["notifications.more_errors"]({ count: hiddenCount })
            : m["notifications.more_errors_plural"]({ count: hiddenCount })}
        </button>
      )}
      {shown.map((card) => <ErrorCardView key={card.key} card={card} severity="critical" />)}
      {cards.length >= 2 && <CloseAllButton severity="critical" onClick={closeAllErrors} />}
    </section>
  );
}

function ErrorCardView({ card, severity }: { card: ErrorCard; severity: NotificationSeverity }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const latest = card.occurrences[card.occurrences.length - 1];
  const count = card.occurrences.length;
  const headline = notificationMessage(card.code, latest.params);
  // Newest first. An occurrence's message is shown only when it differs from the headline, so
  // expanding adds the technical details under the card instead of repeating its own text.
  const entries = [...card.occurrences].reverse().map((o) => {
    const message = notificationMessage(card.code, o.params);
    return { id: o.id, message, ownMessage: message !== headline ? message : null, details: o.details };
  });
  const copyText = entries.map((e) => e.details ? `${e.message}\n${e.details}` : e.message).join("\n\n");
  const expandable = entries.some((e) => e.details || e.ownMessage);
  return (
    <div data-testid="error-card" style={{ ...styles.toast, ...paletteStyle(severity), flexDirection: "column", alignItems: "stretch" }}>
      <div style={styles.cardHeader}>
        <span style={styles.message}>{headline}</span>
        {count > 1 && <span data-testid="error-count" style={styles.counter}>×{count}</span>}
        <CloseButton onClick={() => closeErrorCard(card.key)} />
      </div>
      {card.source === "generation" && card.code === "generation.registry_load_failed" && (
        <RegistryRetryButton cardKey={card.key} />
      )}
      {expandable && (
        <div style={styles.detailsSection}>
          <div style={styles.detailsHeader}>
            <button
              type="button"
              className="hoverable"
              aria-expanded={detailsOpen}
              style={styles.disclosureBtn}
              onClick={() => setDetailsOpen((v) => !v)}
            >
              {detailsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              {m["notifications.details"]()}
            </button>
            {detailsOpen && <span style={styles.detailsCopy}><CopyButton text={copyText} /></span>}
          </div>
          {detailsOpen && (
            <ul data-testid="error-details" style={{ ...styles.details, ...toastScrollbarStyle(severity) }}>
              {entries.map((e, i) => (
                <li key={e.id} style={i > 0 ? { ...styles.occurrence, ...styles.occurrenceSeparated } : styles.occurrence}>
                  <div style={styles.occurrenceText}>
                    {e.ownMessage && <span style={styles.message}>{e.ownMessage}</span>}
                    {e.details && <pre style={styles.detailsText}>{e.details}</pre>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function RegistryRetryButton({ cardKey }: { cardKey: string }) {
  const loadRegistry = useMazeStore((s) => s.loadRegistry);
  const [pending, setPending] = useState(false);

  function retry() {
    if (pending) return;
    setPending(true);
    void loadRegistry().finally(() => {
      if (useMazeStore.getState().registryError === null) closeErrorCard(cardKey);
      setPending(false);
    });
  }

  return (
    <button type="button" className="hoverable" style={styles.retryButton} disabled={pending} onClick={retry}>
      {pending ? m["common.loading"]() : m["generation.retry_registry_load"]()}
    </button>
  );
}

const COPY_CONFIRM_MS = 1500;

/** Icon-only copy button; shows a check mark for a moment after a successful copy. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = m["notifications.copy"]();
  return (
    <Tooltip content={label}><button
      type="button"
      className="hoverable"
      style={styles.iconBtn}
      aria-label={label}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {}); }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button></Tooltip>
  );
}

/** Shrinking line along the toast's bottom edge: time left until the notice disappears. Driven by a
 *  CSS animation from the remaining fraction to zero over the remaining active time, both frozen at
 *  mount (later re-renders must not restart it); the parent keys it by `expiresAt`, so a repeat
 *  remounts it with a fresh timer. Pauses together with the zone's active clock. */
function CountdownBar({ notice, paused }: { notice: NoticeItem; paused: boolean }) {
  const [{ remaining, fraction }] = useState(() => {
    const total = notice.expiresAt! - notice.timerStart!;
    const left = Math.max(0, notice.expiresAt! - noticeActiveNow());
    return { remaining: left, fraction: total > 0 ? left / total : 0 };
  });
  return (
    <div
      data-testid="notice-countdown"
      aria-hidden="true"
      style={{
        ...styles.countdown,
        background: "currentColor",
        transform: `scaleX(${fraction})`,
        animationName: "notice-countdown",
        animationDuration: `${remaining}ms`,
        animationTimingFunction: "linear",
        animationFillMode: "forwards",
        animationPlayState: paused ? "paused" : "running",
        ["--countdown-from" as string]: fraction,
      }}
    />
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content={m["notifications.close"]()}><button
      type="button"
      className="hoverable"
      aria-label={m["notifications.close"]()}
      style={styles.iconBtn}
      onClick={onClick}
    >
      <X size={14} />
    </button></Tooltip>
  );
}

function CloseAllButton({ severity, onClick }: { severity: "warning" | "critical"; onClick: () => void }) {
  return (
    <div style={styles.zoneHeader}>
      <button type="button" className="hoverable" style={{ ...styles.closeAll, ...paletteStyle(severity) }} onClick={onClick}>
        {m["notifications.close_all"]()}
      </button>
    </div>
  );
}

/** Same pairing as `WarningBubble`: dark palette background, light palette text and border.
 *  Everything inside a toast inherits the text color — no colors of its own. */
function paletteStyle(severity: NotificationSeverity): React.CSSProperties {
  const { bg, text } = notificationPalette(severity);
  return { background: bg, color: text, borderColor: text };
}

function toastScrollbarStyle(severity: NotificationSeverity): React.CSSProperties {
  const { bg, text } = notificationPalette(severity);
  return {
    scrollbarColor: `${text} ${bg}`,
  };
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed",
    top: NOTIFICATION_ZONE_OFFSET,
    width: NOTIFICATION_ZONE_WIDTH,
    zIndex: NOTIFICATION_Z_INDEX,
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: spacing.groupGap,
    pointerEvents: "none",
  },
  zone: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.itemGap,
    pointerEvents: "auto",
  },
  zoneHeader: {
    display: "flex",
    justifyContent: "flex-end",
  },
  toast: {
    ...embeddedNotificationStyle,
    position: "relative",
    overflow: "hidden",
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.rowGap,
  },
  countdown: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    transformOrigin: "left center",
    opacity: 0.7,
    pointerEvents: "none",
  },
  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.rowGap,
  },
  message: {
    flex: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  counter: {
    ...typography.caption,
    color: "inherit",
    flexShrink: 0,
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "inherit",
    cursor: "default",
    padding: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    borderRadius: radius.sm,
  },
  disclosureBtn: {
    ...typography.caption,
    background: "none",
    border: "none",
    cursor: "default",
    padding: "0 2px 0 0",
    borderRadius: radius.sm,
    color: "inherit",
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
  },
  detailsSection: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
  },
  detailsHeader: {
    display: "flex",
    alignItems: "center",
    gap: spacing.elementsGap,
  },
  detailsCopy: {
    marginLeft: "auto",
    display: "flex",
  },
  retryButton: {
    ...typography.caption,
    alignSelf: "flex-start",
    background: "none",
    border: "1px solid currentColor",
    borderRadius: radius.sm,
    color: "inherit",
    cursor: "default",
    padding: "2px 6px",
  },
  closeAll: {
    ...embeddedNotificationStyle,
    cursor: "default",
  },
  moreRow: {
    ...embeddedNotificationStyle,
    cursor: "default",
    textAlign: "left",
  },
  details: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: spacing.groupGap,
    maxHeight: 48,
    overflowY: "auto",
  },
  occurrence: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.rowGap,
  },
  occurrenceSeparated: {
    borderTop: "1px solid currentColor",
    paddingTop: spacing.itemGap,
  },
  occurrenceText: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
  },
  detailsText: {
    ...typography.caption,
    lineHeight: "16px",
    color: "inherit",
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
};
