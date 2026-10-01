import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./generated/paraglide",
      outputStructure: "locale-modules",
    }),
  ],
  resolve: {
    alias: {
      "~/paraglide": path.resolve(__dirname, "generated/paraglide"),
    },
  },
  worker: {
    format: "es",
  },
});
