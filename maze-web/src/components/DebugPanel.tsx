import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMazeStore } from "../store/mazeStore";
import { ui, radius, typography, muted, inset, spacing } from "../styles/theme";
import { sharedStyles } from "../styles/shared";
import { StepSlider } from "./StepSlider";
import { DebugEventTree } from "./DebugEventTree";
import { ToggleRow } from "./ToggleRow";
import * as m from "~/paraglide/messages";
import type { EventedEventKind } from "../wasm/mazeService";

const MIN_PANEL_WIDTH = 320;

/** Maps a debug-value name (GitHub issue #131, e.g. `"recursion_stack"`) to its i18n label. Not
 *  auto-derived from the name — a runtime string can't be turned into a paraglide message key —
 *  so each known name gets an explicit entry here. A name without one (a future algorithm's debug
 *  value the message catalog hasn't caught up with yet) falls back to the raw name, so an
 *  untranslated toggle still renders instead of crashing. */
const DEBUG_VALUE_LABELS: Record<string, () => string> = {
  recursion_stack: () => m["debug.value.recursion_stack"](),
  visited: () => m["debug.value.visited"](),
  current_walk: () => m["debug.value.current_walk"](),
  walk_start: () => m["debug.value.walk_start"](),
  walk_head: () => m["debug.value.walk_head"](),
  active: () => m["debug.value.active"](),
  frontier: () => m["debug.value.frontier"](),
  reserve: () => m["debug.value.reserve"](),
};

/** `name` may be qualified with a `"{scopeName}:"` prefix (`maze_core::generation::
 *  qualify_debug_value_names`, GitHub issue #147 — applied once more than one source scope is
 *  present, e.g. generation + QC) — `DEBUG_VALUE_LABELS` is keyed by each algorithm's own
 *  unqualified name, so the prefix (if any) is stripped before lookup, not carried into the i18n
 *  key match.
 *
 *  `"visited"` is declared independently by four algorithms (RB, Wilson, CustomEdgeBased,
 *  CustomVertexBased — see `Specs/event_log.md`) with the same wire name but a different meaning
 *  for RB specifically: RB's `"visited"` is every node the DFS has ever stepped onto (monotonic,
 *  including ones it later backtracked past), which reads more naturally as "Visited" than the
 *  shared generic "Completed" label the other three algorithms use — `algorithmKind` disambiguates
 *  which wording applies without needing a second wire name. */
function debugValueLabel(name: string, algorithmKind: EventedEventKind): string {
  const unqualified = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  if (unqualified === "visited" && algorithmKind === "recursive_backtracker") {
    return m["debug.value.rb_visited"]();
  }
  return DEBUG_VALUE_LABELS[unqualified]?.() ?? name;
}

export function DebugPanel() {
  const debugArena  = useMazeStore((s) => s.debugArena);
  const debugStep   = useMazeStore((s) => s.debugStep);
  const debugStale  = useMazeStore((s) => s.debugStale);
  const delayMs     = useMazeStore((s) => s.debugAutoPlayDelay);
  const debugValueToggles = useMazeStore((s) => s.debugValueToggles);
  const showKruskalDsuGroups = useMazeStore((s) => s.showKruskalDsuGroups);
  const debugAutoSwitchFloor = useMazeStore((s) => s.debugAutoSwitchFloor);
  const multiFloor = useMazeStore((s) => s.floors.length > 1);
  const setDebugStep = useMazeStore((s) => s.setDebugStep);
  const focusDebugStep = useMazeStore((s) => s.focusDebugStep);
  const setDebugMode = useMazeStore((s) => s.setDebugMode);
  const setDelayMs   = useMazeStore((s) => s.setDebugAutoPlayDelay);
  const toggleDebugValue = useMazeStore((s) => s.toggleDebugValue);
  const toggleKruskalDsuGroups = useMazeStore((s) => s.toggleKruskalDsuGroups);
  const toggleDebugAutoSwitchFloor = useMazeStore((s) => s.toggleDebugAutoSwitchFloor);

  const [playing, setPlaying] = React.useState(false);
  const [delayDraft, setDelayDraft] = React.useState(String(delayMs));
  const [width, setWidth] = useState(MIN_PANEL_WIDTH);
  const resizing = useRef(false);
  const total = debugArena?.totalSteps ?? 0;
  // Each half is sized to `total`'s digit count (the max either side can reach), not the current
  // step's digit count, so the " / " separator stays pinned to the row's center instead of
  // drifting as the digit count changes during scrubbing/playback.
  const stepLabelHalfWidth = `${String(total).length}ch`;

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

  useEffect(() => {
    if (!playing) return;
    const ms = Math.max(50, delayMs);
    const id = setInterval(() => {
      const state = useMazeStore.getState();
      const step = state.debugStep;
      const last = (state.debugArena?.totalSteps ?? 1) - 1;
      if (step >= last) {
        setPlaying(false);
      } else {
        state.setDebugStep(step + 1);
      }
    }, ms);
    return () => clearInterval(id);
  }, [playing, delayMs]);

  useEffect(() => { setDelayDraft(String(delayMs)); }, [delayMs]);

  // Stop autoplay when the debug arena changes
  useEffect(() => { setPlaying(false); }, [debugArena]);

  if (!debugArena) return null;

  function handleClose() {
    setPlaying(false);
    setDebugMode(false);
  }

  const atStart = debugStep <= 0;
  const atEnd   = debugStep >= total - 1;

  return (
    <div style={{ ...styles.panel, width, minWidth: MIN_PANEL_WIDTH }}>
      <div
        style={styles.resizeHandle}
        onMouseDown={(e) => { e.preventDefault(); resizing.current = true; }}
      />
      {debugStale && (
        <div style={styles.staleAlert}>{m["debug.outdated_warning"]()}</div>
      )}
      <div style={styles.controls}>
        {/* Step buttons */}
        <button className="hoverable" style={styles.toolbarBtn} disabled={atStart} onClick={() => { setPlaying(false); setDebugStep(debugStep - 1); }} title={m["debug.prev_step"]()}>❮</button>
        <button className="hoverable" style={styles.toolbarBtn} disabled={atEnd}   onClick={() => { setPlaying(false); setDebugStep(debugStep + 1); }} title={m["debug.next_step"]()}>❯</button>

        {/* Autoplay */}
        <button
          className="hoverable"
          style={styles.toolbarBtn}
          onClick={() => setPlaying(p => !p)}
          title={playing ? m["debug.stop"]() : m["debug.play"]()}
        >
          {playing ? "⏹" : "▶"}
        </button>

        {/* Delay */}
        <input
          type="text"
          style={styles.delayInput}
          value={delayDraft}
          title={m["debug.delay_ms"]()}
          onChange={(e) => setDelayDraft(e.target.value)}
          onBlur={() => {
            const v = Math.max(50, Math.min(9999, parseInt(delayDraft, 10) || delayMs));
            setDelayMs(v);
            setDelayDraft(String(v));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span style={styles.label}>ms</span>

        {/* Close */}
        <button className="hoverable" style={styles.closeBtn} onClick={handleClose} title={m["debug.exit"]()}><X size={16} /></button>
      </div>

      {multiFloor && (
        <div style={styles.autoSwitchFloorRow}>
          <ToggleRow
            label={m["debug.auto_switch_floor"]()}
            checked={debugAutoSwitchFloor}
            onChange={toggleDebugAutoSwitchFloor}
          />
        </div>
      )}

      <div style={styles.stepRow}>
        <span
          className="hoverable"
          style={styles.stepLabel}
          title={m["debug.focus_step"]()}
          onClick={focusDebugStep}
        >
          <span style={{ ...styles.stepLabelHalf, width: stepLabelHalfWidth, textAlign: "right" as const }}>{total === 0 ? 0 : debugStep + 1}</span>
          {" / "}
          <span style={{ ...styles.stepLabelHalf, width: stepLabelHalfWidth, textAlign: "left" as const }}>{total}</span>
        </span>
        <StepSlider
          value={debugStep}
          max={total - 1}
          style={styles.slider}
          // GitHub issue #350: in-flight drag ticks skip the floor auto-switch (`switchFloor:
          // false`) — otherwise scrubbing across many floors in quick succession flickers the
          // active floor on every tick. `onChangeEnd` applies the real switch once, at the settled
          // value, when the drag actually stops.
          onChange={(v) => { setPlaying(false); setDebugStep(v, false); }}
          onChangeEnd={(v) => setDebugStep(v, true)}
        />
      </div>

      {(debugArena.debugValueNames.length > 0 || debugArena.algorithmKind === "kruskal") && (
        <div style={styles.debugValuesRow}>
          {debugArena.debugValueNames.map(({ name }) => (
            <ToggleRow
              key={name}
              label={debugValueLabel(name, debugArena.algorithmKind)}
              checked={debugValueToggles.has(name)}
              onChange={() => toggleDebugValue(name)}
            />
          ))}
          {debugArena.algorithmKind === "kruskal" && (
            <ToggleRow
              label={m["debug.value.kruskal_dsu_groups"]()}
              checked={showKruskalDsuGroups}
              onChange={toggleKruskalDsuGroups}
            />
          )}
        </div>
      )}

      <DebugEventTree />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: ui.bg.panel,
    borderLeft: `1px solid ${ui.border.default}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    flexShrink: 0,
    position: "relative",
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
  controls: {
    display: "flex",
    alignItems: "center",
    gap: spacing.rowGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    background: ui.bg.panelAlt,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  stepRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.rowGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  autoSwitchFloorRow: {
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  debugValuesRow: {
    display: "flex",
    flexDirection: "column" as const,
    gap: spacing.itemGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    borderBottom: `1px solid ${ui.border.default}`,
    flexShrink: 0,
  },
  toolbarBtn: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    cursor: "default",
    padding: `0 ${inset.panelInsetX}px`,
    flexShrink: 0,
    height: 28,
    boxSizing: "border-box" as const,
    borderRadius: radius.sm,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    appearance: "none" as const,
    paddingBottom: 2,
  },
  delayInput: {
    ...typography.field,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: sharedStyles.input.padding,
    width: 60,
    height: 28,
    boxSizing: "border-box" as const,
    borderRadius: radius.sm,
    flexShrink: 0,
    textAlign: "right" as const,
  },
  label: {
    ...muted(typography.body),
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  stepLabel: {
    ...muted(typography.body),
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    cursor: "pointer" as const,
  },
  stepLabelHalf: {
    display: "inline-block" as const,
    overflow: "hidden" as const,
    verticalAlign: "top" as const,
  },
  slider: {
    flex: 1,
    minWidth: 60,
  },
  closeBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    cursor: "default",
    padding: `0 ${inset.iconButtonInset}px`,
    flexShrink: 0,
    lineHeight: 1,
    marginLeft: "auto",
  },
  staleAlert: {
    ...typography.body,
    background: ui.bg.error,
    color: ui.text.error,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    flexShrink: 0,
  },
};
