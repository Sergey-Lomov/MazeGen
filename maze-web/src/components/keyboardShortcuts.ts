/** Enter and Space confirm the primary action of an open feature card. */
export function isFeatureCardConfirmShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.key !== "Enter" && event.code !== "Space") return false;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return false;
  if (target instanceof HTMLInputElement) {
    return ["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"].includes(target.type);
  }
  return true;
}
