# dashboard — the owner's view

Answers "where is my money, and what has the agent been doing with it".

## Why it is a server, not a static page

Reading shielded balances needs the viewing key, and the viewing key never leaves the server
(CLAUDE.md hard rule 1). The browser gets numbers, never keys.

It binds to **loopback only**. This page shows private balances and a full payment history, and it
has no authentication because it has no network path. Exposing it beyond localhost means adding auth
first — which is also why the public `demo_url` should be the claim page, not this.

## Two sources, kept apart

| Source | What it is |
|---|---|
| `policy` | What the agent *asked for* — refusals included. They never reach the chain, and they are the point of an audit view. |
| `chain` | What actually *settled*, read from the pool. |

Merging them without the tag would let a denied payment read as a completed one.

**Attribution is asymmetric, and the page says so.** The pool's `Deposit` event indexes the
depositor, so a shield is attributable to us — read from the event's **first indexed key**, never
the transaction sender (every private transaction is relayed, so the sender is the same address for
everybody). `Withdrawal` encrypts the initiator and indexes only the recipient, so an unshield
appears here from Kese's own record and not from Starknet.

Verified against real mainnet data: 16 deposits across **10 distinct depositors**. Filtering by
sender would have shown one.

## Three visibility levels, not two

- **private** — sender, recipient and amount hidden inside the pool.
- **public** — a pool edge: address and amount on-chain for anyone.
- **amount shown** — a claim link. The recipient stays hidden, but the escrow pays through an *open*
  note, which carries its value in the clear. Labelling this "private" would overstate what the
  protocol does.

## Run it

```sh
pnpm --filter @kese/dashboard dev     # http://127.0.0.1:5184
```

Refuses to start without a spending policy, listing every missing setting — a dashboard that came up
with no limits would misrepresent an agent that has none.
