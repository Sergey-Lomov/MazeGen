# Keyboard interactions

## Escape responders

Global Escape behavior is coordinated by `maze-web/src/keyboard/escapeResponder.ts`, not by
independent `window` key listeners. A responder returns `true` only when it cancelled a live
operation. The dispatcher tries responders in descending priority and then newest-first order;
after the first `true`, it prevents the event and no lower responder sees that key.

Priorities are `panel < transient < modal`. A side panel is therefore the fallback close action,
an in-progress canvas operation cancels before its editor closes, and a modal closes before either.
Responder registrations must be released on unmount or controller destruction. A persistent
controller may remain registered, but must return `false` when it has no cancellable state.

Nested or local DOM controls may handle Escape themselves before the global dispatcher. Any
window-level Escape behavior must use the dispatcher so it participates in this ordering.
