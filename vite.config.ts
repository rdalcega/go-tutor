import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  // The server allows the browser's Origin only from this port (src/server/index.ts), so a busy port must fail, not pick another.
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://localhost:4747" } },
});
