#!/usr/bin/env node
/**
 * Assemble the exact file tree that is deployed to Vercel as the public claim page.
 *
 * The claim page cannot be built on Vercel from this repo as-is. The workspace root depends on
 * `@starkware-libs/starknet-privacy-sdk`, which lives on GitHub Packages and needs a
 * `read:packages` token to install — so a plain `pnpm install` fails there. Storing that token on
 * Vercel would put a credential in a third-party service to install a package the claim page never
 * uses: it reads the escrow with plain starknet.js, and claiming happens inside the visitor's own
 * wallet.
 *
 * So the deployment carries its own `package.json` listing only the three packages the page
 * actually needs. Everything else is copied VERBATIM and to the SAME relative path, so the only
 * file that can drift is the one this script does not copy.
 *
 * This script exists so that redeploying is mechanical rather than remembered. Run it, build the
 * output with plain npm to confirm it stands alone, then upload the tree.
 *
 *   node scripts/build-vercel-tree.mjs
 *   cd apps/claim/.vercel-tree && npm install && npm run build
 *
 * Then deploy that directory with the settings in apps/claim/vercel/DEPLOY.md.
 */

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "apps/claim/.vercel-tree");

/**
 * Source path -> path inside the deployment.
 *
 * The core modules are listed one by one rather than copied as a directory: the rest of
 * `packages/core/src` is server-side code that imports the Privacy SDK, and a directory copy would
 * quietly start shipping it the first time someone adds a file.
 */
const FILES = [
  ["apps/claim/index.html", "apps/claim/index.html"],
  ["apps/claim/vite.config.ts", "apps/claim/vite.config.ts"],
  ["apps/claim/src/main.ts", "apps/claim/src/main.ts"],
  ["apps/claim/src/claim.ts", "apps/claim/src/claim.ts"],
  ["packages/core/src/claimlink.ts", "packages/core/src/claimlink.ts"],
  ["packages/core/src/format.ts", "packages/core/src/format.ts"],
  ["packages/core/src/escrow.ts", "packages/core/src/escrow.ts"],
  ["packages/core/src/address.ts", "packages/core/src/address.ts"],
  ["packages/core/src/config.ts", "packages/core/src/config.ts"],
  // Deployment-specific, kept under version control in apps/claim/vercel/.
  ["apps/claim/vercel/package.json", "package.json"],
  ["apps/claim/vercel/DEPLOY.md", "DEPLOY.md"],
  // Named `env` in the repo so it is not swept up by a .gitignore rule for .env files. Every value
  // in it is public by construction — Vite inlines them into the browser bundle.
  ["apps/claim/vercel/env", "apps/claim/.env"],
];

rmSync(out, { recursive: true, force: true });

for (const [from, to] of FILES) {
  const target = join(out, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repo, from), target);
}

console.log(`${out}\n  ${FILES.length} files`);

// A build here must not reach outside the tree. If it can, the deployment is relying on something
// Vercel will not have, and the failure would only show up after publishing.
const strays = readdirSync(out).filter((entry) => entry.startsWith(".."));
if (strays.length > 0) throw new Error(`tree escapes its root: ${strays.join(", ")}`);

console.log("\nnext:\n  cd apps/claim/.vercel-tree && npm install && npm run build");
