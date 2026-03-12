import { api, $, setStep, show, pollStatus, sleep } from "./common";
import "./style.css";

const STEPS = 6;

async function main() {
  const btnCreate = $("btn-create") as HTMLButtonElement;

  btnCreate.addEventListener("click", async () => {
    const alicePk = ($("alice-pk") as HTMLInputElement).value.trim();
    const bobPk = ($("bob-pk") as HTMLInputElement).value.trim();
    const amount = parseInt(($("amount") as HTMLInputElement).value);

    if (!alicePk || alicePk.length !== 64) {
      show("create-err", "Alice pubkey must be 64 hex chars (x-only)");
      return;
    }
    if (!bobPk || bobPk.length !== 64) {
      show("create-err", "Bob pubkey must be 64 hex chars (x-only)");
      return;
    }
    if (!amount || amount < 1000) {
      show("create-err", "Amount must be at least 1000 sats");
      return;
    }

    btnCreate.disabled = true;
    show("create-err", "");

    try {
      const trade = await api("POST", "/trades", {
        alice_pk: alicePk,
        bob_pk: bobPk,
      });

      // Step 2: show address + trade ID for Bob
      setStep(2, STEPS);
      show(
        "step-2-body",
        `<p>Send <strong>${amount.toLocaleString()} sats</strong> to this Ark address:</p>
         <code class="mono">${trade.escrow_address}</code>
         <p style="margin-top: 0.6rem">Trade ID (share with Bob):</p>
         <code class="mono">${trade.trade_id}</code>
         <button id="btn-copy" class="secondary" style="margin-left: 0.5rem">Copy ID</button>
         <br/>
         <button id="btn-funded" style="margin-top: 0.8rem">I've sent the funds →</button>`,
      );

      $("btn-copy").addEventListener("click", () => {
        navigator.clipboard.writeText(trade.trade_id);
        $("btn-copy").textContent = "Copied!";
      });

      $("btn-funded").addEventListener("click", () =>
        confirmFunding(trade.trade_id),
      );
    } catch (e: any) {
      show("create-err", e.message);
      btnCreate.disabled = false;
    }
  });
}

async function confirmFunding(tradeId: string) {
  setStep(3, STEPS);
  show("step-3-body", "Looking for escrow VTXO on Arkade...");

  for (let i = 0; i < 30; i++) {
    try {
      const funded = await api("POST", `/trades/${tradeId}/fund`);
      show(
        "step-3-body",
        `<span class="info">✓ Funded: ${funded.amount.toLocaleString()} sats</span>`,
      );
      goAttest(tradeId);
      return;
    } catch {
      show(
        "step-3-body",
        `Looking for escrow VTXO on Arkade... (attempt ${i + 1})`,
      );
      await sleep(3000);
    }
  }

  show("step-3-body", '<span class="error">VTXO not found after 90s</span>');
}

async function goAttest(tradeId: string) {
  setStep(4, STEPS);
  show(
    "step-4-body",
    `<p>Confirm that the off-chain condition is met (e.g. ERC20 transfer received).</p>
     <button id="btn-attest">Attest ✓</button>`,
  );

  $("btn-attest").addEventListener("click", async () => {
    ($("btn-attest") as HTMLButtonElement).disabled = true;
    try {
      await api("POST", `/trades/${tradeId}/attest`);
      show("step-4-body", '<span class="info">✓ Attested</span>');
      waitForCompletion(tradeId);
    } catch (e: any) {
      show("step-4-body", `<span class="error">${e.message}</span>`);
    }
  });
}

async function waitForCompletion(tradeId: string) {
  setStep(5, STEPS);
  show("step-5-body", "Waiting for Bob to sign and finalize...");

  const trade = await pollStatus(tradeId, ["completed"], (t) => {
    show("step-5-body", `Status: ${t.status}...`);
  });

  setStep(6, STEPS);
  show(
    "step-6-body",
    '<span class="info">✓ Trade completed! Funds released to Bob.</span>',
  );
}

main();
