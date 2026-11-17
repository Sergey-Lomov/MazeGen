/** Replaces the progress bar of the HTML loading screen with an error message and a retry button.
 *  Resolves when the button is clicked, after the screen is back in its loading state. */
export function showBootScreenError(message: string, retryLabel: string): Promise<void> {
  const status = document.getElementById("boot-status");
  const track = document.getElementById("boot-progress-track");
  const value = document.getElementById("boot-progress-value");
  // Without the screen there is nothing to click: back off so the caller's retry loop cannot spin.
  if (!status || !track || !value) return new Promise((resolve) => setTimeout(resolve, 1000));

  status.textContent = message;
  status.classList.add("boot-error");
  track.hidden = true;
  value.textContent = "";

  return new Promise((resolve) => {
    const button = document.createElement("button");
    button.id = "boot-retry";
    button.type = "button";
    button.textContent = retryLabel;
    button.addEventListener("click", () => {
      button.remove();
      status.classList.remove("boot-error");
      track.hidden = false;
      resolve();
    });
    value.after(button);
  });
}

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
