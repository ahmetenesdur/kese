/**
 * Claim page — DOM wiring.
 *
 * All the decisions live in `claim.ts`, which is tested; this file only turns a state into markup
 * and asks the visitor's wallet to act. The page never sees a viewing key, a note or a proof: the
 * wallet runs the Privacy SDK internally and does its own proving, which is also why claiming works
 * without Kese having a proving service of its own.
 */

import { describeAmount, tokenSymbol } from "@kese/core/format";
import { escrowClaimCalldata } from "@kese/core/escrow";
import { lookupClaim, secretFromUrl, type ClaimState } from "./claim.js";

const config = {
  rpcUrl: import.meta.env.VITE_RPC_URL as string,
  escrowAddress: import.meta.env.VITE_ESCROW_ADDRESS as string,
  network: (import.meta.env.VITE_NETWORK as "sepolia" | "mainnet") ?? "sepolia",
};

const content = document.getElementById("content")!;

/**
 * The notice, verbatim on every screen that shows an amount.
 *
 * The escrow credits a claimer through an OPEN note, and open notes carry their amount in
 * plaintext. So the claimer's identity stays hidden and the sum does not. Saying this plainly is
 * not optional — a claim page that implied full privacy would be lying about what the protocol
 * does, and the person reading it cannot check.
 */
const PRIVACY_NOTICE = `
  <div class="notice">
    <strong>What is private here, and what is not.</strong>
    Who paid you is hidden. <strong>The amount is not</strong> — claiming credits an open note,
    which carries its value in the clear on-chain. Your own address stays unlinked to the payer.
  </div>`;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function render(state: ClaimState): void {
  switch (state.kind) {
    case "no-link":
      content.innerHTML = `<p class="sub">This page needs a claim link. Open the full link you were
        sent — it ends with <code>#</code> followed by a long code.</p>`;
      return;

    case "malformed":
      content.innerHTML = `<p class="sub">That link looks incomplete. Links are often broken by
        chat apps that cut them short — try copying the whole thing again.</p>`;
      return;

    case "unknown":
      // Deliberately vague about WHY. Distinguishing "never existed" from "already cleaned up"
      // would tell someone probing random secrets which guesses were closer.
      content.innerHTML = `<p class="sub">No payment found for this link. It may have been
        mistyped, or already claimed some time ago.</p>`;
      return;

    case "settled":
      content.innerHTML = `
        <div class="amount">${escape(describeAmount(state.amount, state.token, config.network))}</div>
        <p class="sub">This payment has already been collected.</p>`;
      return;

    case "expired":
      content.innerHTML = `
        <div class="amount">${escape(describeAmount(state.amount, state.token, config.network))}</div>
        <p class="sub">This link has expired and the funds have gone back to the sender. Ask them
          for a new link.</p>`;
      return;

    case "claimable":
      content.innerHTML = `
        <div class="amount">${escape(describeAmount(state.amount, state.token, config.network))}</div>
        <div class="row"><span>Token</span><span>${escape(tokenSymbol(state.token, config.network))}</span></div>
        <div class="row"><span>Expires in</span><span>~${state.blocksRemaining} blocks</span></div>
        ${PRIVACY_NOTICE}
        <button id="claim">Claim to my wallet</button>
        <p class="status" id="status"></p>`;
      document.getElementById("claim")!.addEventListener("click", () => void claim(state));
      return;
  }
}

function setStatus(message: string): void {
  const status = document.getElementById("status");
  if (status) status.textContent = message;
}

/**
 * Ask the visitor's wallet to claim.
 *
 * Two things have to happen in one pool transaction: an open note is created for the claimer, and
 * the escrow is invoked to fund it. The wallet composes and proves both.
 *
 * NOT VERIFIED END TO END. It needs a privacy-enabled wallet (Ready; Xverse in progress) and a
 * funded link, and creating a link still waits on the proving service. Treat this path as written
 * but unproven until someone runs it with a real wallet.
 */
async function claim(state: Extract<ClaimState, { kind: "claimable" }>): Promise<void> {
  const button = document.getElementById("claim") as HTMLButtonElement;
  button.disabled = true;
  setStatus("Looking for a wallet…");

  try {
    // get-starknet v6 discovers wallets rather than opening a modal of its own: createStore()
    // returns a live store, and the app renders the picker. (The `connect({ modalMode })` shape is
    // v3/v4 and does not exist here — verified against the WalletAccount guide, not guessed.)
    const { createStore } = await import("@starknet-io/get-starknet-discovery");
    const wallets = createStore().getWallets();

    if (wallets.length === 0) {
      setStatus("No Starknet wallet found. Install Ready to claim this payment.");
      button.disabled = false;
      return;
    }

    const wallet = wallets.length === 1 ? wallets[0]! : await pickWallet(wallets);
    if (!wallet) {
      button.disabled = false;
      return;
    }

    // Capability check by VERSION, on the WALLET — never by calling a data method. Probing
    // strk20Balances would make the wallet prompt the visitor to share balances this page has no
    // business seeing, to answer a question a version number already answers.
    const { WalletAccountV6, walletV6 } = await import("starknet");
    const versions = await walletV6.supportedWalletApi(wallet as never).catch(() => [] as string[]);
    const privacyCapable = versions.some((v) => {
      const [major, minor] = v.split(".").map(Number);
      return (major ?? 0) > 0 || (minor ?? 0) >= 10;
    });
    if (!privacyCapable) {
      setStatus("This wallet does not support private payments yet. Ready supports them today.");
      button.disabled = false;
      return;
    }

    setStatus("Confirm in your wallet…");
    // The inherited static is typed as returning V5; V6 is what it actually builds here.
    const account = (await WalletAccountV6.connect(
      { nodeUrl: config.rpcUrl },
      wallet as never
    )) as InstanceType<typeof WalletAccountV6>;

    const secret = secretFromUrl(window.location.href)!;
    const { transaction_hash } = await account.strk20InvokeTransaction([
      // One pool transaction, two parts: an open note for the claimer, then the escrow invoked to
      // fund it. The `${openNoteIds[0]}` placeholder is filled in once note ids are assigned.
      { type: "transfer", token: state.token, amount: "OPEN", recipient: account.address },
      {
        type: "invoke",
        contract: config.escrowAddress,
        calldata: escrowClaimCalldata({
          secret,
          noteId: "${openNoteIds[0]}",
          token: state.token,
        }),
      },
    ] as never);

    setStatus(`Sent — transaction ${transaction_hash.slice(0, 10)}…. It may take a minute.`);
  } catch (error) {
    // Never echo a raw wallet error: they can carry request payloads, and this page holds a bearer
    // secret in its address bar.
    const message = error instanceof Error ? error.message.split("\n")[0] : "Something went wrong";
    setStatus(message.slice(0, 160));
    button.disabled = false;
  }
}

/** Render the discovered wallets and resolve with whichever the visitor picks. */
function pickWallet(wallets: readonly unknown[]): Promise<unknown | null> {
  return new Promise((resolve) => {
    const list = document.createElement("div");
    list.innerHTML = wallets
      .map((w, i) => {
        const name = escape(String((w as { name?: string }).name ?? `Wallet ${i + 1}`));
        return `<button data-wallet="${i}" style="margin-top:.5rem">${name}</button>`;
      })
      .join("");
    document.getElementById("content")!.append(list);
    list.addEventListener("click", (event) => {
      const index = (event.target as HTMLElement).dataset.wallet;
      if (index === undefined) return;
      list.remove();
      resolve(wallets[Number(index)] ?? null);
    });
  });
}

/**
 * Dev-only state preview: `?preview=claimable|expired|settled|unknown`.
 *
 * The claimable screen carries the privacy notice — the single most important thing on this page —
 * and it cannot be reached without a funded link, which needs a proving service we do not have yet.
 * Rendering it on demand is how it gets reviewed at all, and it doubles as the demo path.
 *
 * `import.meta.env.DEV` is replaced with `false` at build time, so this and everything it reaches
 * is removed from the production bundle entirely.
 */
function previewState(): ClaimState | null {
  if (!import.meta.env.DEV) return null;
  const want = new URL(window.location.href).searchParams.get("preview");
  if (!want) return null;

  const token = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  const amount = 25n * 10n ** 18n;
  switch (want) {
    case "claimable":
      return { kind: "claimable", token, amount, blocksRemaining: 812 };
    case "expired":
      return { kind: "expired", token, amount };
    case "settled":
      return { kind: "settled", token, amount };
    case "unknown":
      return { kind: "unknown" };
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const preview = previewState();
  if (preview) {
    render(preview);
    return;
  }

  const secret = secretFromUrl(window.location.href);
  if (secret === null) {
    render(window.location.hash.length > 1 ? { kind: "malformed" } : { kind: "no-link" });
    return;
  }

  try {
    render(await lookupClaim(secret, config));
  } catch {
    content.innerHTML = `<p class="sub">Could not reach the network just now. Refresh to try
      again — your link is still valid.</p>`;
  }
}

void main();

// Changing only the fragment does not reload the page, so a visitor who pastes a second link into
// the address bar would otherwise keep reading the first one's verdict — including a stale "no
// link" after arriving without one. Cheap to handle, and confusing not to.
window.addEventListener("hashchange", () => void main());
