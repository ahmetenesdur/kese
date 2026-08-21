# What this deployment is

The public claim page for **Kese** — https://github.com/ahmetenesdur/kese

Every source file here sits at the same path it occupies in that repository and is
byte-identical to it. Only `package.json` and this note are deployment-specific: the repo is a
pnpm workspace whose root depends on `@starkware-libs/starknet-privacy-sdk`, published to GitHub
Packages. Installing that needs a `read:packages` token, and the claim page does not need the SDK
at all — it reads the escrow contract with plain starknet.js, and claiming happens inside the
visitor's own wallet. So this deployment installs the three packages the page actually uses and
nothing else, which means **no credential of any kind is stored on Vercel**.

`apps/claim/.env` holds three values, all public: the network name, a keyless public RPC endpoint,
and the deployed escrow address. The project's own RPC URLs carry an API key and are deliberately
not used here — Vite inlines these into the browser bundle, so anything placed in them is public.
