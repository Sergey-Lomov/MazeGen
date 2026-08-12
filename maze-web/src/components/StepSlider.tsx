import React, { useEffect, useRef } from "react";

interface Props {
  value: number;
  max: number;
  style?: React.CSSProperties;
  onChange: (v: number) => void;
  /** Fires once with the settled value when a drag ends (pointer release, a keyboard-driven
   *  change, or blur) — GitHub issue #350's floor-switch flicker fix: a caller can drive a side
   *  effect (like auto-switching the debug panel's active floor) off this settle point instead of
   *  off every throttled `onChange` tick while the user is still scrubbing. Optional — a caller
   *  with no such side effect can ignore it and behave exactly as before. */
  onChangeEnd?: (v: number) => void;
}

// Dragging the native range input fires one "input" event per pointer-move tick, far more often
// than once per animation frame. Forwarding every tick straight into onChange (which drives a
// full maze re-render, see #137) makes the slider stutter on large runs. Throttle to one
// onChange call per animation frame, always using the latest value so the final drop position
// is never dropped.
export function StepSlider({ value, max, style, onChange, onChangeEnd }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onChangeEndRef = useRef(onChangeEnd);
  onChangeEndRef.current = onChangeEnd;
  const pendingValue = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  // Last value actually delivered via onChange — `handleEnd` (pointerup/etc.) re-delivers this
  // one value through `onChangeEnd` once the drag settles, even if a throttled rAF tick is still
  // pending (flushed first, so the end callback never fires on a stale value).
  const lastValueRef = useRef(value);

  useEffect(() => () => {
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
  }, []);

  // Delivers `pendingValue` (if any) through `onChange` and clears the pending/rAF bookkeeping —
  // shared by the throttled rAF callback (rafId already cleared to null by the time it runs) and
  // `handleEnd` (which must also cancel a still-pending rAF first, since it may be firing this
  // synchronously ahead of the browser's own animation-frame callback).
  function flush() {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (pendingValue.current !== null) {
      lastValueRef.current = pendingValue.current;
      onChangeRef.current(pendingValue.current);
      pendingValue.current = null;
    }
  }

  function handleChange(v: number) {
    pendingValue.current = v;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(flush);
  }

  function handleEnd() {
    flush();
    onChangeEndRef.current?.(lastValueRef.current);
  }

  return (
    <input
      type="range"
      className="maze-slider"
      style={style}
      min={0}
      max={Math.max(0, max)}
      value={value}
      onChange={(e) => handleChange(Number(e.target.value))}
      onPointerUp={handleEnd}
      onKeyUp={handleEnd}
      onBlur={handleEnd}
    />
  );
}
