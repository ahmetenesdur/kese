import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Resolve workspace packages to their SOURCE during tests and dev.
 *
 * Without this, `@kese/core` resolves to dist/index.js, so every test run would need a build step
 * first and would silently test stale output. Production `pnpm build` still emits real dist.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@kese/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@kese/policy": fileURLToPath(new URL("./packages/policy/src/index.ts", import.meta.url)),
    },
  },
});
