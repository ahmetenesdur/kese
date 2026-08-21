import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Static output — the claim page reads the chain directly and has no server of its own. Nothing
  // to run means nothing that could log the secret in the URL fragment.
  build: { outDir: "dist", target: "es2022" },
  resolve: {
    alias: {
      // Deep aliases only. Mapping the barrel would let a stray `@kese/core` import drag the SDK
      // back into the browser bundle without anyone noticing until it broke at runtime.
      "@kese/core/claimlink": fileURLToPath(new URL("../../packages/core/src/claimlink.ts", import.meta.url)),
      "@kese/core/format": fileURLToPath(new URL("../../packages/core/src/format.ts", import.meta.url)),
      "@kese/core/escrow": fileURLToPath(new URL("../../packages/core/src/escrow.ts", import.meta.url)),
    },
  },
});
