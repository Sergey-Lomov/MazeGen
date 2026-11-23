/**
 * Ordered owners of the next Escape press. A responder returns `true` only when it
 * performed a cancellation; lower-priority responders then never observe that key.
 *
 * Registration order breaks ties, so nested UI at the same priority remains LIFO.
 */
export const escapePriority = {
  panel: 100,
  transient: 200,
  modal: 300,
} as const;

type Responder = () => boolean;

interface Entry {
  responder: Responder;
  priority: number;
  order: number;
}

const entries: Entry[] = [];
let nextOrder = 0;
let listening = false;

function dispatchEscape(event: KeyboardEvent): void {
  if ((event.key !== "Escape" && event.code !== "Escape") || event.defaultPrevented) return;
  const ordered = [...entries].sort((a, b) => b.priority - a.priority || b.order - a.order);
  for (const entry of ordered) {
    if (!entries.includes(entry)) continue;
    if (!entry.responder()) continue;
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
}

function ensureListener(): void {
  if (listening) return;
  window.addEventListener("keydown", dispatchEscape);
  listening = true;
}

function maybeRemoveListener(): void {
  if (!listening || entries.length !== 0) return;
  window.removeEventListener("keydown", dispatchEscape);
  listening = false;
}

/** Claims Escape until the returned release function is called. */
export function claimEscape(responder: Responder, priority: number = escapePriority.transient): () => void {
  const entry: Entry = { responder, priority, order: nextOrder++ };
  entries.push(entry);
  ensureListener();
  return () => {
    const index = entries.indexOf(entry);
    if (index !== -1) entries.splice(index, 1);
    maybeRemoveListener();
  };
}
