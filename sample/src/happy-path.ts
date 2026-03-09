/**
 * Happy-path demo: Alice escrows BTC on Arkade, Bob receives it after
 * HodlHodl attests the ERC20 transfer.
 *
 * Prerequisites:
 *   1. Arkade regtest server running at localhost:7070
 *   2. HodlHodl mock server running at localhost:4567
 *   3. Alice has funded the escrow address (e.g. via boarding + send)
 *
 * Usage:
 *   ALICE_SK=<hex> BOB_SK=<hex> pnpm happy-path
 */

import {
  SingleKey,
  DefaultVtxo,
  RestArkProvider,
  Transaction,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

// --- Config ---

const HODLHODL_URL = process.env.HODLHODL_URL ?? "http://localhost:4567";
const ARKADE_URL = process.env.ARKADE_URL ?? "http://localhost:7070";
const ALICE_SK = process.env.ALICE_SK;
const BOB_SK = process.env.BOB_SK;

if (!ALICE_SK || !BOB_SK) {
  console.error(
    "Set ALICE_SK and BOB_SK environment variables (hex-encoded secret keys)",
  );
  process.exit(1);
}

// --- Helpers ---

async function hodlhodl(
  method: string,
  path: string,
  body?: object,
): Promise<any> {
  const res = await fetch(`${HODLHODL_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HodlHodl ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

function b64toBytes(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}

// --- Main ---

async function main() {
  console.log("=== Escrow Happy Path ===\n");

  // Derive public keys using @arkade-os/sdk SingleKey
  const aliceKey = SingleKey.fromHex(ALICE_SK);
  const bobKey = SingleKey.fromHex(BOB_SK);

  const alicePk = await aliceKey.xOnlyPublicKey();
  const bobPk = await bobKey.xOnlyPublicKey();
  const alicePkHex = hex.encode(alicePk);
  const bobPkHex = hex.encode(bobPk);

  console.log(`Alice PK: ${alicePkHex}`);
  console.log(`Bob PK:   ${bobPkHex}\n`);

  // 1. Create trade
  console.log("1. Creating trade...");
  const trade = await hodlhodl("POST", "/trades", {
    alice_pk: alicePkHex,
    bob_pk: bobPkHex,
  });
  console.log(`   Trade ID: ${trade.trade_id}`);
  console.log(`   Escrow Address: ${trade.escrow_address}\n`);

  // 2. Alice funds the escrow
  console.log("2. Waiting for Alice to fund the escrow...");
  console.log(`   Send BTC to: ${trade.escrow_address}`);
  console.log("   Press Enter once funded...");
  await waitForEnter();

  // 3. Confirm funding
  console.log("3. Confirming funding...");
  const funded = await hodlhodl("POST", `/trades/${trade.trade_id}/fund`);
  console.log(`   Status: ${funded.status}, Amount: ${funded.amount} sats\n`);

  // 4. Attest ERC20 transfer (simulated)
  console.log("4. Attesting ERC20 transfer...");
  await hodlhodl("POST", `/trades/${trade.trade_id}/attest`);
  console.log(`   Status: attested\n`);

  // 5. Build release — get PSBT for Bob to sign
  console.log("5. Building release transaction...");

  // Bob's destination: a default VTXO address
  const arkProvider = new RestArkProvider(ARKADE_URL);
  const serverInfo = await arkProvider.getInfo();
  const serverPk = hex.decode(serverInfo.pubkey);
  const bobVtxo = new DefaultVtxo(bobPk, serverPk, serverInfo.unilateralExitDelay);
  const bobDestAddress = bobVtxo.address("tark", serverPk).encode();
  console.log(`   Bob destination: ${bobDestAddress}`);

  const release = await hodlhodl(
    "POST",
    `/trades/${trade.trade_id}/release`,
    { bob_dest_address: bobDestAddress },
  );
  console.log(`   Status: ${release.status}`);
  console.log(
    `   Got ark_tx PSBT and ${release.checkpoint_psbts.length} checkpoint(s)\n`,
  );

  // 6. Bob signs the ark_tx PSBT
  console.log("6. Bob signing ark_tx...");
  const bobSk = hex.decode(BOB_SK);
  const arkTx = Transaction.fromPSBT(b64toBytes(release.ark_tx_psbt));
  arkTx.signIdx(bobSk, 0);
  const bobSignedArkTx = bytesToB64(arkTx.toPSBT());
  console.log("   Signed!\n");

  // 7. Submit Bob's signed PSBT to HodlHodl → Arkade
  console.log("7. Submitting to Arkade...");
  const submitted = await hodlhodl(
    "POST",
    `/trades/${trade.trade_id}/release/submit`,
    { signed_ark_tx: bobSignedArkTx },
  );
  console.log(
    `   Got ${submitted.checkpoint_psbts.length} server-signed checkpoint(s)\n`,
  );

  // 8. Bob signs checkpoint PSBTs
  console.log("8. Bob signing checkpoints...");
  const bobSignedCheckpoints = submitted.checkpoint_psbts.map(
    (cpB64: string) => {
      const cpTx = Transaction.fromPSBT(b64toBytes(cpB64));
      cpTx.signIdx(bobSk, 0);
      return bytesToB64(cpTx.toPSBT());
    },
  );
  console.log("   Signed!\n");

  // 9. Finalize
  console.log("9. Finalizing...");
  const arkTxForId = Transaction.fromPSBT(b64toBytes(release.ark_tx_psbt));
  const arkTxid = hex.encode(arkTxForId.id!);

  const finalized = await hodlhodl(
    "POST",
    `/trades/${trade.trade_id}/release/finalize`,
    {
      signed_checkpoint_psbts: bobSignedCheckpoints,
      ark_txid: arkTxid,
    },
  );
  console.log(`   Status: ${finalized.status}\n`);

  console.log("=== Trade completed! Bob received the BTC. ===");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
