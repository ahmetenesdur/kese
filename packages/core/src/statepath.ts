/**
 * Where this installation keeps its state.
 *
 * One rule, and it is safety-critical: a *relative* `POLICY_DB_PATH` resolves against the project,
 * never against the working directory.
 *
 * The database it names holds the idempotency records. An MCP client spawns its server from
 * wherever it likes, so a cwd-relative path means a second launch from a different directory opens
 * a second, EMPTY database — and a retried payment whose key lives in the other file is not
 * recognised as a replay. It executes again. CLAUDE.md hard rule 3 says the same key must never
 * re-execute; that guarantee is exactly as durable as the file it is written to.
 *
 * This lived as two copies, in the MCP entrypoint and in the dashboard, which is one copy too many
 * for a rule whose failure mode is paying twice.
 */

import { isAbsolute, resolve } from "node:path";

export interface StatePathInput {
  /** The configured value, e.g. `POLICY_DB_PATH`. Absolute paths are honoured as given. */
  configured?: string | undefined;
  /** Path to the loaded `.env`, from `loadDotEnv()`. Its directory is the project root. */
  envPath?: string | null;
  /** Fallback when no `.env` was found — there is nothing better to anchor to. */
  cwd?: string;
  fallback?: string;
}

export function resolveStatePath(input: StatePathInput): string {
  const {
    configured,
    envPath = null,
    cwd = process.cwd(),
    fallback = "./kese-policy.sqlite",
  } = input;

  const wanted = configured?.trim() ? configured.trim() : fallback;

  // An absolute path is an explicit choice by whoever set it, and honouring it is what makes a
  // shared database across several checkouts possible at all.
  if (isAbsolute(wanted)) return wanted;

  // `:memory:` and friends are SQLite URIs, not paths. Resolving one would turn it into a file
  // named ":memory:" on disk, which looks like it works right up until the process restarts.
  if (wanted.startsWith(":")) return wanted;

  const root = envPath ? resolve(envPath, "..") : cwd;
  return resolve(root, wanted);
}
