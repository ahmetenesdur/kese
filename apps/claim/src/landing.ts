/**
 * The landing page's policy console.
 *
 * Renders `decide()` — the same rule order the engine uses — and stages the rules so a visitor
 * *sees* which one decides rather than reading that it does. The stagger is the page's only
 * animation: it carries information (order of evaluation), which is the bar for motion here.
 */

import { decide, type Decision, type Policy } from "./policy-console.js";

/** The owner's policy, matching the numbers printed under the console. */
const POLICY: Policy = {
  perTxCap: 10,
  dailyCap: 50,
  approvalThreshold: 2,
  spentToday: 12,
  allowlisted: true,
};

const VERDICT_LABEL = { allow: "Allowed", ask: "Needs the owner", deny: "Denied" } as const;

const amountInput = document.getElementById("amount") as HTMLInputElement;
const rulesList = document.getElementById("rules") as HTMLUListElement;
const verdictBox = document.getElementById("verdict") as HTMLDivElement;
const presets = [...document.querySelectorAll<HTMLButtonElement>(".presets button")];

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/** The mark each state gets. A skipped rule shows a dash: nothing was computed, so nothing is said. */
const MARK = { pass: "✓", fail: "✕", ask: "?", skipped: "–" } as const;

function render(decision: Decision): void {
  rulesList.innerHTML = decision.rules
    .map((rule, index) => {
      // Only stagger the rules that were actually evaluated; the skipped ones are already there,
      // greyed, and animating them in would suggest something happened to them.
      const delay = reduceMotion || index > decision.decidedAt ? 0 : index * 70;
      const meter = rule.meter
        ? `<span class="meter" aria-hidden="true">
             <i style="width:${Math.min(100, (rule.meter.spent / rule.meter.cap) * 100)}%"></i>
             <b style="width:${Math.min(
               100 - (rule.meter.spent / rule.meter.cap) * 100,
               (rule.meter.adding / rule.meter.cap) * 100
             )}%"></b>
           </span>`
        : "";
      return `
        <li class="rule ${rule.state}" style="animation-delay:${delay}ms">
          <span class="mark" aria-hidden="true">${MARK[rule.state]}</span>
          <span class="label">${escape(rule.label)}${
            rule.code ? ` <span class="code">${escape(rule.code)}</span>` : ""
          }</span>
          <span class="detail">${meter}${escape(rule.detail)}</span>
        </li>`;
    })
    .join("");

  const skipped = decision.rules.filter((r) => r.state === "skipped").length;
  verdictBox.innerHTML = `
    <span class="chip ${decision.verdict}">${VERDICT_LABEL[decision.verdict]}</span>
    <p>${escape(decision.headline)}${
      skipped > 0 ? ` — ${skipped} check${skipped === 1 ? "" : "s"} never ran.` : "."
    }</p>`;
}

function update(): void {
  const amount = Number(amountInput.value);
  render(decide(amount, POLICY));
  for (const button of presets) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.amount) === amount));
  }
}

amountInput.addEventListener("input", update);
for (const button of presets) {
  button.addEventListener("click", () => {
    amountInput.value = button.dataset.amount ?? "1";
    update();
  });
}

update();
