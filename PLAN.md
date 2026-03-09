# Ark Lightning Escrow — Plan

## Goal

Demonstrate how HodlHodl can use **Arkade** for bitcoin↔ERC20 escrow trades.
Lightning swaps (via Lendaswap) can be layered on top later — this sample funds
and withdraws directly on Arkade, making it immediately testable against regtest.

### Happy Path

1. Alice and Bob agree to swap bitcoin for an ERC20 token.
2. HodlHodl creates a **2-of-3 escrow contract** on Arkade (Alice, Bob, HodlHodl as arbiter).
3. Alice funds the escrow — she already has Arkade BTC (test setup), sends to escrow address.
4. Bob sends the ERC20 token to Alice on Ethereum (simulated — state change in HodlHodl).
5. HodlHodl attests the token transfer, orchestrates the release: builds offchain tx,
   collects Bob's signature, adds its own, submits to Arkade, finalizes.
6. Bob receives the bitcoin to his Arkade address.

Lightning swap integration (Lendaswap LN↔Arkade) is a follow-up commit.

## Escrow Contract Design

**2-of-3 multisig**: any 2 of {Alice, Bob, HodlHodl} can spend.

Uses the exact same script structure as `escrow-sample.rs` (from the lending
project), with renamed parties: borrower→alice, lender→bob, hub→hodlhodl.

No dedicated forfeit branch — any leaf involving the Arkade server can be used
to forfeit.

### Taproot Leaves (6 total)

**Collaborative** (include `server_pk`, usable for offchain spend & forfeit):

| Leaf | Script | Purpose |
|------|--------|---------|
| 1 | `alice + hodlhodl + server` | Arbiter-assisted refund to Alice |
| 2 | `bob + hodlhodl + server` | Arbiter-assisted release to Bob **(happy path)** |
| 3 | `alice + bob + server` | Mutual settlement, no arbiter needed |

**Unilateral** (CSV delay, no server — for on-chain exit):

| Leaf | Script | Purpose |
|------|--------|---------|
| 4 | `CSV + alice + hodlhodl` | Unilateral refund (arbiter + alice agree) |
| 5 | `CSV + bob + hodlhodl` | Unilateral release (arbiter + bob agree) |
| 6 | `CSV + alice + bob` | Unilateral mutual settlement |

No built-in forfeit/exit paths from `Vtxo::new_with_custom_scripts` — the
taproot tree is built manually (as in `escrow-sample.rs`).

## Architecture

HodlHodl orchestrates everything. Clients (Alice, Bob) only sign PSBTs.

```
 Alice (TS)               HodlHodl (Ruby + Rust/Magnus)              Bob (TS)
   │                          │                                        │
   │── create trade ─────────▶│◀── create trade ──────────────────────│
   │   (alice_pk)             │    (bob_pk)                           │
   │                          │                                        │
   │                    derive escrow address                          │
   │                    (Rust escrow crate via Magnus)                 │
   │                    connect to Arkade (ark-grpc/rest via Magnus)   │
   │◀── escrow addr ──────────│──── escrow addr ─────────────────────▶│
   │                          │                                        │
   │── send to escrow addr ──▶│ (Alice uses her Arkade wallet)        │
   │   (Alice has VTXOs)   [Arkade]                                   │
   │                          │                                        │
   │                    "Bob sends ERC20" (state change)               │
   │                          │                                        │
   │                    === RELEASE FLOW (all via Rust/Magnus) ===     │
   │                          │                                        │
   │                    1. build offchain tx                           │
   │                       (escrow VTXO → bob's ark addr)             │
   │                          │                                        │
   │                    2. send ark_tx PSBT to Bob ──────────────────▶│
   │                          │                                        │
   │                          │◀── bob signs ark_tx, returns ─────────│
   │                          │                                        │
   │                    3. add arbiter sig to ark_tx                   │
   │                    4. submit to Arkade server                    │
   │                       → server validates, returns                │
   │                         server-signed checkpoints                │
   │                          │                                        │
   │                    5. send checkpoint PSBT to Bob ──────────────▶│
   │                          │                                        │
   │                          │◀── bob signs checkpoint, returns ─────│
   │                          │                                        │
   │                    6. add arbiter sig to checkpoint               │
   │                    7. finalize with Arkade                       │
   │                          │                                        │
   │                    Bob now has VTXO ✓                             │
```

## Deliverables

### 1. `escrow/` — Rust library crate (this repo)

Escrow contract (scripts, address) + Arkade integration (build offchain txs,
submit, finalize). Depends on `ark-core` and `ark-grpc` from crates.io.

```
escrow/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── contract.rs     # EscrowOptions → 6 taproot scripts → ArkAddress
    │                   # (port of escrow-sample.rs with renamed parties)
    ├── spend.rs        # Build offchain txs, sign ark_tx/checkpoints
    └── client.rs       # Arkade server interaction: submit, finalize, list VTXOs
```

**Key types (contract.rs):**

```rust
pub struct EscrowOptions {
    pub alice: XOnlyPublicKey,
    pub bob: XOnlyPublicKey,
    pub arbiter: XOnlyPublicKey,   // HodlHodl
    pub server: XOnlyPublicKey,    // Arkade server
    pub unilateral_exit_delay: Sequence,
}

pub struct EscrowContract { /* options, TaprootSpendInfo, network */ }

impl EscrowContract {
    pub fn new(opts: EscrowOptions, network: Network) -> Result<Self>;
    pub fn address(&self) -> ArkAddress;
    pub fn tapscripts(&self) -> Vec<ScriptBuf>;

    // Collaborative leaves (with server)
    pub fn alice_arbiter_script(&self) -> ScriptBuf;   // refund
    pub fn bob_arbiter_script(&self) -> ScriptBuf;     // release (happy path)
    pub fn alice_bob_script(&self) -> ScriptBuf;       // mutual

    // Unilateral leaves (CSV, no server)
    pub fn unilateral_alice_arbiter_script(&self) -> ScriptBuf;
    pub fn unilateral_bob_arbiter_script(&self) -> ScriptBuf;
    pub fn unilateral_alice_bob_script(&self) -> ScriptBuf;
}
```

**Spend orchestration (spend.rs + client.rs):**

```rust
/// Full release flow — HodlHodl calls this.
/// 1. Find escrow VTXO on Arkade
/// 2. Build offchain tx (escrow → bob_dest_addr)
/// 3. Return ark_tx PSBT for Bob to sign
pub fn build_release_tx(...) -> Result<Psbt>;

/// After collecting Bob's sig:
/// 4. Add arbiter sig to ark_tx
/// 5. Submit to Arkade → get server-signed checkpoints
/// 6. Return checkpoint PSBT for Bob to sign
pub async fn submit_release_tx(...) -> Result<Vec<Psbt>>;

/// After collecting Bob's checkpoint sig:
/// 7. Add arbiter sig to checkpoint
/// 8. Finalize with Arkade
pub async fn finalize_release_tx(...) -> Result<Txid>;
```

### 2. `ruby-ext/` — Magnus bindings (this repo)

Wraps everything from `escrow/` for Ruby. Uses `tokio::Runtime::block_on`
for async Arkade calls.

```
ruby-ext/
├── Cargo.toml           # cdylib, depends on escrow + magnus
├── src/
│   └── lib.rs           # #[magnus::init] — Ruby classes
├── lib/
│   └── ark_escrow.rb
├── Gemfile
├── Rakefile
└── ark_escrow.gemspec
```

**Ruby API:**

```ruby
# Connect to Arkade
client = ArkEscrow::Client.new(arkade_url: "http://localhost:7070")

# Create escrow contract
contract = ArkEscrow::Contract.new(
  alice_pk: "...", bob_pk: "...", arbiter_pk: "...",
  server_pk: client.server_pk,
  unilateral_exit_delay: 512,
  network: "regtest"
)
contract.address  # => "tark1q..."

# Step 1: Build release tx → PSBT for Bob to sign
release_psbt = client.build_release(
  contract: contract,
  arbiter_sk: "...",
  bob_dest_address: "tark1q...",
)

# Step 2: After Bob signs, submit → checkpoint PSBTs for Bob to sign
checkpoint_psbts = client.submit_release(
  release_psbt: bob_signed_psbt,  # Bob's sig merged in
  arbiter_sk: "...",
)

# Step 3: After Bob signs checkpoints, finalize
txid = client.finalize_release(
  checkpoint_psbts: bob_signed_checkpoints,
  arbiter_sk: "...",
)
```

### 3. Lendaswap TS SDK `escrow/` module (in lendaswap2 repo)

Minimal client-side module — clients only sign PSBTs, HodlHodl orchestrates.

```
client-sdk/ts-pure-sdk/src/escrow/
├── index.ts
├── types.ts          # EscrowOptions
├── script.ts         # EscrowScript extends VtxoScript (address derivation, verification)
└── sign.ts           # Sign ark_tx / checkpoint PSBTs (Bob/Alice side)
```

**TS API:**

```typescript
// Verify escrow address independently
const escrow = new EscrowScript({
  alice: alicePk, bob: bobPk, arbiter: arbiterPk,
  server: serverPk, unilateralExitDelay: { type: "blocks", value: 512n },
});
const address = escrow.address("tark", serverPk);

// Sign ark_tx PSBT from HodlHodl (Bob side)
const signed = signArkTx(psbt, bobKeypair, escrow.release());

// Sign checkpoint PSBT from HodlHodl (Bob side)
const signedCheckpoint = signCheckpoint(psbt, bobKeypair, escrow.release());
```

### 4. `sample/` — End-to-end happy path (this repo)

TypeScript script + Ruby server, run against Arkade regtest.

```
sample/
├── package.json
├── tsconfig.json
├── src/
│   └── happy-path.ts        # Alice sends to escrow, Bob signs release
└── server/
    └── hodlhodl.rb           # Sinatra app using ark_escrow gem
```

### 5. HodlHodl Mock REST API (Ruby, in sample)

Thin Sinatra app — all crypto/Arkade logic via Magnus gem.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /trades` | Create | `{ alice_pk, bob_pk }` → `{ trade_id, escrow_address }` |
| `GET /trades/:id` | Read | Trade status, escrow address |
| `POST /trades/:id/attest` | Attest | Mark ERC20 as sent, advance state |
| `POST /trades/:id/release` | Release | Build ark_tx → `{ psbt }` for Bob to sign |
| `POST /trades/:id/release/submit` | Submit | Bob's signed PSBT → submit to Arkade → `{ checkpoint_psbts }` |
| `POST /trades/:id/release/finalize` | Finalize | Bob's signed checkpoints → finalize → `{ txid }` |

## Execution Order

1. **`escrow/`** — Rust crate. Port `escrow-sample.rs` scripts, add offchain tx
   building and Arkade client integration. Unit tests for address derivation.
2. **`ruby-ext/`** — Magnus bindings with tokio runtime. Test from Ruby.
3. **TS SDK `escrow/` module** — In `lendaswap2/client-sdk/ts-pure-sdk/src/escrow/`.
   `EscrowScript` extending `VtxoScript`, signing helpers.
4. **`sample/`** — Ruby server + TS happy path script, run against regtest.
5. **Follow-up** — Replace direct Arkade funding with Lendaswap LN↔Arkade swaps.

## Dev Environment

`flake.nix` at repo root provides all tooling:

- **Rust** (stable, ≥1.86 for ark-core) + nightly rustfmt
- **Ruby 3.3** + bundler (for Magnus gem / HodlHodl mock)
- **Node 22** + pnpm (for TS sample client)
- **just** (task runner)

## Dependencies

| Component | Dependency | Source |
|-----------|-----------|--------|
| `escrow/` | `ark-core = "0.8.0"` | crates.io |
| `escrow/` | `ark-grpc` or `ark-rest` | crates.io |
| `ruby-ext/` | `magnus = "0.8"`, `tokio` | crates.io |
| TS SDK module | `@arkade-os/sdk = "^0.3.12"` | npm |
| Sample (TS) | `@lendasat/lendaswap-sdk-pure` | **path dep**: `../lendaswap2/client-sdk/ts-pure-sdk` |
| Sample (Ruby) | `ark_escrow` gem | local build |

### TS SDK path linking

The Lendaswap TS SDK escrow module is developed in
`../lendaswap2/client-sdk/ts-pure-sdk/src/escrow/`. The sample's
`package.json` uses a path dependency to link it:

```json
{
  "dependencies": {
    "@lendasat/lendaswap-sdk-pure": "file:../lendaswap2/client-sdk/ts-pure-sdk"
  }
}
```
