import { api, $, setStep, show, pollStatus, getTrade, generateKeypair, addressLink } from "./common";
import { Transaction } from "@arkade-os/sdk";
import { hex } from "@scure/base";
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

async function main() {
  // Generate Bob's keypair on load
  const { sk: bobSk, pk: bobPk } = await generateKeypair();
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
      show("step-1-body", `<span class="info">✓ Joined trade ${tradeId.slice(0, 8)}…</span>`);
      waitForFunding(tradeId, bobSk, trade);
    } catch (e: any) {
      show("join-err", e.message);
      btnJoin.disabled = false;
    }
  });
}

async function waitForFunding(tradeId: string, bobSk: string, trade: any) {
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
    `<label>Destination address (Ark)
       <input id="dest-addr" placeholder="tark1q..." />
     </label>
     <br/>
     <button id="btn-claim">Claim →</button>
     <div id="claim-err" class="error"></div>`,
  );

  $("btn-claim").addEventListener("click", () => {
    const dest = ($("dest-addr") as HTMLInputElement).value.trim();
    if (!dest || !dest.startsWith("tark")) {
      show("claim-err", "Enter a valid Ark address");
      return;
    }
    ($("btn-claim") as HTMLButtonElement).disabled = true;
    show("claim-err", "");
    doClaim(tradeId, bobSk, dest);
  });
}

async function doClaim(tradeId: string, bobSk: string, bobDest: string) {
  try {
    // 1. Request release
    show("step-4-body", "Requesting release from server...");
    const release = await api("POST", `/trades/${tradeId}/release`, {
      bob_dest_address: bobDest,
    });

    // 2. Sign ark_tx
    show("step-4-body", "Signing transaction...");
    const sk = hex.decode(bobSk);
    const arkTx = Transaction.fromPSBT(b64(release.ark_tx_psbt));
    arkTx.signIdx(sk, 0);
    const signedArkTx = toB64(arkTx.toPSBT());

    // 3. Submit
    show("step-4-body", "Submitting to Arkade...");
    const submitted = await api(
      "POST",
      `/trades/${tradeId}/release/submit`,
      { signed_ark_tx: signedArkTx },
    );

    // 4. Sign checkpoints
    show("step-4-body", "Signing checkpoints...");
    const signedCheckpoints = submitted.checkpoint_psbts.map(
      (cpB64: string) => {
        const cpTx = Transaction.fromPSBT(b64(cpB64));
        cpTx.signIdx(sk, 0);
        return toB64(cpTx.toPSBT());
      },
    );

    // 5. Finalize
    show("step-4-body", "Finalizing...");
    const arkTxForId = Transaction.fromPSBT(b64(release.ark_tx_psbt));
    const txId = arkTxForId.id;
    const arkTxid =
      txId instanceof Uint8Array ? hex.encode(txId) : String(txId);

    await api("POST", `/trades/${tradeId}/release/finalize`, {
      signed_checkpoint_psbts: signedCheckpoints,
      ark_txid: arkTxid,
    });

    show(
      "step-4-body",
      '<span class="info">✓ Signed and finalized</span>',
    );

    // Done
    setStep(5, STEPS);
    show(
      "step-5-body",
      `<span class="info">✓ Funds released to ${addressLink(bobDest)}</span>`,
    );
  } catch (e: any) {
    show("step-4-body", `<span class="error">Error: ${e.message}</span>`);
  }
}

main();
