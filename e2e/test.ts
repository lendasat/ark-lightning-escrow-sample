/**
 * Automated e2e test: TS client → Ruby/Magnus server → Rust escrow → Arkade
 *
 * Exercises the full stack:
 *   1. TS creates a trade via HodlHodl Ruby server
 *   2. Fulmine (Alice) funds the escrow address
 *   3. HodlHodl attests, builds release tx (Ruby → Rust → Arkade)
 *   4. Bob signs PSBTs using @arkade-os/sdk (TS)
 *   5. HodlHodl submits + finalizes (Ruby → Rust → Arkade)
 *   6. Verify Bob received the funds
 *
 * Env: HODLHODL_URL, ARKADE_URL, FULMINE_URL, BOB_SK
 */

import {
  SingleKey,
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  Transaction,
  ArkAddress,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const HODLHODL_URL = process.env.HODLHODL_URL ?? "http://localhost:4567";
const ARKADE_URL = process.env.ARKADE_URL ?? "http://localhost:7070";
const FULMINE_URL = process.env.FULMINE_URL ?? "http://localhost:7001";
const BOB_SK = process.env.BOB_SK;
const ESCROW_AMOUNT = 10_000; // sats

if (!BOB_SK) {
  console.error("BOB_SK is required (hex-encoded secret key)");
  process.exit(1);
}

// --- helpers ---

async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: object,
): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Try to extract error from JSON response
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(`${method} ${baseUrl}${path}: ${res.status} ${msg}`);
  }
  return JSON.parse(text);
}

const hodlhodl = (m: string, p: string, b?: object) => api(HODLHODL_URL, m, p, b);
const fulmine = (m: string, p: string, b?: object) => api(FULMINE_URL, m, p, b);

function b64(b: string): Uint8Array {
  return Buffer.from(b, "base64");
}
function toB64(u: Uint8Array): string {
  return Buffer.from(u).toString("base64");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- main ---

async function main() {
  console.log("=== E2E Test: TS → Ruby → Rust → Arkade ===\n");

  // Get fulmine (Alice) pubkey
  const fulmineAddr = await fulmine("GET", "/api/v1/address");
  const alicePkHex = fulmineAddr.pubkey;
  // fulmine returns compressed pk (02/03 + 32 bytes). Extract x-only.
  const aliceCompressed = hex.decode(alicePkHex);
  const aliceXonlyHex = hex.encode(aliceCompressed.slice(1));

  // Bob keypair
  const bobKey = SingleKey.fromHex(BOB_SK);
  const bobPk = await bobKey.xOnlyPublicKey();
  const bobPkHex = hex.encode(bobPk);

  console.log(`Alice PK (fulmine): ${aliceXonlyHex}`);
  console.log(`Bob PK:             ${bobPkHex}\n`);

  // 1. Create trade
  console.log("1. POST /trades");
  const trade = await hodlhodl("POST", "/trades", {
    alice_pk: aliceXonlyHex,
    bob_pk: bobPkHex,
  });
  console.log(`   trade_id=${trade.trade_id} address=${trade.escrow_address}\n`);

  // 2. Fund escrow via fulmine
  console.log(`2. Funding escrow with ${ESCROW_AMOUNT} sats via fulmine...`);
  const sendResult = await fulmine("POST", "/api/v1/send/offchain", {
    address: trade.escrow_address,
    amount: ESCROW_AMOUNT,
  });
  console.log(`   txid=${sendResult.txid}\n`);

  // 3. Confirm funding (retry — VTXO may take a moment to appear)
  console.log("3. POST /trades/:id/fund");
  let funded: any;
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(2000);
    try {
      funded = await hodlhodl("POST", `/trades/${trade.trade_id}/fund`);
      break;
    } catch (e: any) {
      if (attempt === 14) throw e;
      console.log(`   retry ${attempt + 1}...`);
    }
  }
  console.log(`   status=${funded.status} amount=${funded.amount}\n`);

  // 4. Attest
  console.log("4. POST /trades/:id/attest");
  const attested = await hodlhodl("POST", `/trades/${trade.trade_id}/attest`);
  console.log(`   status=${attested.status}\n`);

  // 5. Build release — Bob needs a destination address
  const arkProvider = new RestArkProvider(ARKADE_URL);
  const serverInfo = await arkProvider.getInfo();
  const serverXonly = hex.decode(serverInfo.signerPubkey).slice(1); // strip 03 prefix
  const bobXonly = bobPk; // reuse from earlier
  // unilateralExitDelay >= 512 → seconds (per Arkade convention)
  const exitDelay = serverInfo.unilateralExitDelay;
  const csvType = exitDelay >= 512n ? "seconds" : "blocks";
  const bobVtxo = new DefaultVtxo.Script({
    pubKey: bobXonly,
    serverPubKey: serverXonly,
    csvTimelock: { value: exitDelay, type: csvType },
  });
  const bobDest = new ArkAddress(serverXonly, bobVtxo.tweakedPublicKey, "tark").encode();

  console.log("5. POST /trades/:id/release");
  const release = await hodlhodl("POST", `/trades/${trade.trade_id}/release`, {
    bob_dest_address: bobDest,
  });
  console.log(
    `   status=${release.status} checkpoints=${release.checkpoint_psbts.length}\n`,
  );

  // 6. Bob signs the ark_tx PSBT
  console.log("6. Bob signs ark_tx...");
  const bobSk = hex.decode(BOB_SK);
  const arkTx = Transaction.fromPSBT(b64(release.ark_tx_psbt));
  arkTx.signIdx(bobSk, 0);
  const bobSignedArkTx = toB64(arkTx.toPSBT());
  console.log("   done\n");

  // 7. Submit
  console.log("7. POST /trades/:id/release/submit");
  const submitted = await hodlhodl(
    "POST",
    `/trades/${trade.trade_id}/release/submit`,
    { signed_ark_tx: bobSignedArkTx },
  );
  console.log(
    `   checkpoints=${submitted.checkpoint_psbts.length}\n`,
  );

  // 8. Bob signs checkpoints
  console.log("8. Bob signs checkpoints...");
  const bobSignedCheckpoints = submitted.checkpoint_psbts.map(
    (cpB64: string) => {
      const cpTx = Transaction.fromPSBT(b64(cpB64));
      cpTx.signIdx(bobSk, 0);
      return toB64(cpTx.toPSBT());
    },
  );
  console.log("   done\n");

  // Capture Bob's balance before finalizing
  const preIndexer = new RestIndexerProvider(ARKADE_URL);
  const bobPkScriptPre = hex.encode(bobVtxo.pkScript);
  const priorVtxos = await preIndexer.getVtxos({
    scripts: [bobPkScriptPre],
    spendableOnly: true,
  });
  const bobPriorBalance = priorVtxos.vtxos.reduce((sum, v) => sum + v.value, 0);

  // 9. Finalize
  console.log("9. POST /trades/:id/release/finalize");
  const arkTxForId = Transaction.fromPSBT(b64(release.ark_tx_psbt));
  const txId = arkTxForId.id;
  const arkTxid = txId instanceof Uint8Array ? hex.encode(txId) : String(txId);

  const finalized = await hodlhodl(
    "POST",
    `/trades/${trade.trade_id}/release/finalize`,
    {
      signed_checkpoint_psbts: bobSignedCheckpoints,
      ark_txid: arkTxid,
    },
  );
  console.log(`   status=${finalized.status}\n`);

  // 10. Verify Bob received funds
  console.log("10. Verifying Bob's balance...");
  const indexer = new RestIndexerProvider(ARKADE_URL);
  const bobPkScript = hex.encode(bobVtxo.pkScript);
  const priorBalance = bobPriorBalance; // captured before finalize

  // Wait for the new VTXO to appear
  let bobBalance = priorBalance;
  for (let i = 0; i < 15; i++) {
    const vtxos = await indexer.getVtxos({
      scripts: [bobPkScript],
      spendableOnly: true,
    });
    bobBalance = vtxos.vtxos.reduce((sum, v) => sum + v.value, 0);
    if (bobBalance > priorBalance) break;
    await sleep(2000);
  }

  const received = bobBalance - priorBalance;
  console.log(`   Bob received: ${received} sats (total: ${bobBalance})`);

  if (received !== ESCROW_AMOUNT) {
    throw new Error(
      `Expected Bob to receive ${ESCROW_AMOUNT} sats, got ${received}`,
    );
  }

  console.log("\n=== E2E TEST PASSED ===");
}

main().catch((err) => {
  console.error("\n=== E2E TEST FAILED ===");
  console.error(err);
  process.exit(1);
});
