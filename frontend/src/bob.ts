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
  updateRecovery,
  recoveryButtonHtml,
  attachRecoveryCopyButton,
} from "./common";
import {
  signEscrowArkTx,
  signEscrowCheckpoints,
  signEscrowDelegate as signEscrowRefresh,
  Client,
  InMemorySwapStorage,
  InMemoryWalletStorage,
} from "@satora/swap";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import "./style.css";

const STEPS = 5;

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
  sourceAmountSats: number,
  targetAmountSats: number,
): {
  lightningInvoice?: string;
  lightningAddress?: string;
  sourceAmountSats?: number;
  targetAmountSats?: number;
} {
  if (input.type === "bolt11") {
    return { lightningInvoice: input.invoice, targetAmountSats };
  }
  return { lightningAddress: input.address, sourceAmountSats };
}

function toRetryOptions(
  input: LnInput,
): { lightningInvoice?: string; lightningAddress?: string } {
  if (input.type === "bolt11") {
    return { lightningInvoice: input.invoice };
  }
  return { lightningAddress: input.address };
}

function parseSats(value: unknown, name: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return amount;
}

function bolt11AmountSats(invoice: string): number {
  const decoded = decodeBolt11(invoice);
  const amount = decoded.sections.find((section) => section.name === "amount");
  if (!amount || amount.name !== "amount") {
    throw new Error("BOLT11 invoice must include an amount");
  }

  const msats = BigInt(amount.value);
  if (msats % 1000n !== 0n) {
    throw new Error("BOLT11 invoice amount must be an exact satoshi amount");
  }

  const sats = msats / 1000n;
  if (sats <= 0n || sats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid BOLT11 invoice amount");
  }
  return Number(sats);
}

function validateBolt11Amount(input: LnInput, expectedSats: number) {
  if (input.type !== "bolt11") return;

  const invoiceSats = bolt11AmountSats(input.invoice);
  if (invoiceSats !== expectedSats) {
    throw new Error(
      `BOLT11 invoice amount is ${invoiceSats.toLocaleString()} sats, expected ${expectedSats.toLocaleString()} sats`,
    );
  }
}

function releaseDelayMs(): number {
  const raw = new URLSearchParams(window.location.search).get("releaseDelayMs");
  const delay = raw ? Number(raw) : 0;
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
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
      updateRecovery(tradeId, {
        role: "bob",
        bobPk,
        tradeStatus: trade.status,
        escrowAddress: trade.escrow_address,
        escrowOutpoint: trade.escrow_outpoint,
        escrowAmount: trade.amount,
      });
      show(
        "step-1-body",
        `<span class="info">✓ Joined trade ${tradeId.slice(0, 8)}…</span><br/>${recoveryButtonHtml("btn-copy-recovery-join")}`,
      );
      attachRecoveryCopyButton("btn-copy-recovery-join", tradeId);
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

  await pollStatus(tradeId, ["funded", "attested", "refreshing_escrow", "releasing_offchain", "completed"]);
  const fundedTrade = await getTrade(tradeId);
  const fundTxid = fundedTrade.escrow_outpoint?.split(":")[0];
  const txInfo = fundTxid ? ` — tx: ${txLink(fundTxid)}` : "";
  updateRecovery(tradeId, {
    tradeStatus: fundedTrade.status,
    escrowAddress: fundedTrade.escrow_address,
    escrowOutpoint: fundedTrade.escrow_outpoint,
    escrowAmount: fundedTrade.amount,
    releasableAmount: fundedTrade.releasable_amount,
    releaseMode: fundedTrade.release_mode,
  });
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

  await pollStatus(tradeId, ["attested", "refreshing_escrow", "releasing_offchain", "completed"]);
  show("step-3-body", '<span class="info">✓ Attested</span>');
  showClaimForm(tradeId, bobSk);
}

async function showClaimForm(tradeId: string, bobSk: string) {
  setStep(4, STEPS);

  const trade = await getTrade(tradeId);
  if (trade.releasable_amount == null) {
    throw new Error("Trade is not ready to quote a releasable amount yet");
  }
  const sourceAmount = parseSats(trade.releasable_amount, "releasable amount");

  // Quote the swap to find the actual Lightning amount after Boltz fees.
  // releasable_amount is the SOURCE (what funds the VHTLC), not the target.
  const quoteRes = await fetch(
    `${LENDASWAP_URL}/quote?source_chain=Arkade&source_token=btc&target_chain=Lightning&target_token=btc&source_amount=${sourceAmount}`,
  );
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status}`);
  const quote = await quoteRes.json();

  const targetAmount = parseSats(quote.net_target_amount, "quote amount");

  const mustRefresh = trade.release_mode === "refresh";
  const refreshNote = mustRefresh
    ? "Escrow refresh is required before claim."
    : "Optional: useful for manually testing the refresh flow.";

  show(
    "step-4-body",
    `<p>Escrow release: <strong>${sourceAmount.toLocaleString()} sats</strong></p>
     <p>You'll receive <strong>${targetAmount.toLocaleString()} sats</strong> via Lightning (after swap fees).</p>
     <label>Lightning invoice or Lightning address
       <input id="ln-dest" placeholder="lnbc… / user@wallet.com" />
     </label>
     <label class="checkbox-option">
       <input id="refresh-before-claim" type="checkbox" ${mustRefresh ? "checked disabled" : ""} />
       <span><strong>Refresh escrow before claim</strong><small>${refreshNote}</small></span>
     </label>
     <p style="margin-top:0.3rem; font-size:0.85rem; opacity:0.7">
       BOLT11 invoice must be for exactly ${targetAmount.toLocaleString()} sats.
       Lightning addresses resolve automatically.
     </p>
     <button id="btn-claim">Claim via Lightning →</button>
     ${recoveryButtonHtml("btn-copy-recovery-claim")}
     <div id="claim-err" class="error"></div>`,
  );

  attachRecoveryCopyButton("btn-copy-recovery-claim", tradeId);

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
      validateBolt11Amount(parsed, targetAmount);
      const refreshBeforeClaim = ($("refresh-before-claim") as HTMLInputElement).checked;
      await doClaim(
        tradeId,
        bobSk,
        toSwapOptions(parsed, sourceAmount, targetAmount),
        refreshBeforeClaim,
      );
    } catch (e: any) {
      show("claim-err", e.message);
      ($("btn-claim") as HTMLButtonElement).disabled = false;
    }
  });
}

async function doClaim(
  tradeId: string,
  bobSk: string,
  swapOptions: {
    lightningInvoice?: string;
    lightningAddress?: string;
    sourceAmountSats?: number;
    targetAmountSats?: number;
  },
  refreshBeforeClaim: boolean,
) {
  show("claim-err", "");

  // 1. If needed, refresh the escrow before creating the Lightning swap. This
  // avoids starting the swap/VHTLC timer while the refresh batch is running.
  await refreshEscrowIfNeeded(tradeId, bobSk, refreshBeforeClaim);

  // 2. Create Arkade→Lightning swap to get a VHTLC destination.
  showProgress("Creating Lightning swap...");
  const lsClient = await buildLendaswapClient();
  const lendaswapMnemonic = lsClient.getMnemonic();
  const swap = await lsClient.createArkadeToLightningSwap(swapOptions);
  const vhtlcAddress = swap.response.arkade_vhtlc_address;
  const swapId = swap.response.id;
  updateRecovery(tradeId, {
    bobLendaswapMnemonic: lendaswapMnemonic,
    bobSwap: {
      direction: "arkade_to_lightning",
      swapId,
      swapOptions,
      vhtlcAddress,
      response: swap.response,
    },
  });

  const delayMs = releaseDelayMs();
  if (delayMs > 0) {
    showProgress(
      `Debug: waiting ${Math.round(delayMs / 1000)}s before funding the VHTLC...`,
    );
    await sleep(delayMs);
  }

  // 3. Release the now-spendable escrow to the VHTLC address.
  let arkTxid: string;
  try {
    arkTxid = await releaseEscrowToVhtlc(tradeId, vhtlcAddress, bobSk);
  } catch (e: any) {
    await handleReleaseFailure(lsClient, tradeId, swapId, e);
    return;
  }

  show(
    "step-4-body",
    `<span class="info">✓ Escrow released to swap VHTLC — tx: ${txLink(arkTxid)}</span>`,
  );

  // 4. Wait for lendaswap to complete the Lightning payment
  await waitForLightningPayment(lsClient, tradeId, swapId);
}

async function handleReleaseFailure(
  lsClient: Client,
  tradeId: string,
  swapId: string,
  error: any,
) {
  let swap;
  try {
    swap = await lsClient.getSwap(swapId, { updateStorage: true });
  } catch {
    throw error;
  }

  if (isRetryableArkadeLightningFailure(swap.status)) {
    await showArkadeLightningRetryForm(lsClient, tradeId, swapId, swap.status);
    return;
  }

  throw error;
}

async function refreshEscrowIfNeeded(
  tradeId: string,
  bobSk: string,
  refreshBeforeClaim: boolean,
) {
  const trade = await getTrade(tradeId);
  if (trade.release_mode !== "refresh" && !refreshBeforeClaim) return;

  showProgress("Preparing escrow refresh...");
  const refresh = await api("POST", `/trades/${tradeId}/refresh-bob`);
  updateRecovery(tradeId, {
    tradeStatus: "refreshing_escrow",
    refreshStartedAt: new Date().toISOString(),
  });

  showProgress("Signing refresh PSBTs...");
  const { signedIntentProof, signedForfeitPsbts } = await signEscrowRefresh(
    refresh.intent_proof_psbt,
    refresh.forfeit_psbts,
    bobSk,
  );

  showProgress("Refreshing escrow via Arkade batch (this may take ~30s)...");
  await api("POST", `/trades/${tradeId}/refresh-bob/sign`, {
    signed_intent_proof: signedIntentProof,
    signed_forfeit_psbts: signedForfeitPsbts,
  });

  const refreshedTrade = await getTrade(tradeId);
  updateRecovery(tradeId, {
    tradeStatus: refreshedTrade.status,
    escrowOutpoint: refreshedTrade.escrow_outpoint,
    escrowAmount: refreshedTrade.amount,
  });
  showProgress("Escrow refreshed.");
}

async function releaseEscrowToVhtlc(
  tradeId: string,
  vhtlcAddress: string,
  bobSk: string,
): Promise<string> {
  showProgress("Requesting release from server...");
  const release = await api("POST", `/trades/${tradeId}/release`, {
    bob_dest_address: vhtlcAddress,
  });
  updateRecovery(tradeId, {
    releaseStartedAt: new Date().toISOString(),
    releaseDestination: vhtlcAddress,
  });

  if (release.mode !== "offchain") {
    throw new Error(`Unexpected release mode: ${release.mode}`);
  }

  showProgress("Signing transactions...");
  const { signedPsbt: signedArkTx, txid: arkTxid } = signEscrowArkTx(
    release.ark_tx_psbt,
    bobSk,
  );
  const signedCheckpoints = signEscrowCheckpoints(
    release.checkpoint_psbts,
    bobSk,
  );

  showProgress("Submitting to Arkade...");
  await api("POST", `/trades/${tradeId}/release/sign`, {
    signed_ark_tx: signedArkTx,
    signed_checkpoints: signedCheckpoints,
  });

  updateRecovery(tradeId, { releaseTxid: arkTxid, tradeStatus: "completed" });
  return arkTxid;
}

/** Show progress text below the claim form without destroying the inputs. */
function showProgress(text: string) {
  const err = document.getElementById("claim-err");
  if (err) {
    err.innerHTML = `<span style="color:inherit">${text}</span>`;
  }
}

async function waitForLightningPayment(
  lsClient: Client,
  tradeId: string,
  swapId: string,
) {
  setStep(5, STEPS);
  show("step-5-body", "Waiting for Lightning payment...");

  const DONE = ["serverredeemed"];
  const TERMINAL_FAIL = [
    "expired",
    "serverwontfund",
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
        waitForLightningPayment(lsClient, tradeId, swapId),
      );
      return;
    }
    const status = swap.status;

    if (DONE.includes(status)) {
      updateRecovery(tradeId, {
        bobSwapStatus: status,
        tradeStatus: "completed",
      });
      show(
        "step-5-body",
        '<span class="info">✓ Lightning invoice paid! Trade complete.</span>',
      );
      return;
    }

    if (TERMINAL_FAIL.includes(status)) {
      if (isRetryableArkadeLightningFailure(status)) {
        await showArkadeLightningRetryForm(lsClient, tradeId, swapId, status);
        return;
      }

      showRetryError(
        "step-5-body",
        `Swap failed: ${status}`,
        () => waitForLightningPayment(lsClient, tradeId, swapId),
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

function isRetryableArkadeLightningFailure(status: string): boolean {
  return status === "serverwontfund" || status === "clientinvalidfunded";
}

async function showArkadeLightningRetryForm(
  lsClient: Client,
  tradeId: string,
  swapId: string,
  status: string,
) {
  setStep(5, STEPS);

  let expectedAmount: number | null = null;
  try {
    const oldSwap = await lsClient.getSwap(swapId, { updateStorage: true });
    const sourceAmount = Number((oldSwap as any).boltz_amount_sats);
    if (Number.isFinite(sourceAmount) && sourceAmount > 0) {
      const quote = await lsClient.getArkadeToLightningQuote(sourceAmount);
      expectedAmount = Number(quote.net_target_amount);
    }
  } catch {
    // The retry API still works with a Lightning address even if the quote fails.
  }

  const invoiceHint = expectedAmount
    ? `If using a BOLT11 invoice, generate it for exactly ${expectedAmount.toLocaleString()} sats.`
    : "If using a BOLT11 invoice, it must be for the retry quote amount. A Lightning address resolves automatically.";

  show(
    "step-5-body",
    `<span class="error">Lightning payment failed: ${status}</span>
     <p>The escrow funds are in the failed swap VHTLC. Retry with a new Lightning invoice or Lightning address.</p>
     <label>New Lightning invoice or Lightning address
       <input id="retry-ln-dest" placeholder="lnbc… / user@wallet.com" />
     </label>
     <p style="margin-top:0.3rem; font-size:0.85rem; opacity:0.7">${invoiceHint}</p>
     <button id="btn-retry-ln">Retry Lightning payment</button>
     ${recoveryButtonHtml("btn-copy-recovery-retry")}
     <div id="retry-ln-err" class="error"></div>`,
  );

  attachRecoveryCopyButton("btn-copy-recovery-retry", tradeId);

  $("btn-retry-ln").addEventListener("click", async () => {
    const raw = ($("retry-ln-dest") as HTMLInputElement).value.trim();
    const parsed = classifyInput(raw);
    if (!parsed) {
      show(
        "retry-ln-err",
        "Paste a BOLT11 invoice or Lightning address (user@domain)",
      );
      return;
    }

    const btn = $("btn-retry-ln") as HTMLButtonElement;
    btn.disabled = true;
    show("retry-ln-err", "Retrying swap...");

    try {
      const result = await lsClient.retryArkadeToLightningSwap(
        swapId,
        toRetryOptions(parsed),
      );
      updateRecovery(tradeId, {
        retryResult: result,
      });
      show(
        "retry-ln-err",
        `<span class="info">✓ Retried via refund tx ${txLink(result.refundTxId)}</span>`,
      );
      await waitForLightningPayment(lsClient, tradeId, result.newSwap.id);
    } catch (e: any) {
      show("retry-ln-err", e.message);
      btn.disabled = false;
    }
  });
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
