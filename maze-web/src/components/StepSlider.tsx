import React, { useEffect, useRef } from "react";

interface Props {
  value: number;
  max: number;
  style?: React.CSSProperties;
  onChange: (v: number) => void;
}

// Dragging the native range input fires one "input" event per pointer-move tick, far more often
// than once per animation frame. Forwarding every tick straight into onChange (which drives a
// full maze re-render, see #137) makes the slider stutter on large runs. Throttle to one
// onChange call per animation frame, always using the latest value so the final drop position
// is never dropped.
export function StepSlider({ value, max, style, onChange }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingValue = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);

  useEffect(() => () => {
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
  }, []);

  function handleChange(v: number) {
    pendingValue.current = v;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      if (pendingValue.current !== null) {
        onChangeRef.current(pendingValue.current);
        pendingValue.current = null;
      }
    });
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
    />
  );
}
