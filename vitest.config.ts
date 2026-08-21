import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

/**
 * Resolve workspace packages to their SOURCE during tests.
 *
 * Without this, `@kese/core` resolves to dist/index.js, so every run would need a build first and
 * would silently test stale output. Production `pnpm build` still emits real dist.
 *
 * ORDER MATTERS. Vite matches string aliases by prefix, so a bare `@kese/core` entry placed first
 * would swallow `@kese/core/format` and resolve it to `.../index.ts/format`. Specific first.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Deep entries exist for browser consumers: the barrel re-exports factory.ts, which imports
      // the SDK and its /testing entry — server-only code that breaks a browser bundle.
      "@kese/core/claimlink": src("core/src/claimlink.ts"),
      "@kese/core/format": src("core/src/format.ts"),
      "@kese/core/escrow": src("core/src/escrow.ts"),
      "@kese/core": src("core/src/index.ts"),
      "@kese/policy": src("policy/src/index.ts"),
      "@kese/approvals": src("approvals/src/index.ts"),
      "@kese/mcp": src("mcp/src/index.ts"),
    },
  },
});
