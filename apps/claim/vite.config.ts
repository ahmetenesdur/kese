import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Two pages, one deployment.
  //
  //   /       the landing page — what Kese is, and a console that answers the way the policy
  //           engine does. No chain access, no wallet, nothing to leak.
  //   /claim  the recipient's page. Its secret rides in the URL fragment, which is why this whole
  //           app is static: a server is a place that could log it.
  //
  // The claim page moved off `/` deliberately, and now was the only free moment to do it — no
  // funded link exists yet, so no live link can break.
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        claim: fileURLToPath(new URL("claim.html", import.meta.url)),
        // A diagnostic, not part of the product: does the owner's wallet implement STRK20?
        check: fileURLToPath(new URL("check.html", import.meta.url)),
      },
    },
  },
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
