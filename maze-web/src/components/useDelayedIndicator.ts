import { useEffect, useRef, useState } from "react";

/** Default delay before a progress indicator appears (GitHub issue #960). */
export const INDICATOR_SHOW_DELAY = 200;
/** Default time an appeared progress indicator stays visible so it does not blink away. */
export const INDICATOR_MIN_VISIBLE = 750;

interface Options {
  showDelay?: number;
  minVisible?: number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Turns a set of "work is running" keys into the keys whose indicator is shown. A key is shown only
 * when its work is still running after `showDelay`, and once shown it stays for at least `minVisible`.
 * Work that restarts while its indicator is still shown keeps it shown. Keys are shown in the order
 * their indicators appeared. `active` must keep its identity while its content is unchanged.
 */
export function useDelayedKeys<K>(
  active: readonly K[],
  { showDelay = INDICATOR_SHOW_DELAY, minVisible = INDICATOR_MIN_VISIBLE }: Options = {},
): K[] {
  const [shown, setShown] = useState<K[]>([]);
  const shownAt = useRef(new Map<K, number>());
  const showTimers = useRef(new Map<K, Timer>());
  const hideTimers = useRef(new Map<K, Timer>());

  useEffect(() => {
    const showing = showTimers.current;
    const hiding = hideTimers.current;
    for (const key of active) {
      const hide = hiding.get(key);
      if (hide !== undefined) { clearTimeout(hide); hiding.delete(key); }
      if (shownAt.current.has(key) || showing.has(key)) continue;
      showing.set(key, setTimeout(() => {
        showing.delete(key);
        shownAt.current.set(key, Date.now());
        setShown((current) => [...current, key]);
      }, showDelay));
    }
    for (const [key, timer] of [...showing]) {
      if (active.includes(key)) continue;
      clearTimeout(timer);
      showing.delete(key);
    }
    for (const [key, since] of [...shownAt.current]) {
      if (active.includes(key) || hiding.has(key)) continue;
      const hide = () => {
        hiding.delete(key);
        shownAt.current.delete(key);
        setShown((current) => current.filter((k) => k !== key));
      };
      const remaining = minVisible - (Date.now() - since);
      if (remaining <= 0) hide();
      else hiding.set(key, setTimeout(hide, remaining));
    }
  }, [active, showDelay, minVisible]);

  // The entries go with their timers: a remounted effect (StrictMode) must see a cleared timer as absent and schedule it again.
  useEffect(() => () => {
    for (const timer of showTimers.current.values()) clearTimeout(timer);
    for (const timer of hideTimers.current.values()) clearTimeout(timer);
    showTimers.current.clear();
    hideTimers.current.clear();
  }, []);

  return shown;
}

const RUNNING: readonly true[] = [true];
const IDLE: readonly true[] = [];

/** `useDelayedKeys` for a single "work is running" flag. */
export function useDelayedIndicator(active: boolean, options: Options = {}): boolean {
  return useDelayedKeys(active ? RUNNING : IDLE, options).length > 0;
}
