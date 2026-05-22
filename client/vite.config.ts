import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8217",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Without manualChunks, rollup builds a single 4-5 MB chunk and the
    // peak memory during "rendering chunks" exceeds what 1GB-RAM VPSes can
    // give it (vite gets OS-killed even with --max-old-space-size=4096
    // because the JS heap isn't the only thing under pressure).
    //
    // Splitting the heavy deps into their own chunks keeps each chunk
    // small enough that rollup can stream output instead of buffering the
    // whole bundle. Side benefit: incremental rebuilds are faster and the
    // browser cache survives small app-code changes.
    rollupOptions: {
      output: {
        manualChunks: {
          "monaco-editor":   ["monaco-editor", "@monaco-editor/react"],
          "pdfjs":           ["pdfjs-dist"],
          "yjs":             ["yjs", "y-monaco", "y-websocket"],
          "react":           ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
