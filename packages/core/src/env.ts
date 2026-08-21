/**
 * Find and load `.env`, wherever the process happened to start.
 *
 * Every entrypoint used to call `process.loadEnvFile(".env")` — a path relative to the *current
 * working directory*. That quietly ties "does this program work" to "where was it launched from",
 * and the two launchers that matter most do not launch from the repo root:
 *
 *   - `pnpm --filter @kese/dashboard dev` runs with cwd = `apps/dashboard/`.
 *   - An MCP client spawns the server with whatever cwd it likes — usually the user's home
 *     directory, or the directory of the project the agent is working on.
 *
 * Both then found no file, and the server refused to start with a list of missing variables that
 * looked like a configuration mistake rather than a lookup failure. Failing closed was correct;
 * failing closed for the wrong reason cost an hour.
 *
 * So: search upward from each starting point and take the first `.env` found — the same
 * nearest-ancestor rule git and npm use, which means a nested checkout still gets its own file.
 * Searching from the *module's* directory as well as the cwd is what makes the MCP case work,
 * since the built server lives inside the repo no matter where it is invoked from.
 *
 * Values already present in the environment WIN over the file: `process.loadEnvFile` does not
 * overwrite them. That is the precedence we want — an MCP client passing `env: { KESE_NETWORK }`
 * in its config must not be silently overridden by a stale file on disk.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LoadEnvResult {
  /** The file that was loaded, or null if none was found. */
  path: string | null;
  /** Every directory checked, in order — so a failure can say where it looked. */
  searched: string[];
}

export interface LoadEnvOptions {
  /** Directories to start climbing from. Defaults to the cwd. */
  from?: readonly string[];
  filename?: string;
  /** Injected for tests. */
  exists?: (path: string) => boolean;
  load?: (path: string) => void;
}

export function loadDotEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const {
    from = [process.cwd()],
    filename = ".env",
    exists = existsSync,
    load = (path: string) => process.loadEnvFile(path),
  } = options;

  const searched: string[] = [];

  for (const start of from) {
    let dir = resolve(start);

    for (;;) {
      if (!searched.includes(dir)) {
        searched.push(dir);
        const candidate = resolve(dir, filename);
        if (exists(candidate)) {
          load(candidate);
          return { path: candidate, searched };
        }
      }

      const parent = dirname(dir);
      // `dirname("/")` is `"/"`, and likewise for a Windows drive root — this is the
      // termination condition, not a guess about path depth.
      if (parent === dir) break;
      dir = parent;
    }
  }

  return { path: null, searched };
}

/**
 * The directories an entrypoint should search: where the user ran it, and where its own code
 * lives. Pass `import.meta.url`.
 */
export function envSearchPath(moduleUrl: string): string[] {
  // fileURLToPath, not `new URL(...).pathname`: the latter hands back a percent-encoded path, so
  // a checkout under "Application Support" becomes ".../Application%20Support" and matches nothing.
  const here = dirname(fileURLToPath(moduleUrl));
  return [process.cwd(), here];
}
