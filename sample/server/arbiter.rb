# frozen_string_literal: true

# Arbiter server — orchestrates escrow trades using the ark_escrow gem.
#
# Trade states: created → funded → attested → releasing → completed

require "sinatra"
require "sinatra/json"
require "securerandom"
require "json"

# Load the native extension
ARK_ESCROW_DIR = ENV.fetch("ARK_ESCROW_DIR", File.expand_path("../../../../ark-escrow", __dir__))
$LOAD_PATH.unshift File.join(ARK_ESCROW_DIR, "ruby-ext", "lib")
require "ark_escrow"

# --- Configuration ---

ARKADE_URL = ENV.fetch("ARKADE_URL", "http://localhost:7070")
ARBITER_SK = ENV.fetch("ARBITER_SK") # hex-encoded secret key
NETWORK = ENV.fetch("NETWORK", "regtest")
SPEND_STORE_DIR = ENV.fetch("SPEND_STORE_DIR", "/tmp/ark-escrow-pending")

# Fee as percentage of escrow amount (e.g., "0.01" = 1%)
FEE_RATE = ENV.fetch("FEE_RATE", "0.01").to_f
# Arbiter's Arkade address for fee collection
FEE_ADDRESS = ENV.fetch("FEE_ADDRESS", nil)

# Delegate cosigner secret key — used for batch ceremony delegation.
# Defaults to a deterministic derivation from the arbiter key for simplicity.
# In production, derive via HD wallet (BIP-32).
DELEGATE_COSIGNER_SK = ENV.fetch("DELEGATE_COSIGNER_SK", ARBITER_SK)

# Force delegate settlement even when VTXOs are spendable (for testing).
FORCE_DELEGATE = ENV.fetch("FORCE_DELEGATE", "0") == "1"

# --- State ---

TRADES = {}
CLIENT = ArkEscrow::Client.new(ARKADE_URL, SPEND_STORE_DIR)

configure do
  CLIENT.connect
  set :bind, "0.0.0.0"
  set :port, 4567
end

# CORS — allow browser frontend
before do
  headers "Access-Control-Allow-Origin" => "*",
          "Access-Control-Allow-Methods" => "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers" => "Content-Type"
end

options "*" do
  200
end

# --- Helpers ---

def find_trade!(id)
  trade = TRADES[id]
  halt 404, json(error: "trade not found") unless trade
  trade
end

def assert_status!(trade, expected)
  unless trade[:status] == expected
    halt 409, json(error: "expected status #{expected}, got #{trade[:status]}")
  end
end

# --- Endpoints ---

# Create a new trade
post "/trades" do
  body = JSON.parse(request.body.read)
  alice_pk = body["alice_pk"]
  bob_pk = body["bob_pk"]

  halt 400, json(error: "missing alice_pk") unless alice_pk
  halt 400, json(error: "missing bob_pk") unless bob_pk

  id = SecureRandom.hex(8)
  server_pk = CLIENT.server_pk

  contract = ArkEscrow::Contract.new(
    alice_pk, bob_pk, ARBITER_SK_PK, server_pk,
    CLIENT.unilateral_exit_delay, NETWORK
  )

  TRADES[id] = {
    id: id,
    status: "created",
    alice_pk: alice_pk,
    bob_pk: bob_pk,
    contract: contract,
    escrow_address: contract.address,
    ark_tx_b64: nil,
    checkpoint_txs_b64: nil,
    escrow_outpoint: nil,
    escrow_amount: nil,
    release_txid: nil,
  }

  json(trade_id: id, escrow_address: contract.address, status: "created")
end

# Get trade status
get "/trades/:id" do
  trade = find_trade!(params[:id])
  json(
    trade_id: trade[:id],
    status: trade[:status],
    escrow_address: trade[:escrow_address],
    amount: trade[:escrow_amount],
    escrow_outpoint: trade[:escrow_outpoint],
    release_txid: trade[:release_txid],
  )
end

# Mark escrow as funded (Alice confirms)
post "/trades/:id/fund" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "created")

  begin
    vtxo = CLIENT.find_escrow_vtxo(trade[:contract])
  rescue => e
    halt 404, json(error: "escrow VTXO lookup failed: #{e.message}")
  end
  halt 404, json(error: "escrow VTXO not found on Arkade") unless vtxo

  trade[:escrow_outpoint] = vtxo[0]
  trade[:escrow_amount] = vtxo[1]
  trade[:status] = "funded"

  json(trade_id: trade[:id], status: "funded", amount: vtxo[1])
end

# Mark ERC20 as sent (simulated attestation)
post "/trades/:id/attest" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "funded")

  trade[:status] = "attested"
  json(trade_id: trade[:id], status: "attested")
end

# Build release — checks VTXO status and returns either offchain or delegate
# PSBTs.
#
# If the escrow VTXO is spendable: returns mode "offchain" with arbiter-signed
# ark_tx + checkpoint PSBTs (existing flow).
#
# If the escrow VTXO is recoverable: returns mode "delegate" with unsigned
# delegate PSBTs (intent + forfeits) that Bob must sign, then POST to
# /release/settle.
post "/trades/:id/release" do
  trade = find_trade!(params[:id])
  unless ["attested", "releasing_offchain", "releasing_delegate"].include?(trade[:status])
    halt 409, json(error: "expected status attested or releasing_*, got #{trade[:status]}")
  end

  body = JSON.parse(request.body.read)
  bob_dest = body["bob_dest_address"]
  halt 400, json(error: "missing bob_dest_address") unless bob_dest

  fee_sats = (trade[:escrow_amount] * FEE_RATE).to_i
  fee_dest = FEE_ADDRESS && fee_sats > 0 ? FEE_ADDRESS : nil

  # Check VTXO status to decide offchain vs delegate
  vtxos_data, any_recoverable = CLIENT.find_escrow_vtxos(trade[:contract])
  halt 404, json(error: "no escrow VTXOs found") if vtxos_data.empty?

  use_delegate = any_recoverable || FORCE_DELEGATE
  puts "  VTXO status: any_recoverable=#{any_recoverable}, force=#{FORCE_DELEGATE}, using #{use_delegate ? 'delegate' : 'offchain'}"

  if use_delegate
    # --- Delegate path ---
    intent_proof_b64, intent_message_json, forfeit_psbts_b64, cosigner_pk_hex =
      CLIENT.prepare_release_delegate(
        trade[:contract],
        vtxos_data,
        bob_dest,
        fee_dest,
        fee_dest ? fee_sats : nil,
        DELEGATE_COSIGNER_SK,
      )

    # Arbiter signs the delegate PSBTs
    arbiter_signed_intent, arbiter_signed_forfeits =
      ArkEscrow.sign_delegate(intent_proof_b64, forfeit_psbts_b64, ARBITER_SK)

    trade[:delegate_intent_b64] = arbiter_signed_intent
    trade[:delegate_intent_message_json] = intent_message_json
    trade[:delegate_forfeit_psbts_b64] = arbiter_signed_forfeits
    trade[:delegate_cosigner_pk_hex] = cosigner_pk_hex
    trade[:status] = "releasing_delegate"

    json(
      trade_id: trade[:id],
      status: "releasing_delegate",
      mode: "delegate",
      cosigner_pk: cosigner_pk_hex,
      intent_message: intent_message_json,
      intent_proof_psbt: arbiter_signed_intent,
      forfeit_psbts: arbiter_signed_forfeits,
    )
  else
    # --- Offchain path (existing) ---
    ark_tx_b64, checkpoint_txs_b64 = CLIENT.build_release(
      trade[:contract],
      trade[:escrow_outpoint],
      trade[:escrow_amount],
      bob_dest,
      fee_dest,
      fee_dest ? fee_sats : nil,
    )

    # Keep unsigned checkpoints — these go to Arkade at submit time
    trade[:unsigned_checkpoint_txs_b64] = checkpoint_txs_b64

    # Arbiter signs everything
    arbiter_signed_ark_tx = ArkEscrow.sign_ark_tx(ark_tx_b64, ARBITER_SK)
    arbiter_signed_checkpoints = checkpoint_txs_b64.map do |cp|
      ArkEscrow.sign_checkpoint(cp, ARBITER_SK)
    end

    trade[:arbiter_signed_ark_tx_b64] = arbiter_signed_ark_tx
    trade[:arbiter_signed_checkpoint_txs_b64] = arbiter_signed_checkpoints
    trade[:status] = "releasing_offchain"

    json(
      trade_id: trade[:id],
      status: "releasing_offchain",
      mode: "offchain",
      ark_tx_psbt: arbiter_signed_ark_tx,
      checkpoint_psbts: arbiter_signed_checkpoints,
    )
  end
end

# Complete release — Bob's co-signed PSBTs → merge, submit, finalize.
#
# The `finalize_release` method on the client handles:
# 1. Submitting the merged ark_tx + unsigned checkpoints to Arkade
# 2. Persisting the pending state (crash recovery)
# 3. Merging all checkpoint signatures (server + each party)
# 4. Finalizing the offchain transaction
# 5. Cleaning up the pending state
post "/trades/:id/release/sign" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "releasing_offchain")

  body = JSON.parse(request.body.read)
  bob_signed_ark_tx = body["signed_ark_tx"]
  bob_signed_checkpoints = body["signed_checkpoints"]
  halt 400, json(error: "missing signed_ark_tx") unless bob_signed_ark_tx
  halt 400, json(error: "missing signed_checkpoints") unless bob_signed_checkpoints

  # Merge ark_tx signatures: arbiter + Bob
  merged_ark_tx = ArkEscrow.merge_sigs(trade[:arbiter_signed_ark_tx_b64], bob_signed_ark_tx)

  # Guarded finalize: submit → persist → merge checkpoints → finalize → cleanup.
  # On crash between submit and finalize, the next call with the same trade ID
  # will resume from the persisted state.
  begin
    ark_txid = CLIENT.spend_escrow_offchain(
      trade[:id],
      merged_ark_tx,
      trade[:unsigned_checkpoint_txs_b64],
      [trade[:arbiter_signed_checkpoint_txs_b64], bob_signed_checkpoints],
    )
  rescue => e
    halt 500, json(error: "finalize failed: #{e.message}")
  end

  trade[:status] = "completed"
  trade[:release_txid] = ark_txid
  json(trade_id: trade[:id], status: "completed", release_txid: ark_txid)
end

# Complete delegate settlement — Bob's co-signed delegate PSBTs → batch ceremony.
#
# Bob signs the delegate PSBTs (intent + forfeits) returned by /release, then
# POSTs them here. The arbiter merges signatures, cosigns as delegate, and
# runs the Arkade batch ceremony (~10-30s).
post "/trades/:id/release/settle" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "releasing_delegate")

  body = JSON.parse(request.body.read)
  bob_signed_intent = body["signed_intent_proof"]
  bob_signed_forfeits = body["signed_forfeit_psbts"]
  halt 400, json(error: "missing signed_intent_proof") unless bob_signed_intent
  halt 400, json(error: "missing signed_forfeit_psbts") unless bob_signed_forfeits

  # Merge arbiter + Bob signatures on intent
  merged_intent = ArkEscrow.merge_sigs(trade[:delegate_intent_b64], bob_signed_intent)

  # Merge arbiter + Bob signatures on forfeits
  merged_forfeits = trade[:delegate_forfeit_psbts_b64].zip(bob_signed_forfeits).map do |arb, bob|
    ArkEscrow.merge_sigs(arb, bob)
  end

  begin
    commitment_txid = CLIENT.settle_delegate(
      merged_intent,
      trade[:delegate_intent_message_json],
      merged_forfeits,
      DELEGATE_COSIGNER_SK,
    )
  rescue => e
    halt 500, json(error: "delegate settlement failed: #{e.message}")
  end

  trade[:status] = "completed"
  trade[:release_txid] = commitment_txid
  json(trade_id: trade[:id], status: "completed", commitment_txid: commitment_txid)
end

# --- Compute arbiter public key from secret key ---

require "openssl"

def compute_xonly_pk(sk_hex)
  # Use secp256k1 via OpenSSL to derive the x-only public key
  # This is a simplification — in production, use a proper secp256k1 lib
  group = OpenSSL::PKey::EC::Group.new("secp256k1")
  bn = OpenSSL::BN.new(sk_hex, 16)
  point = group.generator.mul(bn)
  # Uncompressed point is 04 || x || y; x-only is just the x coordinate
  uncompressed = point.to_bn(:uncompressed).to_s(16).rjust(130, "0")
  uncompressed[2, 64] # skip the 04 prefix, take 64 hex chars (32 bytes)
end

ARBITER_SK_PK = compute_xonly_pk(ARBITER_SK)

puts "Arbiter server starting..."
puts "  Arkade URL: #{ARKADE_URL}"
puts "  Arbiter PK: #{ARBITER_SK_PK}"
puts "  Network:    #{NETWORK}"
