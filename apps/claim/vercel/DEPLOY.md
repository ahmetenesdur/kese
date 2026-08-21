# Deploying the claim page

Live at **https://kese-claim.vercel.app** — the project's `demo_url`.

The deployment builds from this repository on every push to `main`. `vercel.json` at the repo root
drives it, and the one line that matters is the install command:

```
cp apps/claim/vercel/package.json package.json && cp apps/claim/vercel/env apps/claim/.env && npm install
```

## Why it swaps the manifest

This is a pnpm workspace whose root depends on `@starkware-libs/starknet-privacy-sdk`, published to
GitHub Packages. Installing it needs a token with `read:packages`, and `@kese/core` depends on it
too, so no amount of filtering avoids it — a normal `pnpm install` on Vercel fails.

Handing Vercel a GitHub token would mean storing a credential in a third-party service in order to
install a package **the claim page never uses**. The page reads the escrow with plain starknet.js,
and claiming happens inside the visitor's own wallet; the SDK is server-side code. So the build
swaps in `package.json` from this directory, which lists only the three packages the page actually
needs plus vite. Verified on a clean clone with npm authentication disabled: the SDK is never
requested, and the build produces the same artifact hash as a local build.

**No credential of any kind is stored on Vercel.**

The checkout is ephemeral, so overwriting the root `package.json` there affects nothing else. It
does mean any future Vercel build in this repo that needs the *real* root manifest must change this
line first.

## Why the env values are in git

`env` is copied to `apps/claim/.env` at build time, and Vite inlines `VITE_*` into the browser
bundle — so every value in it is public the moment the page ships. All three are: a network name, a
keyless public RPC endpoint, and a deployed contract address.

The project's own `RPC_URL_SEPOLIA` is an Alchemy endpoint **with the API key in the path** and must
never be used here. That is the whole reason this file exists rather than pointing the build at the
repo's `.env`.

The file is named `env`, not `.env`, so a future `.gitignore` rule for dotenv files cannot silently
drop it from the deployment.

## Deploying without the git integration

`node scripts/build-vercel-tree.mjs` assembles the same tree as a standalone directory, for a
direct upload. Its output was verified to rebuild the artifact that is currently serving,
byte-for-byte.
