# SUBMISSION.md — hackathon mechanics & checklist

## 1) Registration (Day 1, ~10 minutes)

1. Fork `https://github.com/starkience/strk20-hackathon`
2. Add this entry to `registry.json` (with your own repo URL):

```json
{
  "name": "Kese",
  "repo_url": "https://github.com/ahmetenesdur/kese",
  "telegram": "YOUR_TELEGRAM_USERNAME",
  "description": "Private money for AI agents — policy-guarded MCP wallet on the STRK20 pool: private payments within hard limits, Telegram approvals, claim-link escrow for unregistered recipients, viewing-key audit reports.",
  "category": "Payments",
  "team": ["ahmetenesdur"]
}
```

3. PR title: `Register: Kese — private money for AI agents`
4. PR description (copy):

> **Kese** gives LLM agents a policy-guarded spending account on the STRK20 pool. Agents pay privately through MCP tools; a deterministic policy engine (per-tx/daily caps, allowlists, Telegram human-approval, idempotency) sits between the model and the money, and owners get viewing-key-based audit reports — privacy from the world, not from you. Includes a `privacy_invoke` escrow extension (claim links with expiry+refund) so agents can pay unregistered recipients. Original idea (not on the RFP list); closest kin: private payment rails + the compliance-layer RFP. Solo build.

Note: the `inspired_by` field is intentionally left empty — original-idea positioning.

## 2) Day-1 GitHub issue (proving access)

Repo: `starkience/strk20-hackathon` → Issues → New:

> **Title:** Privacy SDK route — proving service access for mainnet (and Sepolia)
> **Body:** Building "Kese" (registry PR #___): an MCP layer that lets AI agents spend from the pool server-side, so we need the Privacy SDK route with proving services rather than the Wallet API route. The Day-0 guide says the mainnet proving URL isn't published and to ask here — could you share access details (mainnet + Sepolia)? Happy to comply with any rate limits. Telegram: @____

## 3) Final submission checklist (Days 10-11)

- [ ] `strk20.json` at repo root: ≥3 **mainnet** tx hashes touching the pool (the `Deposit` event's `user_addr` must be our address), `contracts[]` (escrow address), `demo_video`, `demo_url`
- [ ] Repo public + MIT + README up to date
- [ ] 3-minute video uploaded (unlisted YouTube is fine)
- [ ] Demo live (Vercel)
- [ ] Last commit well before Aug 31, 23:59 UTC — finish hours early

## 4) Afterwards (Sep 4+)

- Whatever the result: [strk20.starknet.io/rfp](https://strk20.starknet.io/rfp) → **Book a call** (cal.com/adithyadinesh) — with the Kese demo
- PROOF accelerator (proof.starknet.io) next-cohort application — they want a "prototype/MVP + users" profile; Kese fits exactly
