// Vitest would otherwise inherit `root: "web"` from vite.config.ts and find no tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
  },
});
