import {
  api,
  $,
  setStep,
  show,
  pollStatus,
  getTrade,
  getOrCreateKeypair,
  addressLink,
  txLink,
  sleep,
  LENDASWAP_URL,
  ARKADE_URL,
} from "./common";
import {
  signEscrowArkTx,
  signEscrowCheckpoints,
  Client,
  InMemorySwapStorage,
  InMemoryWalletStorage,
} from "@lendasat/lendaswap-sdk-pure";
import "./style.css";

const STEPS = 5;
const LENDASWAP_FEE_SATS = 1;

async function buildLendaswapClient(): Promise<Client> {
  return Client.builder()
    .withBaseUrl(LENDASWAP_URL)
    .withArkadeServerUrl(ARKADE_URL)
    .withSignerStorage(new InMemoryWalletStorage())
    .withSwapStorage(new InMemorySwapStorage())
    .build();
}

// ---------------------------------------------------------------------------
// Input classification
// ---------------------------------------------------------------------------

type LnInput =
  | { type: "bolt11"; invoice: string }
  | { type: "lnaddress"; address: string };

function classifyInput(raw: string): LnInput | null {
  const s = raw.trim();
  const lower = s.toLowerCase();

  // BOLT11 invoice
  if (
    lower.startsWith("lnbc") ||
    lower.startsWith("lntb") ||
    lower.startsWith("lnbcrt")
  ) {
    return { type: "bolt11", invoice: s };
  }

  // Lightning address (user@domain) — backend resolves via LNURL-pay
  if (/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s)) {
    return { type: "lnaddress", address: s };
  }

  return null;
}

/** Build SDK swap options from classified input. */
function toSwapOptions(
  input: LnInput,
  amountSats: number,
): { lightningInvoice?: string; lightningAddress?: string; amountSats?: number } {
  if (input.type === "bolt11") {
    return { lightningInvoice: input.invoice };
  }
  return { lightningAddress: input.address, amountSats };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  const { sk: bobSk, pk: bobPk } = await getOrCreateKeypair("bob");
  $("bob-pk-display").textContent = bobPk;
  $("keypair").style.display = "flex";

  $("btn-copy-pk").addEventListener("click", () => {
    navigator.clipboard.writeText(bobPk);
    $("btn-copy-pk").textContent = "Copied!";
    setTimeout(() => ($("btn-copy-pk").textContent = "Copy"), 1500);
  });

  const btnJoin = $("btn-join") as HTMLButtonElement;

  btnJoin.addEventListener("click", async () => {
    const tradeId = ($("trade-id") as HTMLInputElement).value.trim();

    if (!tradeId) {
      show("join-err", "Paste the trade ID from Alice");
      return;
    }

    btnJoin.disabled = true;
    show("join-err", "");

    try {
      const trade = await getTrade(tradeId);
      show(
        "step-1-body",
        `<span class="info">✓ Joined trade ${tradeId.slice(0, 8)}…</span>`,
      );
      waitForFunding(tradeId, bobSk);
    } catch (e: any) {
      show("join-err", e.message);
      btnJoin.disabled = false;
    }
  });
}

async function waitForFunding(tradeId: string, bobSk: string) {
  setStep(2, STEPS);
  show("step-2-body", "Waiting for Alice to fund the escrow...");

  await pollStatus(tradeId, ["funded", "attested", "releasing", "completed"]);
  const fundedTrade = await getTrade(tradeId);
  const fundTxid = fundedTrade.escrow_outpoint?.split(":")[0];
  const txInfo = fundTxid ? ` — tx: ${txLink(fundTxid)}` : "";
  show(
    "step-2-body",
    `<span class="info">✓ Escrow funded${txInfo}</span>
     <br/>Escrow address: ${addressLink(fundedTrade.escrow_address)}`,
  );
  waitForAttestation(tradeId, bobSk);
}

async function waitForAttestation(tradeId: string, bobSk: string) {
  setStep(3, STEPS);
  show("step-3-body", "Waiting for attestation...");

  await pollStatus(tradeId, ["attested", "releasing", "completed"]);
  show("step-3-body", '<span class="info">✓ Attested</span>');
  showClaimForm(tradeId, bobSk);
}

async function showClaimForm(tradeId: string, bobSk: string) {
  setStep(4, STEPS);

  const trade = await getTrade(tradeId);
  const escrowAmount = trade.amount!;
  const invoiceAmount = escrowAmount - LENDASWAP_FEE_SATS;

  show(
    "step-4-body",
    `<p>You'll receive <strong>${invoiceAmount.toLocaleString()} sats</strong> via Lightning.</p>
     <label>Lightning invoice or Lightning address
       <input id="ln-dest" placeholder="lnbc… / user@wallet.com" />
     </label>
     <p style="margin-top:0.3rem; font-size:0.85rem; opacity:0.7">
       BOLT11 invoice must be for exactly ${invoiceAmount.toLocaleString()} sats.
       Lightning addresses resolve automatically.
     </p>
     <button id="btn-claim">Claim via Lightning →</button>
     <div id="claim-err" class="error"></div>`,
  );

  $("btn-claim").addEventListener("click", async () => {
    const raw = ($("ln-dest") as HTMLInputElement).value.trim();
    const parsed = classifyInput(raw);
    if (!parsed) {
      show(
        "claim-err",
        "Paste a BOLT11 invoice or Lightning address (user@domain)",
      );
      return;
    }
    ($("btn-claim") as HTMLButtonElement).disabled = true;
    show("claim-err", "");

    try {
      await doClaim(tradeId, bobSk, toSwapOptions(parsed, invoiceAmount));
    } catch (e: any) {
      show("claim-err", e.message);
      ($("btn-claim") as HTMLButtonElement).disabled = false;
    }
  });
}

async function doClaim(
  tradeId: string,
  bobSk: string,
  swapOptions: { lightningInvoice?: string; lightningAddress?: string; amountSats?: number },
) {
  // 1. Create Arkade→Lightning swap to get a VHTLC destination
  show("claim-err", "");
  showProgress("Creating Lightning swap...");
  const lsClient = await buildLendaswapClient();
  const swap = await lsClient.createArkadeToLightningSwap(swapOptions);
  const vhtlcAddress = swap.response.arkade_vhtlc_address;
  const swapId = swap.response.id;

  // 2. Release escrow to the VHTLC address
  showProgress("Requesting release from server...");
  const release = await api("POST", `/trades/${tradeId}/release`, {
    bob_dest_address: vhtlcAddress,
  });

  // 3. Sign ark_tx
  showProgress("Signing transaction...");
  const { signedPsbt: signedArkTx, txid: arkTxid } = signEscrowArkTx(
    release.ark_tx_psbt,
    bobSk,
  );

  // 4. Submit
  showProgress("Submitting to Arkade...");
  const submitted = await api("POST", `/trades/${tradeId}/release/submit`, {
    signed_ark_tx: signedArkTx,
  });

  // 5. Sign checkpoints
  showProgress("Signing checkpoints...");
  const signedCheckpoints = signEscrowCheckpoints(
    submitted.checkpoint_psbts,
    bobSk,
  );

  // 6. Finalize
  showProgress("Finalizing release...");

  await api("POST", `/trades/${tradeId}/release/finalize`, {
    signed_checkpoint_psbts: signedCheckpoints,
    ark_txid: arkTxid,
  });

  show(
    "step-4-body",
    `<span class="info">✓ Escrow released to swap VHTLC — tx: ${txLink(arkTxid)}</span>`,
  );

  // 7. Wait for lendaswap to complete the Lightning payment
  await waitForLightningPayment(lsClient, swapId);
}

/** Show progress text below the claim form without destroying the inputs. */
function showProgress(text: string) {
  const err = document.getElementById("claim-err");
  if (err) {
    err.innerHTML = `<span style="color:inherit">${text}</span>`;
  }
}

async function waitForLightningPayment(lsClient: Client, swapId: string) {
  setStep(5, STEPS);
  show("step-5-body", "Waiting for Lightning payment...");

  const DONE = ["serverredeemed"];
  const TERMINAL_FAIL = [
    "expired",
    "clientrefunded",
    "clientfundedserverrefunded",
    "clientrefundedserverrefunded",
    "clientinvalidfunded",
  ];

  for (let i = 0; ; i++) {
    let swap;
    try {
      swap = await lsClient.getSwap(swapId, { updateStorage: true });
    } catch (e: any) {
      showRetryError("step-5-body", `Polling error: ${e.message}`, () =>
        waitForLightningPayment(lsClient, swapId),
      );
      return;
    }
    const status = swap.status;

    if (DONE.includes(status)) {
      show(
        "step-5-body",
        '<span class="info">✓ Lightning invoice paid! Trade complete.</span>',
      );
      return;
    }

    if (TERMINAL_FAIL.includes(status)) {
      showRetryError(
        "step-5-body",
        `Swap failed: ${status}`,
        () => waitForLightningPayment(lsClient, swapId),
      );
      return;
    }

    const label =
      status === "clientfunded"
        ? "VHTLC funded, server processing..."
        : status === "clientredeemed" || status === "serverfunded"
          ? "Lightning payment in progress..."
          : `Waiting for swap to complete... (${status})`;
    show("step-5-body", label);
    await sleep(3000);
  }
}

/** Show an error with a retry button that re-runs the callback. */
function showRetryError(
  elementId: string,
  message: string,
  onRetry: () => void,
) {
  show(
    elementId,
    `<span class="error">${message}</span>
     <br/><button id="btn-retry" style="margin-top:0.5rem">Retry</button>`,
  );
  $("btn-retry").addEventListener("click", () => {
    $("btn-retry").remove();
    onRetry();
  });
}

main();
