/**
 * Fail if compiled output is sitting beside the TypeScript sources.
 *
 * `import "./wallet.js"` resolves to a real `wallet.js` if one exists, in preference to mapping to
 * `wallet.ts`. So a stray build artifact in `src/` silently shadows the source: tests keep passing,
 * against code that may be hours old. That happened here — `tsc` ran once with no `outDir` (it had
 * been removed from the shared base before the per-package ones were added) and emitted next to the
 * sources, which were then committed and shadowed `@kese/core` for about an hour.
 *
 * The structural fix is per-package `outDir`/`rootDir`; this is the tripwire that says so out loud
 * if it ever regresses.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|d\.ts|js\.map)$/.test(entry)) offenders.push(path);
  }
}

for (const pkg of readdirSync("packages")) {
  const src = join("packages", pkg, "src");
  try {
    if (statSync(src).isDirectory()) walk(src);
  } catch {
    /* package has no src */
  }
}

if (offenders.length > 0) {
  console.error(
    "✗ Compiled output found beside the sources — it SHADOWS them at import time:\n" +
      offenders.map((f) => `    ${f}`).join("\n") +
      "\n\n  Delete them, and check that every package tsconfig sets its own outDir and rootDir.\n"
  );
  process.exit(1);
}
