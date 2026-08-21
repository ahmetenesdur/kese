# claim page

The page a claim-link recipient lands on. Static: it reads the chain directly and has no server of
its own, because the claim secret rides in the URL **fragment** and a server is a place that could
log it.

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

States can be viewed without a funded link — **dev builds only**, stripped from production:

```
http://localhost:5183/?preview=claimable
http://localhost:5183/?preview=expired
http://localhost:5183/?preview=settled
```

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
