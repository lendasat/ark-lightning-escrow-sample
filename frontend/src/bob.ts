import {
  api,
  $,
  setStep,
  show,
  pollStatus,
  getTrade,
  getOrCreateKeypair,
  sleep,
  LENDASWAP_URL,
  ARKADE_URL,
} from "./common";
import { Transaction } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
  Client,
  InMemorySwapStorage,
  InMemoryWalletStorage,
} from "@lendasat/lendaswap-sdk-pure";
import "./style.css";

const STEPS = 5;

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function toB64(u: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin);
}

async function buildLendaswapClient(): Promise<Client> {
  return Client.builder()
    .withBaseUrl(LENDASWAP_URL)
    .withArkadeServerUrl(ARKADE_URL)
    .withSignerStorage(new InMemoryWalletStorage())
    .withSwapStorage(new InMemorySwapStorage())
    .build();
}

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
      waitForFunding(tradeId, bobSk, trade);
    } catch (e: any) {
      show("join-err", e.message);
      btnJoin.disabled = false;
    }
  });
}

async function waitForFunding(tradeId: string, bobSk: string, _trade: any) {
  setStep(2, STEPS);
  show("step-2-body", "Waiting for Alice to fund the escrow...");

  await pollStatus(tradeId, ["funded", "attested", "releasing", "completed"]);
  show("step-2-body", '<span class="info">✓ Escrow funded</span>');
  waitForAttestation(tradeId, bobSk);
}

async function waitForAttestation(tradeId: string, bobSk: string) {
  setStep(3, STEPS);
  show("step-3-body", "Waiting for attestation...");

  await pollStatus(tradeId, ["attested", "releasing", "completed"]);
  show("step-3-body", '<span class="info">✓ Attested</span>');
  signAndRelease(tradeId, bobSk);
}

async function signAndRelease(tradeId: string, bobSk: string) {
  setStep(4, STEPS);
  show(
    "step-4-body",
    `<label>Lightning invoice (BOLT11)
       <input id="ln-invoice" placeholder="lnbc..." />
     </label>
     <br/>
     <button id="btn-claim">Claim via Lightning →</button>
     <div id="claim-err" class="error"></div>`,
  );

  $("btn-claim").addEventListener("click", async () => {
    const invoice = ($("ln-invoice") as HTMLInputElement).value.trim();
    if (!invoice || !invoice.toLowerCase().startsWith("ln")) {
      show("claim-err", "Paste a valid BOLT11 Lightning invoice");
      return;
    }
    ($("btn-claim") as HTMLButtonElement).disabled = true;
    show("claim-err", "");

    try {
      await doClaim(tradeId, bobSk, invoice);
    } catch (e: any) {
      show(
        "step-4-body",
        `<span class="error">Error: ${e.message}</span>`,
      );
    }
  });
}

async function doClaim(
  tradeId: string,
  bobSk: string,
  lightningInvoice: string,
) {
  // 1. Create Arkade→Lightning swap to get a VHTLC destination
  show("step-4-body", "Creating Lightning swap...");
  const lsClient = await buildLendaswapClient();
  const swap = await lsClient.createArkadeToLightningSwap({
    lightningInvoice,
  });
  const vhtlcAddress = swap.response.arkade_vhtlc_address;
  const swapId = swap.response.id;

  // 2. Release escrow to the VHTLC address
  show("step-4-body", "Requesting release from server...");
  const release = await api("POST", `/trades/${tradeId}/release`, {
    bob_dest_address: vhtlcAddress,
  });

  // 3. Sign ark_tx
  show("step-4-body", "Signing transaction...");
  const sk = hex.decode(bobSk);
  const arkTx = Transaction.fromPSBT(b64(release.ark_tx_psbt));
  arkTx.signIdx(sk, 0);
  const signedArkTx = toB64(arkTx.toPSBT());

  // 4. Submit
  show("step-4-body", "Submitting to Arkade...");
  const submitted = await api("POST", `/trades/${tradeId}/release/submit`, {
    signed_ark_tx: signedArkTx,
  });

  // 5. Sign checkpoints
  show("step-4-body", "Signing checkpoints...");
  const signedCheckpoints = submitted.checkpoint_psbts.map((cpB64: string) => {
    const cpTx = Transaction.fromPSBT(b64(cpB64));
    cpTx.signIdx(sk, 0);
    return toB64(cpTx.toPSBT());
  });

  // 6. Finalize
  show("step-4-body", "Finalizing release...");
  const arkTxForId = Transaction.fromPSBT(b64(release.ark_tx_psbt));
  const txId = arkTxForId.id as unknown;
  const arkTxid =
    txId instanceof Uint8Array
      ? hex.encode(txId)
      : String(txId);

  await api("POST", `/trades/${tradeId}/release/finalize`, {
    signed_checkpoint_psbts: signedCheckpoints,
    ark_txid: arkTxid,
  });

  show(
    "step-4-body",
    '<span class="info">✓ Escrow released to swap VHTLC</span>',
  );

  // 7. Wait for lendaswap to complete the Lightning payment
  await waitForLightningPayment(lsClient, swapId);
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
  ];

  for (let i = 0; ; i++) {
    const swap = await lsClient.getSwap(swapId, { updateStorage: true });
    const status = swap.status;

    if (DONE.includes(status)) {
      show(
        "step-5-body",
        '<span class="info">✓ Lightning invoice paid! Trade complete.</span>',
      );
      return;
    }

    if (TERMINAL_FAIL.includes(status)) {
      show(
        "step-5-body",
        `<span class="error">Swap failed: ${status}</span>`,
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

main();
