/** Calls `onChange` with the new `window.devicePixelRatio` whenever it changes — the window moved
 *  to a display with a different density, or browser zoom changed. A `(resolution: Xdppx)` media
 *  query only reports leaving that exact density, so it is re-armed for the new value after each
 *  change. Returns an unsubscribe function. */
export function watchDevicePixelRatio(onChange: (dpr: number) => void): () => void {
  let query: MediaQueryList | null = null;
  const listener = () => {
    arm();
    onChange(currentDpr());
  };
  const arm = () => {
    query?.removeEventListener("change", listener);
    query = window.matchMedia(`(resolution: ${currentDpr()}dppx)`);
    query.addEventListener("change", listener);
  };
  arm();
  return () => {
    query?.removeEventListener("change", listener);
    query = null;
  };
}

function currentDpr(): number {
  return window.devicePixelRatio || 1;
}
