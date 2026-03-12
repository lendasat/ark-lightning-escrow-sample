# frozen_string_literal: true

# HodlHodl mock server — orchestrates escrow trades using the ark_escrow gem.
#
# Trade states: created → funded → attested → releasing → completed

require "sinatra"
require "sinatra/json"
require "securerandom"
require "json"

# Load the native extension
$LOAD_PATH.unshift File.expand_path("../../ruby-ext/lib", __dir__)
require "ark_escrow"

# --- Configuration ---

ARKADE_URL = ENV.fetch("ARKADE_URL", "http://localhost:7070")
ARBITER_SK = ENV.fetch("ARBITER_SK") # hex-encoded secret key
UNILATERAL_EXIT_DELAY = ENV.fetch("UNILATERAL_EXIT_DELAY", "512").to_i
NETWORK = ENV.fetch("NETWORK", "regtest")

# Fee as percentage of escrow amount (e.g., "0.01" = 1%)
FEE_RATE = ENV.fetch("FEE_RATE", "0.01").to_f
# Arbiter's Arkade address for fee collection
FEE_ADDRESS = ENV.fetch("FEE_ADDRESS", nil)

# --- State ---

TRADES = {}
CLIENT = ArkEscrow::Client.new(ARKADE_URL)

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
    UNILATERAL_EXIT_DELAY, NETWORK
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

# Build release tx — returns PSBT for Bob to sign
post "/trades/:id/release" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "attested")

  body = JSON.parse(request.body.read)
  bob_dest = body["bob_dest_address"]
  halt 400, json(error: "missing bob_dest_address") unless bob_dest

  fee_sats = (trade[:escrow_amount] * FEE_RATE).to_i
  fee_dest = FEE_ADDRESS && fee_sats > 0 ? FEE_ADDRESS : nil

  ark_tx_b64, checkpoint_txs_b64 = CLIENT.build_release(
    trade[:contract],
    trade[:escrow_outpoint],
    trade[:escrow_amount],
    bob_dest,
    fee_dest,
    fee_dest ? fee_sats : nil,
  )

  # Arbiter signs the ark_tx
  arbiter_signed = ArkEscrow.sign_ark_tx(ark_tx_b64, ARBITER_SK)

  trade[:ark_tx_b64] = arbiter_signed
  trade[:checkpoint_txs_b64] = checkpoint_txs_b64
  trade[:status] = "releasing"

  json(
    trade_id: trade[:id],
    status: "releasing",
    ark_tx_psbt: arbiter_signed,
    checkpoint_psbts: checkpoint_txs_b64,
  )
end

# Submit Bob's signed PSBT → submit to Arkade
post "/trades/:id/release/submit" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "releasing")

  body = JSON.parse(request.body.read)
  bob_signed_b64 = body["signed_ark_tx"]
  halt 400, json(error: "missing signed_ark_tx") unless bob_signed_b64

  # Merge Bob's sigs with arbiter's
  merged = ArkEscrow.merge_sigs(trade[:ark_tx_b64], bob_signed_b64)

  # Submit to Arkade
  begin
    server_checkpoints = CLIENT.submit_release(merged, trade[:checkpoint_txs_b64])
  rescue => e
    halt 500, json(error: "submit failed: #{e.message}")
  end

  # Arbiter signs each checkpoint
  arbiter_signed_checkpoints = server_checkpoints.map do |cp|
    ArkEscrow.sign_checkpoint(cp, ARBITER_SK)
  end

  trade[:server_checkpoint_txs_b64] = arbiter_signed_checkpoints

  json(
    trade_id: trade[:id],
    checkpoint_psbts: arbiter_signed_checkpoints,
  )
end

# Finalize — Bob's signed checkpoints → finalize on Arkade
post "/trades/:id/release/finalize" do
  trade = find_trade!(params[:id])
  assert_status!(trade, "releasing")

  body = JSON.parse(request.body.read)
  bob_signed_checkpoints = body["signed_checkpoint_psbts"]
  halt 400, json(error: "missing signed_checkpoint_psbts") unless bob_signed_checkpoints

  # Merge Bob's checkpoint sigs with arbiter's
  final_checkpoints = trade[:server_checkpoint_txs_b64].zip(bob_signed_checkpoints).map do |arb, bob|
    ArkEscrow.merge_sigs(arb, bob)
  end

  # Compute the ark txid from the merged ark_tx PSBT
  # For now, pass the txid from the ark_tx
  # TODO: extract txid from PSBT properly
  ark_txid = body["ark_txid"]
  halt 400, json(error: "missing ark_txid") unless ark_txid

  CLIENT.finalize_release(ark_txid, final_checkpoints)

  trade[:status] = "completed"
  json(trade_id: trade[:id], status: "completed")
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

puts "HodlHodl mock server starting..."
puts "  Arkade URL: #{ARKADE_URL}"
puts "  Arbiter PK: #{ARBITER_SK_PK}"
puts "  Network:    #{NETWORK}"
