# Ark Lightning Escrow — Plan

## Goal

Demonstrate how HodlHodl can use **Arkade** for bitcoin↔ERC20 escrow trades.
Lightning swaps (via Lendaswap) can be layered on top later — this sample funds
and withdraws directly on Arkade, making it immediately testable against regtest.

### Happy Path

1. Alice and Bob agree to swap bitcoin for an ERC20 token.
2. HodlHodl creates a **2-of-3 escrow contract** on Arkade (Alice, Bob, HodlHodl as arbiter).
3. Alice funds the escrow with bitcoin on Arkade (boarding output → settle → offchain tx to escrow address).
4. Bob sends the ERC20 token to Alice on Ethereum (simulated — console log).
5. HodlHodl attests the token transfer, co-signs with Bob to **release** the escrow.
6. Bob receives the bitcoin to his Arkade address.

Lightning swap integration (Lendaswap LN↔Arkade) is a follow-up commit once
that feature lands.

## Escrow Contract Design

**2-of-3 multisig**: any 2 of {Alice, Bob, HodlHodl} can spend. The Arkade
server participates at the protocol level (checkpoint signing, batch settlement)
but is not a signer in the escrow condition scripts.

The escrow VTXO uses `Vtxo::new_with_custom_scripts` (Rust) /
`VtxoScript` (TS) with **owner = arbiter (HodlHodl)**, since HodlHodl is
trusted and is the natural signer for the built-in forfeit and exit paths.

### Taproot Leaves

Built-in (added by `Vtxo::new_with_custom_scripts` / `VtxoScript`):

| Leaf | Script | Purpose |
|------|--------|---------|
| F | `ArkServer + HodlHodl` | Forfeit (protocol-level, prevents double-spend) |
| E | `CSV(exit_delay) + HodlHodl` | Unilateral exit (on-chain fallback) |

Custom (our escrow scripts):

| Leaf | Script | Purpose |
|------|--------|---------|
| 1 | `Alice + Bob` (2-of-2 multisig) | Mutual settlement, no arbiter needed |
| 2 | `Alice + HodlHodl` (2-of-2 multisig) | Arbiter-assisted refund to Alice |
| 3 | `Bob + HodlHodl` (2-of-2 multisig) | Arbiter-assisted release to Bob **(happy path)** |
| 4 | `CLTV(timeout) + Alice` | Safety net: funder recovers if escrow never resolves |

## Reference Implementations

- **Rust offchain tx flow**: `ark-rs/e2e-tests/tests/dlc_common/mod.rs` — shows
  `Vtxo::new_with_custom_scripts`, `build_offchain_transactions`, `sign_ark_transaction`,
  `sign_checkpoint_transaction`, `submit_offchain_transaction_request`,
  `finalize_offchain_transaction`.
- **TS SDK building blocks**: `@arkade-os/sdk` — `VtxoScript`, `VHTLC.Script`,
  `MultisigTapscript`, `CLTVMultisigTapscript`, `buildOffchainTx`,
  `combineTapscriptSigs`.
- **PSBT exchange**: `ark-rs/ark-client/src/boltz.rs` — shows how to exchange
  partially-signed PSBTs between parties (Boltz signs, client co-signs, submits
  to Arkade).

## Architecture

```
 Alice (TS)               HodlHodl (Ruby)              Bob (TS)                 Arkade
   │                          │                          │                         │
   │── create trade ─────────▶│◀── create trade ─────────│                         │
   │   (alice_pk)             │    (bob_pk)              │                         │
   │                          │                          │                         │
   │                    derive escrow address             │                         │
   │                   (escrow crate via Magnus)          │                         │
   │◀── escrow addr ──────────│──── escrow addr ────────▶│                         │
   │                          │                          │                         │
   │── board btc ────────────────────────────────────────────────────────────────▶│
   │── settle to escrow addr ────────────────────────────────────────────────────▶│
   │                          │                          │                         │
   │       ···················· Bob sends ERC20 (simulated) ·····················│
   │                          │                          │                         │
   │                    attest trade OK                   │                         │
   │                          │                          │                         │
   │                          │◀─ request release ───────│                         │
   │                          │   (bob_pk, dest_addr)    │                         │
   │                          │                          │                         │
   │                    build offchain tx                 │                         │
   │                    sign ark_tx (arbiter key)         │                         │
   │                          │                          │                         │
   │                          │── partial PSBT ─────────▶│                         │
   │                          │                          │                         │
   │                          │                  co-sign ark_tx (bob key)          │
   │                          │                  submit offchain tx ──────────────▶│
   │                          │                  ◀── server-signed checkpoints ───│
   │                          │                          │                         │
   │                          │◀── checkpoint PSBT ──────│                         │
   │                          │    (needs arbiter sig)   │                         │
   │                          │                          │                         │
   │                    sign checkpoint (arbiter key)     │                         │
   │                          │── signed checkpoint ────▶│                         │
   │                          │                          │                         │
   │                          │                  co-sign checkpoint (bob key)      │
   │                          │                  finalize ────────────────────────▶│
   │                          │                          │                         │
   │                          │                     Bob now has VTXO ✓             │
```

## Signing Protocol (PSBT Exchange)

For escrow release (leaf 3: Bob + HodlHodl):

1. **Bob** builds the offchain transaction (ark_tx + checkpoints) spending the
   escrow VTXO to Bob's Arkade address.
2. **Bob** requests release from HodlHodl API, sending the unsigned ark_tx.
3. **HodlHodl** verifies conditions, signs the ark_tx with arbiter key,
   returns the partially-signed PSBT.
4. **Bob** adds his signature to the ark_tx (now fully signed for the 2-of-2 leaf).
5. **Bob** submits to Arkade via `submit_offchain_transaction_request`.
6. **Arkade** validates signatures, returns server-signed checkpoint PSBTs.
7. **Bob** sends checkpoint PSBTs to HodlHodl for co-signing.
8. **HodlHodl** signs checkpoints with arbiter key, returns.
9. **Bob** co-signs checkpoints with his key.
10. **Bob** calls `finalize_offchain_transaction`.

Arkade uses a baseX-encoded PSBT format for the wire protocol.

## Deliverables

### 1. `escrow/` — Rust library crate (this repo)

Pure Rust escrow logic. Depends on `ark-core = "0.8.0"` from crates.io.
Follows the patterns from the DLC e2e test.

```
escrow/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── contract.rs     # EscrowOptions → scripts → Vtxo → ArkAddress
    └── spend.rs        # Build + sign offchain txs for release/refund
```

**Key types:**

```rust
pub struct EscrowOptions {
    pub alice: XOnlyPublicKey,     // funder
    pub bob: XOnlyPublicKey,       // recipient
    pub arbiter: XOnlyPublicKey,   // HodlHodl
    pub refund_timeout: u32,       // CLTV block height for safety refund
}

pub struct EscrowContract {
    options: EscrowOptions,
    vtxo: Vtxo,                    // from Vtxo::new_with_custom_scripts
}

impl EscrowContract {
    /// Create escrow. `server_info` provides ark server pk, exit delay, network.
    pub fn new(opts: EscrowOptions, server_info: &ServerInfo) -> Result<Self>;

    pub fn address(&self) -> ArkAddress;
    pub fn vtxo(&self) -> &Vtxo;

    // The 4 custom scripts
    pub fn mutual_script(&self) -> ScriptBuf;     // Alice + Bob
    pub fn refund_script(&self) -> ScriptBuf;     // Alice + HodlHodl
    pub fn release_script(&self) -> ScriptBuf;    // Bob + HodlHodl
    pub fn timeout_script(&self) -> ScriptBuf;    // CLTV + Alice
}

/// Build a VtxoInput for spending the escrow via a given leaf.
pub fn escrow_vtxo_input(
    contract: &EscrowContract,
    leaf: EscrowLeaf,
    outpoint: OutPoint,
    amount: Amount,
) -> Result<VtxoInput>;

/// Sign an ark_tx PSBT for one party's key.
pub fn sign_escrow_ark_tx(
    keypair: &Keypair,
    ark_tx: &mut Psbt,
    input_index: usize,
) -> Result<()>;

/// Sign a checkpoint PSBT for one party's key.
pub fn sign_escrow_checkpoint(
    keypair: &Keypair,
    checkpoint: &mut Psbt,
) -> Result<()>;
```

### 2. `ruby-ext/` — Magnus bindings (this repo)

Wraps `escrow/` for the HodlHodl Ruby backend.

```
ruby-ext/
├── Cargo.toml           # cdylib, depends on escrow + magnus + serde_magnus
├── src/
│   └── lib.rs           # #[magnus::init] — Ruby classes
├── lib/
│   └── ark_escrow.rb    # Ruby require shim
├── Gemfile
├── Rakefile
└── ark_escrow.gemspec
```

**Ruby API:**

```ruby
contract = ArkEscrow::Contract.new(
  alice_pk: "ab12...",
  bob_pk: "cd34...",
  arbiter_pk: "ef56...",
  ark_server_pk: "...",
  exit_delay: 512,
  refund_timeout: 850_000,
  network: "regtest"
)

contract.address  # => "tark1q..."

# Sign ark_tx PSBT (arbiter side)
signed_psbt = contract.sign_ark_tx(
  psbt_base64: "...",
  arbiter_secret_key: "...",
  input_index: 0
)

# Sign checkpoint PSBT (arbiter side)
signed_checkpoint = contract.sign_checkpoint(
  psbt_base64: "...",
  arbiter_secret_key: "..."
)
```

### 3. Lendaswap TS SDK `escrow/` module (in lendaswap2 repo)

New module in `client-sdk/ts-pure-sdk/src/escrow/`, extending `VtxoScript`
from `@arkade-os/sdk` — same pattern as `VHTLC.Script`.

```
src/escrow/
├── index.ts
├── types.ts          # EscrowOptions, EscrowLeaf
├── script.ts         # EscrowScript extends VtxoScript (address derivation, leaf selection)
├── release.ts        # Build offchain tx, coordinate signing with arbiter API
└── refund.ts         # Same for refund path
```

**TS API:**

```typescript
import { VtxoScript, MultisigTapscript } from "@arkade-os/sdk";

class EscrowScript extends VtxoScript {
  constructor(options: EscrowOptions);

  // Leaf accessors (return TapLeafScript for signing)
  mutual(): TapLeafScript;     // Alice + Bob
  refund(): TapLeafScript;     // Alice + HodlHodl
  release(): TapLeafScript;    // Bob + HodlHodl
  timeout(): TapLeafScript;    // CLTV + Alice

  address(prefix: string, serverPubKey: Bytes): ArkAddress;
}

// Release flow — Bob side
async function release(params: {
  arkServerUrl: string;
  hodlhodlApiUrl: string;
  tradeId: string;
  escrow: EscrowScript;
  bobKeypair: Keypair;
  destAddress: ArkAddress;
  vtxoOutpoint: Outpoint;
  amount: bigint;
}): Promise<string>;  // txid
```

### 4. `sample/` — End-to-end happy path (this repo)

TypeScript script that runs against a Ruby backend and Arkade regtest.

```
sample/
├── package.json
├── tsconfig.json
└── src/
    ├── happy-path.ts        # Orchestrates full flow
    └── hodlhodl-server.rb   # Sinatra/Rack mock using ark_escrow gem
```

The TS script acts as **both Alice and Bob**, calling the Ruby HodlHodl
server and Arkade directly.

### 5. HodlHodl Mock REST API (Ruby, in sample)

Uses the `ark_escrow` Magnus gem. Sinatra app.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /trades` | Create | `{ alice_pk, bob_pk }` → `{ trade_id, escrow_address }` |
| `GET /trades/:id` | Read | Trade status, escrow address |
| `POST /trades/:id/attest` | Attest | Mark ERC20 as sent |
| `POST /trades/:id/sign-release` | Sign | Takes ark_tx PSBT, returns arbiter-signed PSBT |
| `POST /trades/:id/sign-checkpoint` | Sign | Takes checkpoint PSBT, returns arbiter-signed checkpoint |

## Execution Order

1. **`escrow/`** — Rust crate with unit tests (address derivation, script generation).
   Reference: `ark-core`'s `Vtxo::new_with_custom_scripts`, `multisig_script`, `csv_sig_script`.
2. **`ruby-ext/`** — Magnus bindings. Test from Ruby.
3. **TS SDK `escrow/` module** — In `lendaswap2/client-sdk/ts-pure-sdk/src/escrow/`.
   Reference: `@arkade-os/sdk`'s `VtxoScript`, `VHTLC.Script`.
4. **`sample/`** — Ruby server + TS happy path script, run against regtest.
5. **Follow-up** — Replace direct Arkade funding with Lendaswap LN↔Arkade swaps.

## Dependencies

| Component | Dependency | Source |
|-----------|-----------|--------|
| `escrow/` | `ark-core = "0.8.0"` | crates.io |
| `ruby-ext/` | `magnus = "0.8"` | crates.io |
| TS SDK module | `@arkade-os/sdk = "^0.3.12"` | npm |
| TS SDK module | `@scure/btc-signer` | npm (already a dep) |
| Sample (TS) | `@lendasat/lendaswap-sdk-pure` | local/npm |
| Sample (Ruby) | `ark_escrow` gem | local build |
