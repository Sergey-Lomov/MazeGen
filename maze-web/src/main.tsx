import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initWasm } from "./wasm/wasmLoader";
import { App } from "./App";
import { initLocale } from "./i18n/localeStore";
import "./styles/global.css";

// React DevTools' render-diff logger (dev-only instrumentation) runs JSON.stringify on component
// props to log what changed — throws on any BigInt-valued prop (e.g. DebugRefBubble's `target`,
// which carries raw NodeId bigints) since JSON has no native BigInt representation. That throw
// happens inside a passive-effect commit, which corrupts the whole commit and breaks subsequent
// interaction in the tree (e.g. row expand/collapse stops working). Stringifying as a string is
// the standard, safe BigInt<->JSON interop pattern.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

// Must run sync before createRoot to avoid first-render locale mismatch
initLocale();

async function bootstrap() {
  const root = document.getElementById("root")!;
  try {
    await initWasm();
  } catch (err) {
    root.textContent = `Failed to load WASM: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

bootstrap();
