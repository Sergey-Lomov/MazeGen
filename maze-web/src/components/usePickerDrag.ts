import { useCallback, useEffect, useRef } from "react";
import type React from "react";

/** Fraction of an element the pointer is over, each axis clamped to 0-1 (0 = left / top). */
export interface Frac {
  x: number;
  y: number;
}

function frac(el: HTMLElement, clientX: number, clientY: number): Frac {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}

/** Shared pointer-drag plumbing for the color-picker model editors' 2D area + vertical strip
 *  (`HslModelEditor`, `OklchModelEditor`). Each editor gets a `ref` to attach and an `onPointerDown`
 *  that captures the pointer, reports the initial position, and starts a drag tracked on `window`
 *  so it keeps working outside the element and ends on pointer-up anywhere. The `onMove` callback
 *  receives the clamped 0-1 fraction along each axis; the editor maps that to its own channel
 *  ranges. Keyboard nudging stays in each editor (the step sizes differ per model). */
export function usePickerDrag(onMove: (f: Frac) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const emit = useCallback((clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    onMoveRef.current(frac(el, clientX, clientY));
  }, []);

  useEffect(() => {
    function move(e: PointerEvent) {
      if (dragging.current) emit(e.clientX, e.clientY);
    }
    function up() {
      dragging.current = false;
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [emit]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      emit(e.clientX, e.clientY);
    },
    [emit],
  );

  return { ref, onPointerDown };
}
