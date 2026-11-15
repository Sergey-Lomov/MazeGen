import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { paraglideWatchPlugin } from "./tools/paraglide-watch-plugin.mjs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    paraglideWatchPlugin(),
  ],
  resolve: {
    alias: {
      "~/paraglide": path.resolve(__dirname, "generated/paraglide"),
    },
  },
  // Pre-bundle the heavy dependencies up front so a cold start does not discover them one by one
  // and trigger repeated optimizer runs and full page reloads.
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "pixi.js",
      "pixi.js/unsafe-eval",
      "zustand",
      "lucide-react",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@floating-ui/react-dom",
      "@tanstack/react-virtual",
    ],
  },
  server: {
    warmup: { clientFiles: ["./src/main.tsx", "./src/App.tsx"] },
  },
  worker: {
    format: "es",
  },
});
