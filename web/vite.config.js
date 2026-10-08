import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { avatarkitVitePlugin } from "@spatius/avatarkit/vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// The AvatarKit plugin copies its WASM into dist/assets after the bundle closes, so the
// folder has to exist by then.
const ensureAssetsDir = () => ({ name: "ensure-assets-dir", closeBundle() { mkdirSync(path.join(here, "dist/assets"), { recursive: true }); } });

export default defineConfig({
  base: "/call/",
  plugins: [ensureAssetsDir(), avatarkitVitePlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: path.join(here, "src/call.js"),
      preserveEntrySignatures: "exports-only",
      output: { entryFileNames: "call.js", chunkFileNames: "assets/[name]-[hash].js" },
    },
  },
});
