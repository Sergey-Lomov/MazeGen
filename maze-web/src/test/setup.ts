import "@testing-library/jest-dom";
import { SIDE_PANEL_SLOT_ID } from "../components/SidePanel";

// `SidePanel` portals into this DOM node (see `App.tsx`) — every test render needs it present the
// same way the real app always does, or any component using `SidePanel` silently renders nothing.
if (typeof document !== "undefined" && !document.getElementById(SIDE_PANEL_SLOT_ID)) {
  const slot = document.createElement("div");
  slot.id = SIDE_PANEL_SLOT_ID;
  document.body.appendChild(slot);
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = () => null;
}
