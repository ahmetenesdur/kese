import { describe, expect, it } from "vitest";
import { resolveStatePath } from "./statepath.js";

describe("resolveStatePath", () => {
  it("anchors a relative path to the project, not the caller — the double-payment case", () => {
    // An MCP client launched us from the user's home directory. The database must still be the
    // project's, or a retried payment stops being recognised as a replay.
    expect(
      resolveStatePath({
        configured: "./kese-policy.sqlite",
        envPath: "/repo/.env",
        cwd: "/home/someone",
      })
    ).toBe("/repo/kese-policy.sqlite");
  });

  it("gives the same answer from any working directory", () => {
    const from = (cwd: string) =>
      resolveStatePath({ configured: "./db.sqlite", envPath: "/repo/.env", cwd });
    expect(from("/home/someone")).toBe(from("/tmp"));
    expect(from("/repo/apps/dashboard")).toBe(from("/"));
  });

  it("honours an absolute path exactly, so several checkouts can share one database", () => {
    expect(
      resolveStatePath({ configured: "/var/lib/kese/policy.sqlite", envPath: "/repo/.env" })
    ).toBe("/var/lib/kese/policy.sqlite");
  });

  it("falls back to the cwd when there is no .env to anchor to", () => {
    expect(resolveStatePath({ configured: "./db.sqlite", envPath: null, cwd: "/somewhere" })).toBe(
      "/somewhere/db.sqlite"
    );
  });

  it("uses the default filename when nothing is configured", () => {
    expect(resolveStatePath({ envPath: "/repo/.env" })).toBe("/repo/kese-policy.sqlite");
  });

  it("treats blank and whitespace as unset — .env files collect empty keys", () => {
    expect(resolveStatePath({ configured: "   ", envPath: "/repo/.env" })).toBe(
      "/repo/kese-policy.sqlite"
    );
    expect(resolveStatePath({ configured: "", envPath: "/repo/.env" })).toBe(
      "/repo/kese-policy.sqlite"
    );
  });

  it("trims a stray space rather than creating a file whose name starts with one", () => {
    expect(resolveStatePath({ configured: " ./db.sqlite ", envPath: "/repo/.env" })).toBe(
      "/repo/db.sqlite"
    );
  });

  it("leaves :memory: alone instead of turning it into a file on disk", () => {
    // Resolving it would produce /repo/:memory: — which appears to work until the process restarts
    // and the idempotency records are not where the last run left them.
    expect(resolveStatePath({ configured: ":memory:", envPath: "/repo/.env" })).toBe(":memory:");
  });

  it("resolves a path that climbs out of the project, since that was asked for explicitly", () => {
    expect(resolveStatePath({ configured: "../shared/policy.sqlite", envPath: "/repo/.env" })).toBe(
      "/shared/policy.sqlite"
    );
  });
});
