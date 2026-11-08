/** Updates the HTML loading screen that is visible before React has mounted. */
export function setBootScreenStatus(message: string, progress?: number) {
  const status = document.getElementById("boot-status");
  if (status) status.textContent = message;

  const bar = document.getElementById("boot-progress-bar");
  const value = document.getElementById("boot-progress-value");
  const track = document.getElementById("boot-progress-track");
  if (bar instanceof HTMLElement) {
    const determinate = progress !== undefined;
    bar.classList.toggle("loading-progress-indeterminate", !determinate);
    if (determinate) bar.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
    if (track) {
      if (determinate) {
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "100");
        track.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
      } else {
        track.removeAttribute("aria-valuemin");
        track.removeAttribute("aria-valuemax");
        track.removeAttribute("aria-valuenow");
      }
    }
  }
  if (value) value.textContent = progress === undefined ? "" : `${Math.round(progress * 100)}%`;
}
