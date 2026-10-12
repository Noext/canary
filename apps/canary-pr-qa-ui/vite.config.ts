import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Built for the PR QA server, which serves the output under /dashboard/assets/.
 * In dev the dashboard runs on its own origin and proxies the API, so the
 * session cookie stays same-origin (there is no CORS on the server).
 */
const apiTarget = process.env.QA_API_TARGET ?? "http://127.0.0.1:8787";
const apiPaths = [
  "/artifacts",
  "/auth",
  "/dashboard/status",
  "/github",
  "/health",
  "/me",
  "/models",
  "/runs",
  "/session",
];

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/dashboard/assets/" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    proxy: Object.fromEntries(
      // changeOrigin stays false: the server rejects a mutating request whose
      // Origin host differs from Host, so the proxy must forward both verbatim.
      apiPaths.map((pathname) => [pathname, { target: apiTarget }])
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        assetFileNames: "client.[ext]",
        chunkFileNames: "client-[name].js",
        entryFileNames: "client.js",
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
}));
