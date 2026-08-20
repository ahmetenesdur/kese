#!/usr/bin/env bash
# Kese — agent skills setup
# Run once from repo root after cloning. Requires Node >= 24.
set -euo pipefail

echo "==> Installing STRK20 official integration skill (starkience/strk20-agent-skills)"
# Skill: strk20-privacy-integration — scans the repo, interviews you, writes STRK20_INTEGRATION_PLAN.md,
# then executes app-side integration phase by phase. NOTE: it never writes Cairo (our contracts stay ours).
npx skills add starkience/strk20-agent-skills --skill strk20-privacy-integration

cat <<'NOTE'

==> Anthropic official skills (installed via Claude Code slash commands, run these INSIDE Claude Code):
    /plugin marketplace add anthropics/skills
    /plugin install example-skills@anthropic-agent-skills
    Relevant for Kese: the MCP server generation skill (use when building packages/mcp)
    and the webapp testing skill (use when testing apps/dashboard). Exact skill names are
    listed by the plugin after install — see CLAUDE.md "Skills" section for when to use which.

Done. Verify with: npx skills list
NOTE
