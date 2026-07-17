/** Debounces `fn`: each call resets the delay, only the last call within `ms` actually runs.
 *  `cancel()` clears a pending call — used on renderer `destroy()` to avoid a stray redraw after
 *  containers are gone. */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as T & { cancel(): void };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
