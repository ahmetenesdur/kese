#!/usr/bin/env node
/**
 * Refuse to ship a bundle carrying a secret.
 *
 * Vite inlines every `VITE_*` value into the JavaScript it emits. That is the whole point of the
 * prefix — and it means a single wrong value in a `.env` publishes a credential to everyone who
 * loads the page. This is not hypothetical: `apps/claim/.env` held an Alchemy URL with the API key
 * in its path, and any local `vite build` would have baked it into the deployed output. The live
 * site was built from a different file and was never affected, which is exactly why nobody noticed.
 *
 * So the build checks its own output. A key cannot reach production without this failing first.
 *
 * Usage: node scripts/check-bundle-clean.mjs <dist-dir>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dist = process.argv[2];
if (!dist) {
  console.error("usage: node scripts/check-bundle-clean.mjs <dist-dir>");
  process.exit(2);
}

/**
 * Patterns are shaped around *how credentials look*, not around a list of vendors — a new provider
 * next month should still be caught.
 */
const FORBIDDEN = [
  {
    name: "keyed RPC endpoint",
    // A provider host followed by a path segment long enough to be a key.
    re: /https:\/\/[a-z0-9.-]*(alchemy|infura|quicknode|blastapi|ankr|chainstack)[a-z0-9.-]*\/[^\s"'`]*[A-Za-z0-9_-]{16,}/gi,
  },
  { name: "Alchemy key", re: /\balch_[A-Za-z0-9]{16,}\b/g },
  { name: "Telegram bot token", re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: "private key env name", re: /ACCOUNT_PRIVATE_KEY|VIEWING_KEY/g },
];

/*
 * Deliberately NOT checking for bare 64-hex literals, though that is the shape of a Starknet
 * private key. Contract addresses, class hashes and curve constants are the same shape and belong
 * in this bundle — the rule fired 24 times on a clean build. A check that cries wolf on every run
 * gets switched off, and a switched-off check protects nothing. Precision matters more than
 * coverage for a guard that has to survive being useful.
 *
 * Private keys are kept out of the browser by a different mechanism anyway: they are never `VITE_*`,
 * so Vite has nothing to inline.
 */

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|mjs|css|html|json|map)$/.test(entry)) out.push(full);
  }
  return out;
}

let failures = 0;
for (const file of walk(dist)) {
  const text = readFileSync(file, "utf8");
  for (const { name, re } of FORBIDDEN) {
    for (const match of text.match(re) ?? []) {
      // Show enough to identify it, never the whole credential.
      const shown = match.length > 42 ? `${match.slice(0, 34)}…${match.slice(-4)}` : match;
      console.error(`✗ ${name} in ${relative(process.cwd(), file)}\n    ${shown}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} secret-shaped string(s) in the build output. Every VITE_* value ships to the\n` +
      `browser — check the .env this build read, and use a keyless endpoint.`
  );
  process.exit(1);
}
console.log(`✓ bundle clean — ${walk(dist).length} files scanned, no secret-shaped strings`);
