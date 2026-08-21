/**
 * A wallet capability probe, for the owner to run on their own wallet.
 *
 * `main.ts` deliberately does NOT call `wallet_strk20Balances` — probing a *visitor's* wallet for
 * balances is asking a stranger to share something this page has no business seeing, to answer a
 * question a version number already answers. Here the person running the check owns the wallet and
 * is deliberately interrogating it, which is a different act; the deeper probe is still a separate,
 * clearly-labelled second step rather than something that happens on page load.
 *
 * It reports what the wallet actually said, verbatim, rather than a verdict. Another team's report
 * of Braavos answering "Not implemented" (strk20-hackathon#121) is the reason this exists, and the
 * useful thing to hand back is evidence in the same shape.
 */

import { describeError, isPrivacyCapable } from "./wallet-capability.js";

/** STRK. The same address on mainnet and Sepolia, so the probe needs no network configuration. */
const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const app = document.getElementById("app") as HTMLDivElement;

/**
 * What `createStore().getWallets()` hands back is a **Wallet Standard** wallet, not the legacy
 * window object. It has `name`, `version` and a `features` map — no `id`, and no `request()` of its
 * own. The first version of this page assumed otherwise, found no `request`, and printed "this
 * wallet exposes no request() method" as though that were a fact about the wallet. It was a fact
 * about the bug.
 *
 * Everything goes through starknet.js's own `walletV6` helpers now, which know that the callable
 * lives at `features["starknet:walletApi"].request`.
 */
interface Found {
  name: string;
  version?: string;
  icon?: string;
  wallet: unknown;
}

const escape = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const report: string[] = [];
function log(line: string): void {
  report.push(line);
}

function renderReport(extra = ""): void {
  app.innerHTML =
    `<pre id="out">${escape(report.join("\n"))}</pre>` +
    extra +
    `<div class="row">
       <button class="quiet" id="copy">Copy result</button>
       <button class="quiet" id="again">Start over</button>
     </div>`;
  document.getElementById("copy")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(report.join("\n")).catch(() => {});
    const b = document.getElementById("copy")!;
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy result"), 1500);
  });
  document.getElementById("again")?.addEventListener("click", () => location.reload());
}

async function probe(found: Found): Promise<void> {
  app.innerHTML = `<p class="sub" style="margin:0">Confirm the connection in ${escape(found.name)}…</p>`;
  report.length = 0;
  log(`wallet: ${found.name}${found.version ? ` v${found.version}` : ""}`);
  const features = (found.wallet as { features?: Record<string, unknown> }).features ?? {};
  log(`  starknet:walletApi feature: ${"starknet:walletApi" in features ? "present" : "ABSENT"}`);

  const { walletV6 } = await import("starknet");

  // 1. The version list. Safe: it asks what the wallet implements, not for any of the user's data.
  try {
    const versions = (await walletV6.supportedWalletApi(found.wallet as never)) as string[];
    log(`wallet_supportedWalletApi → ${versions.length ? versions.join(", ") : "(empty)"}`);
    log(`  privacy-capable version (>= 0.10): ${isPrivacyCapable(versions) ? "yes" : "NO"}`);
  } catch (error) {
    log(`wallet_supportedWalletApi → failed: ${describeError(error)}`);
  }

  renderReport(
    `<p class="note">The second check calls <code>wallet_strk20Balances</code>. It only reads, but
     your wallet may ask you to approve sharing balances — that prompt is itself an answer, since a
     wallet that has not implemented the method cannot ask.</p>
     <div class="row"><button id="deep">Run the second check</button></div>`
  );

  document.getElementById("deep")?.addEventListener("click", async () => {
    const button = document.getElementById("deep") as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Asking the wallet…";
    try {
      // starknet.js's own helper, so the call goes where the spec says it goes. It takes the
      // tokens to report on; STRK has the same address on mainnet and Sepolia, and the wallet
      // answers for whichever network it is currently on.
      const { walletV6 } = await import("starknet");
      const result = await walletV6.strk20Balances(found.wallet as never, [STRK_TOKEN]);
      const count = Array.isArray(result) ? `${result.length} entr${result.length === 1 ? "y" : "ies"}` : typeof result;
      log(`wallet_strk20Balances → answered (${count})`);
      log(`  the method is implemented`);
    } catch (error) {
      log(`wallet_strk20Balances → ${describeError(error)}`);
      log(`  a rejection here can mean either "not implemented" or "you declined" — the wording above is the wallet's own`);
    }
    renderReport();
  });
}

async function main(): Promise<void> {
  const { createStore } = await import("@starknet-io/get-starknet-discovery");
  const wallets = createStore().getWallets() as { name: string; version?: string; icon?: string }[];

  if (wallets.length === 0) {
    app.innerHTML = `<p class="sub" style="margin:0">No Starknet wallet found in this browser.
      Install one and reload — Ready and Xverse are the two reported to support STRK20 shielding.</p>`;
    return;
  }

  app.innerHTML =
    `<p class="sub" style="margin:0 0 1rem">Found ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}. Pick one to ask.</p>` +
    `<ul class="wallets">${wallets
      .map(
        (w, i) => `<li>
          ${w.icon ? `<img src="${escape(w.icon)}" alt="">` : ""}
          <span class="name">${escape(w.name)}</span>
          <button data-i="${i}">Check</button>
        </li>`
      )
      .join("")}</ul>`;

  for (const button of app.querySelectorAll<HTMLButtonElement>("button[data-i]")) {
    button.addEventListener("click", () => {
      const w = wallets[Number(button.dataset.i)]!;
      void probe({ name: w.name, version: w.version, icon: w.icon, wallet: w });
    });
  }
}

main().catch((error) => {
  app.innerHTML = `<p class="sub" style="margin:0">Could not start the check: ${escape(describeError(error))}</p>`;
});
