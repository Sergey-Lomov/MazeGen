import React, { useRef, useState, useSyncExternalStore } from "react";
import { runningActivities, subscribeActivity, type ActivityKind, type ActivitySnapshot } from "../activity/backgroundActivity";
import { IconActionButton } from "./IconActionButton";
import { InfoIconButton } from "./InfoIconButton";
import { Modal } from "./Modal";
import { useDelayedKeys } from "./useDelayedIndicator";
import { ui, typography, radius, spacing } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** How long a process must run before its bubble appears: quick ones finish unnoticed. */
export const INDICATOR_DELAY_MS = 250;
/** How long a shown card stays after its process ends, so it does not blink away. */
export const INDICATOR_MIN_VISIBLE_MS = 1000;

interface ActivityText {
  title: string;
  info: string;
}

const TEXTS: Record<ActivityKind, (labels: readonly string[]) => ActivityText> = {
  fonts: (labels) => ({
    title: labels.length > 0 ? m["activity.fonts_named"]({ fonts: labels.join(", ") }) : m["activity.fonts"](),
    info: m["activity.fonts_info"](),
  }),
  analytics: () => ({ title: m["activity.analytics"](), info: m["activity.analytics_info"]() }),
};

/** Background processes as small cards in the top-right corner of the canvas (GitHub issue #1004): one card per
 *  running kind, each with its name, an info button and an activity strip along its bottom edge. With two or more
 *  cards the stack can be folded into one small card that only counts them, so many processes never cover the
 *  canvas. */
export function BackgroundActivityStack() {
  const running = useSyncExternalStore(subscribeActivity, runningActivities);
  const active = React.useMemo(() => running.map((a) => a.kind), [running]);
  const shownKinds = useDelayedKeys(active, { showDelay: INDICATOR_DELAY_MS, minVisible: INDICATOR_MIN_VISIBLE_MS });
  const [collapsed, setCollapsed] = useState(false);
  const [infoKind, setInfoKind] = useState<{ kind: ActivityKind; text: ActivityText } | null>(null);
  // A card of a process that just ended stays until its minimum time passes, so it is remembered here.
  const lastSeen = useRef(new Map<ActivityKind, ActivitySnapshot>());
  for (const entry of running) lastSeen.current.set(entry.kind, entry);
  const cards = shownKinds.map((kind) => lastSeen.current.get(kind) ?? { kind, labels: [] });

  const folded = collapsed && cards.length > 1;
  // The description dialog is not part of the stack: it stays open after its process ends and the cards go.
  return (
    <>
      {cards.length > 0 && <div style={styles.stack} data-testid="background-activity-stack">
        {folded ? (
          <div
            role="button"
            tabIndex={0}
            className="hoverable"
            style={{ ...styles.card, ...styles.foldedCard }}
            aria-label={m["activity.expand"]({ count: cards.length })}
            title={m["activity.expand"]({ count: cards.length })}
            data-testid="background-activity-folded"
            onClick={() => setCollapsed(false)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed(false); } }}
          >
            <span style={styles.title}>{cards.length}</span>
            <ActivityStrip />
          </div>
        ) : (
          <>
            {cards.map((entry) => {
              const text = TEXTS[entry.kind](entry.labels);
              return (
                <div key={entry.kind} role="status" style={styles.card} data-testid={`background-activity-${entry.kind}`}>
                  <span style={styles.title}>{text.title}</span>
                  <InfoIconButton label={m["activity.info"]()} testId={`background-activity-info-${entry.kind}`} onClick={() => setInfoKind({ kind: entry.kind, text })} />
                  <ActivityStrip />
                </div>
              );
            })}
            {cards.length > 1 && (
              <span style={styles.foldButton}>
                <IconActionButton action="move-up" title={m["activity.collapse"]()} data-testid="background-activity-collapse" onClick={() => setCollapsed(true)} />
              </span>
            )}
          </>
        )}
      </div>}
      {infoKind && (
        <Modal title={infoKind.text.title} onClose={() => setInfoKind(null)}>
          <div style={styles.infoText} data-testid="background-activity-info-text">{infoKind.text.info}</div>
        </Modal>
      )}
    </>
  );
}

function ActivityStrip() {
  return (
    <div style={styles.track} aria-hidden="true">
      <div className="loading-progress-indeterminate" style={styles.bar} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  stack: {
    position: "absolute", right: 12, top: 12, zIndex: 5,
    display: "flex", flexDirection: "column", alignItems: "flex-end", gap: spacing.itemGap,
    pointerEvents: "none",
  },
  card: {
    position: "relative", overflow: "hidden", pointerEvents: "auto",
    display: "flex", alignItems: "flex-start", gap: 8, boxSizing: "border-box",
    width: 240, padding: "6px 8px 9px",
    borderRadius: radius.md, background: ui.bg.input, border: `1px solid ${ui.border.default}`,
  },
  foldedCard: { alignItems: "center", cursor: "default", width: "auto", padding: "4px 10px 8px" },
  title: { ...typography.caption, color: ui.text.secondary, lineHeight: "16px", overflowWrap: "anywhere", flex: 1 },
  track: { position: "absolute", left: 0, right: 0, bottom: 0, height: 3, overflow: "hidden", background: ui.bg.panel },
  bar: { width: "100%", height: "100%", background: ui.accent.base, transformOrigin: "left", transform: "scaleX(0.3)" },
  foldButton: { pointerEvents: "auto", display: "flex" },
  infoText: { ...typography.body, lineHeight: 1.4 },
};
