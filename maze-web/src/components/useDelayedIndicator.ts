import { useEffect, useRef, useState } from "react";

/** Default delay before a progress indicator appears (GitHub issue #960). */
export const INDICATOR_SHOW_DELAY = 200;
/** Default time an appeared progress indicator stays visible so it does not blink away. */
export const INDICATOR_MIN_VISIBLE = 750;

interface Options {
  showDelay?: number;
  minVisible?: number;
}

/**
 * Turns a "work is running" flag into a "show the indicator" flag. The indicator appears only when
 * the work is still running after `showDelay`, and once shown it stays for at least `minVisible`.
 * Work that restarts while the indicator is still shown keeps it shown.
 */
export function useDelayedIndicator(
  active: boolean,
  { showDelay = INDICATOR_SHOW_DELAY, minVisible = INDICATOR_MIN_VISIBLE }: Options = {},
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (shownAt.current !== null) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, showDelay);
      return () => clearTimeout(timer);
    }
    if (shownAt.current === null) return;
    const remaining = Math.max(0, minVisible - (Date.now() - shownAt.current));
    const hide = () => {
      shownAt.current = null;
      setVisible(false);
    };
    if (remaining === 0) {
      hide();
      return;
    }
    const timer = setTimeout(hide, remaining);
    return () => clearTimeout(timer);
  }, [active, showDelay, minVisible]);

  return visible;
}
