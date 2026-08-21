# the public site

Two pages, one static deployment — this is the project's public face.

| | |
|---|---|
| `/` | The landing page. One idea — a console that answers the way the policy engine does — and nothing competing with it. No chain access, no wallet, 2.9 kB of JavaScript. |
| `/claim` | The page a claim-link recipient lands on. |
| `/check` | A diagnostic: does your wallet implement the STRK20 methods? Not every Starknet wallet does, and there is no published list — another team reported Braavos answering "Not implemented" on mainnet ([strk20-hackathon#121](https://github.com/starkience/strk20-hackathon/issues/121)). It asks your wallet and shows you what it said, verbatim. |

Static, because the claim secret rides in the URL **fragment** and a server is a place that could
log it. The claim page moved off `/` when the landing page arrived, which was the only free moment
to do it: no funded link exists yet, so no live link could break.

**Never put a keyed RPC endpoint in `.env`.** Vite inlines every `VITE_*` value into the public
bundle. This file held an Alchemy URL with the key in its path until `pnpm build` — which now scans
its own output — caught it. The deployed site was built from `vercel/env` and was never affected.

## What is private, and what is not

Stated on every screen that shows an amount, and it must stay that way: **the claimed amount is
public.** The escrow credits a claimer through an *open* note, and open notes carry their value in
plaintext. The claimer's identity stays hidden; the sum does not.

## How it works

The visitor's own wallet does the claiming. It runs the Privacy SDK internally and produces its own
proof, so this page never sees a viewing key, a note, or a proof — the rule for any dapp, and also
why claiming does **not** depend on Kese having a proving service.

`src/claim.ts` holds every decision made before a wallet is involved (parse the secret, derive the
commitment, read the escrow, pick a state) and is unit-tested. `src/main.ts` only renders and calls
the wallet.

## Run it

```sh
cp .env.example .env      # fill VITE_RPC_URL
npx vite apps/claim       # or: pnpm --filter @kese/claim-page dev
```

States can be viewed without a funded link, in any build:

```
http://localhost:5183/?demo=claimable
http://localhost:5183/?demo=expired
http://localhost:5183/?demo=settled
http://localhost:5183/?demo=unknown
```

These ship in production rather than being stripped from it. A page that can render a convincing
"25 STRK is waiting for you" is a page someone can be pointed at, so the risk is real — but
stripping them meant the claimable screen, which carries the privacy notice, was the one screen
nobody outside a dev server could review, and the public demo URL rendered as "you are in the wrong
place". They are safe to ship because `render()` enforces two things on a sample: a banner saying
it is one, and **no listener on the claim button** — `disabled` is the visible half of that, the
missing listener is the real one.

Visiting the page with no link at all shows what the project is, for anyone who arrived from the
demo URL rather than from a payment.

A real link is `…/#<secret>`. An unknown or malformed one is handled without touching the chain
where possible, and reported vaguely on purpose: distinguishing "never existed" from "already
claimed" would tell someone probing random secrets which guesses were closer.

## Verified, and not

- ✅ Read path against the **live Sepolia escrow** (`0x1ff4c7f2…3108`): unknown links, malformed
  links, and the state machine.
- ⛔ **The claim action is written but unproven.** It needs a privacy-enabled wallet (Ready; Xverse
  in progress) and a funded link, and funding one still waits on the proving service
  (strk20-hackathon#147). The wallet API here was taken from the WalletAccount guide rather than
  guessed — an earlier draft guessed `connect({ modalMode })`, which is get-starknet v3/v4 and does
  not exist in v6.

## Design

Both pages share `src/tokens.css`, and that is the point: they were drifting into two products.

There is no brand colour. Kese is a gate, so the only colours in the system are the three answers
a payment can get — allow, ask, deny — and everything else is ground, line and type. The claim
page's privacy warning is amber because it is a caveat; its claim button is jade because it is
permission. A decorative fourth colour would compete with the one thing the palette is for.

The first landing page had six feature cells, a table of facts and a four-item list of caveats.
All true, all defensible, and together they buried the one thing worth understanding. It now says
one thing and shows it working.
