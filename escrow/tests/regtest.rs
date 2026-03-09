//! Integration test: escrow happy-path against a running Arkade regtest stack.
//!
//! Prerequisites:
//!   - nigiri (bitcoin regtest + esplora)
//!   - arkd on localhost:7070
//!   - fulmine wallet on localhost:7001 (funded, ~420k sats)
//!
//! Run: cargo test --test regtest -- --nocapture

use anyhow::{Context, Result};
use ark_core::server::GetVtxosRequest;
use ark_core::{Vtxo, VtxoList};
use ark_escrow::client::EscrowClient;
use ark_escrow::contract::{EscrowContract, EscrowOptions};
use ark_escrow::spend;
use bitcoin::key::Keypair;
use bitcoin::secp256k1::Secp256k1;
use bitcoin::{Amount, Network, XOnlyPublicKey};
use std::time::Duration;

const ARKADE_URL: &str = "http://localhost:7070";
const FULMINE_URL: &str = "http://localhost:7001";
const ESCROW_AMOUNT_SATS: u64 = 10_000;

/// Send BTC from the fulmine wallet to an ark address via offchain send.
async fn fulmine_send(address: &str, amount_sats: u64) -> Result<String> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{FULMINE_URL}/api/v1/send/offchain"))
        .json(&serde_json::json!({
            "address": address,
            "amount": amount_sats,
        }))
        .send()
        .await
        .context("fulmine send request")?;

    let status = res.status();
    let body: serde_json::Value = res.json().await.context("fulmine response body")?;

    if !status.is_success() {
        anyhow::bail!("fulmine send failed ({}): {}", status, body);
    }

    let txid = body["txid"]
        .as_str()
        .context("missing txid in fulmine response")?
        .to_string();

    Ok(txid)
}

/// Wait for a VTXO to appear at an address.
async fn wait_for_vtxo(
    client: &EscrowClient,
    contract: &EscrowContract,
    timeout: Duration,
) -> Result<spend::EscrowVtxo> {
    let start = std::time::Instant::now();
    loop {
        if let Some(vtxo) = client.find_escrow_vtxo(contract).await? {
            return Ok(vtxo);
        }
        if start.elapsed() > timeout {
            anyhow::bail!("timed out waiting for escrow VTXO");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Wait for a VTXO to appear at a default address.
async fn wait_for_balance(
    grpc: &ark_grpc::Client,
    dust: Amount,
    vtxo: &Vtxo,
    timeout: Duration,
) -> Result<Amount> {
    let start = std::time::Instant::now();
    loop {
        let request = GetVtxosRequest::new_for_addresses(std::iter::once(vtxo.to_ark_address()));
        let response = grpc.list_vtxos(request).await?;
        let vtxo_list = VtxoList::new(dust, response.vtxos);
        let balance = vtxo_list
            .spendable_offchain()
            .fold(Amount::ZERO, |acc, v| acc + v.amount);
        if balance > Amount::ZERO {
            return Ok(balance);
        }
        if start.elapsed() > timeout {
            anyhow::bail!("timed out waiting for balance at {}", vtxo.to_ark_address());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn escrow_happy_path() -> Result<()> {
    let secp = Secp256k1::new();
    let mut rng = bitcoin::secp256k1::rand::thread_rng();

    // --- Setup: connect to Arkade ---
    let mut escrow_client = EscrowClient::new(ARKADE_URL);
    let server_info = escrow_client.connect().await?;
    let server_pk = server_info.signer_pk.x_only_public_key().0;
    let dust = server_info.dust;
    let exit_delay = server_info.unilateral_exit_delay;

    println!("Connected to Arkade. Server PK: {server_pk}");

    // --- Create keypairs ---
    let arbiter_kp = Keypair::new(&secp, &mut rng);
    let bob_kp = Keypair::new(&secp, &mut rng);
    // Alice is the fulmine wallet — we don't need her keypair for the release flow.

    let arbiter_pk = arbiter_kp.x_only_public_key().0;
    let bob_pk = bob_kp.x_only_public_key().0;

    // Use fulmine's public key as Alice
    let fulmine_pk_hex = get_fulmine_pubkey().await?;
    let fulmine_pk_bytes: [u8; 33] =
        bitcoin::hex::FromHex::from_hex(&fulmine_pk_hex).context("parse fulmine pk")?;
    let fulmine_pk =
        bitcoin::PublicKey::from_slice(&fulmine_pk_bytes).context("parse fulmine compressed pk")?;
    let alice_pk: XOnlyPublicKey = fulmine_pk.inner.into();

    println!("Alice PK (fulmine): {alice_pk}");
    println!("Bob PK:             {bob_pk}");
    println!("Arbiter PK:         {arbiter_pk}");

    // --- Create escrow contract ---
    let contract = EscrowContract::new(
        EscrowOptions {
            alice: alice_pk,
            bob: bob_pk,
            arbiter: arbiter_pk,
            server: server_pk,
            unilateral_exit_delay: exit_delay,
        },
        Network::Regtest,
    )?;

    let escrow_addr = contract.address();
    println!("Escrow address: {escrow_addr}");

    // --- Fund the escrow via fulmine ---
    println!("Sending {ESCROW_AMOUNT_SATS} sats from fulmine to escrow...");
    let fund_txid = fulmine_send(&escrow_addr.to_string(), ESCROW_AMOUNT_SATS).await?;
    println!("Fund txid: {fund_txid}");

    // Wait for the escrow VTXO to appear
    println!("Waiting for escrow VTXO...");
    let escrow_vtxo = wait_for_vtxo(&escrow_client, &contract, Duration::from_secs(30)).await?;
    println!(
        "Escrow VTXO found: outpoint={}, amount={} sats",
        escrow_vtxo.outpoint,
        escrow_vtxo.amount.to_sat()
    );

    // --- Build Bob's destination address ---
    let bob_dest_vtxo = Vtxo::new_default(&secp, server_pk, bob_pk, exit_delay, Network::Regtest)?;
    let bob_dest = bob_dest_vtxo.to_ark_address();
    println!("Bob destination: {bob_dest}");

    // --- Build release tx ---
    println!("Building release transaction...");
    let release = spend::build_release_tx(
        &contract,
        &escrow_vtxo,
        &bob_dest,
        None, // no fee for test
        escrow_client.server_info()?,
    )?;

    let ark_txid = release.ark_tx.unsigned_tx.compute_txid();
    println!("Ark txid: {ark_txid}");

    // --- Sign ark_tx: arbiter + Bob ---
    let mut arbiter_psbt = release.ark_tx.clone();
    spend::sign_ark_tx(&mut arbiter_psbt, &arbiter_kp)?;
    println!("Arbiter signed ark_tx");

    let mut bob_psbt = release.ark_tx.clone();
    spend::sign_ark_tx(&mut bob_psbt, &bob_kp)?;
    println!("Bob signed ark_tx");

    // Merge signatures
    spend::merge_ark_tx_sigs(&mut arbiter_psbt, &bob_psbt)?;
    println!("Merged ark_tx signatures");

    // --- Submit to Arkade ---
    println!("Submitting to Arkade...");
    let submit_result = escrow_client
        .submit(arbiter_psbt, release.checkpoint_txs.clone())
        .await?;
    println!(
        "Server returned {} signed checkpoint(s)",
        submit_result.signed_checkpoint_txs.len()
    );

    // --- Sign checkpoints: arbiter + Bob ---
    let mut final_checkpoints = Vec::new();
    for mut checkpoint in submit_result.signed_checkpoint_txs {
        // Arbiter signs
        spend::sign_checkpoint(&mut checkpoint, &arbiter_kp)?;
        // Bob signs
        spend::sign_checkpoint(&mut checkpoint, &bob_kp)?;
        final_checkpoints.push(checkpoint);
    }
    println!("Signed {} checkpoint(s)", final_checkpoints.len());

    // --- Finalize ---
    println!("Finalizing...");
    escrow_client.finalize(ark_txid, final_checkpoints).await?;
    println!("Finalized!");

    // --- Verify Bob received the funds ---
    println!("Waiting for Bob's balance...");
    let bob_balance = wait_for_balance(
        escrow_client.grpc(),
        dust,
        &bob_dest_vtxo,
        Duration::from_secs(30),
    )
    .await?;
    println!("Bob's balance: {} sats", bob_balance.to_sat());

    assert_eq!(
        bob_balance.to_sat(),
        escrow_vtxo.amount.to_sat(),
        "Bob should have received the full escrow amount"
    );

    println!("\n=== Escrow happy path completed successfully! ===");
    Ok(())
}

async fn get_fulmine_pubkey() -> Result<String> {
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{FULMINE_URL}/api/v1/address"))
        .send()
        .await?;
    let body: serde_json::Value = res.json().await?;
    body["pubkey"]
        .as_str()
        .map(|s| s.to_string())
        .context("missing pubkey in fulmine response")
}
