/**
 * @kese/mcp — the policy-guarded MCP server.
 *
 * `spend()` is the only path from a tool call to money moving (CLAUDE.md hard rule 2); the tools in
 * server.ts are thin wrappers over it.
 */
export { createKeseMcpServer, type ServerDeps } from "./server.js";
export { spend, type ApprovalChannel, type SpendDeps, type SpendOutcome } from "./spend.js";
export { loadPolicyConfig, type LoadResult } from "./config.js";
export { createClaimStore, type ClaimRecord, type ClaimState, type ClaimStore } from "./claims.js";
export { TOOLS } from "./tools.js";
