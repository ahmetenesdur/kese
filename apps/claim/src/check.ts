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

const app = document.getElementById("app") as HTMLDivElement;

interface Found {
  id: string;
  name: string;
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
  log(`wallet: ${found.name} (${found.id})`);

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
      const request = (found.wallet as { request?: (a: unknown) => Promise<unknown> }).request;
      if (typeof request !== "function") {
        log(`wallet_strk20Balances → this wallet exposes no request() method`);
      } else {
        const result = await request.call(found.wallet, { type: "wallet_strk20Balances" });
        log(`wallet_strk20Balances → answered (${Array.isArray(result) ? `${result.length} entries` : typeof result})`);
      }
    } catch (error) {
      log(`wallet_strk20Balances → ${describeError(error)}`);
    }
    renderReport();
  });
}

async function main(): Promise<void> {
  const { createStore } = await import("@starknet-io/get-starknet-discovery");
  const wallets = createStore().getWallets() as { id: string; name: string; icon?: string }[];

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
      void probe({ id: w.id, name: w.name, icon: w.icon, wallet: w });
    });
  }
}

main().catch((error) => {
  app.innerHTML = `<p class="sub" style="margin:0">Could not start the check: ${escape(describeError(error))}</p>`;
});
