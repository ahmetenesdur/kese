import { describe, expect, it } from "vitest";
import { loadDotEnv } from "./env.js";

/** A fake filesystem: the set of paths that "exist". */
function fs(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

describe("loadDotEnv", () => {
  it("loads a .env sitting in the starting directory", () => {
    const loaded: string[] = [];
    const result = loadDotEnv({
      from: ["/repo"],
      exists: fs("/repo/.env"),
      load: (p) => loaded.push(p),
    });

    expect(result.path).toBe("/repo/.env");
    expect(loaded).toEqual(["/repo/.env"]);
  });

  it("climbs to an ancestor — the case that broke `pnpm --filter`", () => {
    const result = loadDotEnv({
      from: ["/repo/apps/dashboard"],
      exists: fs("/repo/.env"),
      load: () => {},
    });

    expect(result.path).toBe("/repo/.env");
  });

  it("prefers the nearest .env, so a nested checkout keeps its own", () => {
    const result = loadDotEnv({
      from: ["/repo/apps/dashboard"],
      exists: fs("/repo/.env", "/repo/apps/.env"),
      load: () => {},
    });

    expect(result.path).toBe("/repo/apps/.env");
  });

  it("reports where it looked when nothing is found", () => {
    const result = loadDotEnv({
      from: ["/repo/apps/dashboard"],
      exists: () => false,
      load: () => {},
    });

    expect(result.path).toBeNull();
    expect(result.searched).toEqual(["/repo/apps/dashboard", "/repo/apps", "/repo", "/"]);
  });

  it("terminates at the filesystem root instead of looping", () => {
    // dirname("/") === "/", so a naive loop never exits.
    const result = loadDotEnv({ from: ["/"], exists: () => false, load: () => {} });
    expect(result.searched).toEqual(["/"]);
  });

  it("searches the module directory when the cwd has no .env", () => {
    // The MCP case: an agent spawns the server from the user's home directory.
    const result = loadDotEnv({
      from: ["/home/someone", "/repo/packages/mcp/dist"],
      exists: fs("/repo/.env"),
      load: () => {},
    });

    expect(result.path).toBe("/repo/.env");
  });

  it("never loads more than one file", () => {
    const loaded: string[] = [];
    loadDotEnv({
      from: ["/repo/a", "/repo/b"],
      exists: fs("/repo/a/.env", "/repo/b/.env"),
      load: (p) => loaded.push(p),
    });

    expect(loaded).toHaveLength(1);
  });

  it("does not re-check a directory two starting points share", () => {
    const result = loadDotEnv({
      from: ["/repo/x", "/repo/y"],
      exists: () => false,
      load: () => {},
    });

    // /repo and / appear once each, not twice.
    expect(result.searched).toEqual(["/repo/x", "/repo", "/", "/repo/y"]);
  });
});
