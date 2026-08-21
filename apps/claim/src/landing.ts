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

function render(decision: Decision): void {
  rulesList.innerHTML = decision.rules
    .map((rule, index) => {
      const deciding = index === decision.decidedAt;
      const failed = !rule.passed;
      // The threshold rule "fails" into an ask, not a denial — it gets the amber mark, because
      // colouring it red would say the payment was refused when a human is simply being asked.
      const asking = deciding && decision.verdict === "ask";
      const classes = ["rule", failed ? "fail" : "pass", asking ? "ask" : ""].join(" ");
      const mark = failed ? "✕" : asking ? "?" : "✓";
      // Staggered only while rules are being read top to bottom; instant when motion is reduced.
      const delay = reduceMotion ? 0 : index * 70;
      return `
        <li class="${classes}" style="animation-delay:${delay}ms">
          <span class="mark" aria-hidden="true">${asking ? "?" : mark}</span>
          <span class="label">${escape(rule.label)}${
            rule.code ? ` <span class="code">${escape(rule.code)}</span>` : ""
          }</span>
          <span class="detail">${escape(rule.detail)}</span>
        </li>`;
    })
    .join("");

  const skipped = 5 - decision.rules.length;
  verdictBox.innerHTML = `
    <span class="chip ${decision.verdict}">${VERDICT_LABEL[decision.verdict]}</span>
    <p>${escape(decision.headline)}${
      skipped > 0
        ? ` — the remaining ${skipped} check${skipped === 1 ? "" : "s"} never ran.`
        : "."
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
