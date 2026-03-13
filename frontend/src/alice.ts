import {
  api,
  $,
  setStep,
  show,
  pollStatus,
  sleep,
  getOrCreateKeypair,
  LENDASWAP_URL,
  ARKADE_URL,
} from "./common";
import {
  Client,
  InMemorySwapStorage,
  InMemoryWalletStorage,
} from "@lendasat/lendaswap-sdk-pure";
import QRCode from "qrcode";
import "./style.css";

const STEPS = 6;

/** Build an ephemeral lendaswap client (fresh keys, in-memory storage). */
async function buildLendaswapClient(): Promise<Client> {
  return Client.builder()
    .withBaseUrl(LENDASWAP_URL)
    .withArkadeServerUrl(ARKADE_URL)
    .withSignerStorage(new InMemoryWalletStorage())
    .withSwapStorage(new InMemorySwapStorage())
    .build();
}

async function main() {
  const { pk: alicePk } = await getOrCreateKeypair("alice");
  $("alice-pk-display").textContent = alicePk;
  $("keypair").style.display = "flex";

  $("btn-copy-pk").addEventListener("click", () => {
    navigator.clipboard.writeText(alicePk);
    $("btn-copy-pk").textContent = "Copied!";
    setTimeout(() => ($("btn-copy-pk").textContent = "Copy"), 1500);
  });

  const btnCreate = $("btn-create") as HTMLButtonElement;

  btnCreate.addEventListener("click", async () => {
    const bobPk = ($("bob-pk") as HTMLInputElement).value.trim();
    const amount = parseInt(($("amount") as HTMLInputElement).value);

    if (!bobPk || bobPk.length !== 64) {
      show("create-err", "Bob pubkey must be 64 hex chars (x-only)");
      return;
    }
    if (!amount || amount < 333) {
      show("create-err", "Amount must be at least 333 sats");
      return;
    }

    btnCreate.disabled = true;
    show("create-err", "");

    try {
      const trade = await api("POST", "/trades", {
        alice_pk: alicePk,
        bob_pk: bobPk,
      });

      // Step 2: create Lightning→Arkade swap via lendaswap
      setStep(2, STEPS);
      show("step-2-body", "Initializing Lightning swap...");

      const lsClient = await buildLendaswapClient();
      const swap = await lsClient.createLightningToArkadeSwap({
        satsReceive: amount,
        targetAddress: trade.escrow_address,
      });

      const invoice = swap.response.boltz_invoice;
      const swapId = swap.response.id;

      // Render invoice + QR code
      const qrDataUrl = await QRCode.toDataURL(invoice.toUpperCase(), {
        width: 256,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      show(
        "step-2-body",
        `<p>Pay <strong>${amount.toLocaleString()} sats</strong> via Lightning:</p>
         <img id="ln-qr" src="${qrDataUrl}" alt="Lightning invoice QR" style="display:block; margin:0.5rem 0" />
         <code class="mono" style="word-break:break-all; font-size:0.75rem">${invoice}</code>
         <br/>
         <button id="btn-copy-invoice" class="secondary small" style="margin-top:0.4rem">Copy invoice</button>
         <p style="margin-top: 0.6rem">Trade ID (share with Bob):</p>
         <code class="mono">${trade.trade_id}</code>
         <button id="btn-copy-id" class="secondary small" style="margin-left: 0.5rem">Copy</button>`,
      );

      $("btn-copy-invoice").addEventListener("click", () => {
        navigator.clipboard.writeText(invoice);
        $("btn-copy-invoice").textContent = "Copied!";
        setTimeout(
          () => ($("btn-copy-invoice").textContent = "Copy invoice"),
          1500,
        );
      });

      $("btn-copy-id").addEventListener("click", () => {
        navigator.clipboard.writeText(trade.trade_id);
        $("btn-copy-id").textContent = "Copied!";
        setTimeout(() => ($("btn-copy-id").textContent = "Copy"), 1500);
      });

      // Automatically wait for payment, claim, and confirm funding
      await waitForPaymentAndClaim(lsClient, swapId, trade.trade_id);
    } catch (e: any) {
      show("create-err", e.message);
      btnCreate.disabled = false;
    }
  });
}

/**
 * Poll the swap until the server has funded the VHTLC,
 * then auto-claim it to the escrow address and confirm on-chain.
 */
async function waitForPaymentAndClaim(
  lsClient: Client,
  swapId: string,
  tradeId: string,
) {
  setStep(3, STEPS);
  show("step-3-body", "Waiting for Lightning payment...");

  // Phase 1: poll swap status until serverfunded (VHTLC created on Arkade)
  const FUNDED_STATUSES = ["serverfunded", "clientredeemed", "serverredeemed"];
  const TERMINAL_FAIL = [
    "expired",
    "clientrefunded",
    "clientfundedserverrefunded",
  ];

  for (let i = 0; ; i++) {
    const swap = await lsClient.getSwap(swapId, { updateStorage: true });
    const status = swap.status;

    if (FUNDED_STATUSES.includes(status)) {
      show(
        "step-3-body",
        '<span class="info">✓ Lightning payment received</span>',
      );
      break;
    }

    if (TERMINAL_FAIL.includes(status)) {
      show(
        "step-3-body",
        `<span class="error">Swap failed: ${status}</span>`,
      );
      return;
    }

    const label =
      status === "clientfunded" || status === "clientfundingseen"
        ? "Payment detected, waiting for confirmation..."
        : `Waiting for Lightning payment... (attempt ${i + 1})`;
    show("step-3-body", label);
    await sleep(3000);
  }

  // Phase 2: claim the VHTLC → funds land at escrow address
  show("step-3-body", "Claiming VHTLC to escrow address...");
  const claimResult = await lsClient.claim(swapId);
  if (!claimResult.success) {
    show(
      "step-3-body",
      `<span class="error">Claim failed: ${claimResult.message}</span>`,
    );
    return;
  }
  show(
    "step-3-body",
    '<span class="info">✓ VHTLC claimed, waiting for escrow VTXO...</span>',
  );

  // Phase 3: confirm the VTXO appeared at the escrow address (existing server flow)
  await confirmFunding(tradeId);
}

async function confirmFunding(tradeId: string) {
  for (let i = 0; i < 30; i++) {
    try {
      const funded = await api("POST", `/trades/${tradeId}/fund`);
      show(
        "step-3-body",
        `<span class="info">✓ Escrow funded: ${funded.amount.toLocaleString()} sats</span>`,
      );
      goAttest(tradeId);
      return;
    } catch {
      show(
        "step-3-body",
        `Waiting for escrow VTXO on Arkade... (attempt ${i + 1})`,
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

  await pollStatus(tradeId, ["completed"], (t) => {
    show("step-5-body", `Status: ${t.status}...`);
  });

  setStep(6, STEPS);
  show(
    "step-6-body",
    '<span class="info">✓ Trade completed! Funds released to Bob.</span>',
  );
}

main();
