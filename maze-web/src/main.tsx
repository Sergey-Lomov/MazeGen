import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initWasm } from "./wasm/wasmLoader";
import { App } from "./App";
import "./styles/global.css";

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
