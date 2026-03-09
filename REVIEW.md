# Ark Lightning Escrow Plan Review

## Executive summary

The plan is directionally solid and very close to Arkade’s expected offchain flow, but there are a few important correctness and protocol details to tighten before implementation.

**Main conclusion:**
- The script family and 2-phase Arkade submit/finalize flow are broadly correct.
- The plan currently describes the contract as a generic **2-of-3**, but the actual scripts in `escrow-sample.rs` are **not threshold scripts** in that sense; they are named-path scripts that require specific signers.
- The PSBT exchange flow is missing a few robustness/security requirements that are present in Arkade references (`dlc_common` and `boltz`).

---

## 1) Correctness (scripts + taproot design)

### What looks correct

1. **Script pattern matches the reference sample** (`escrow-sample.rs`):
   - 3 collaborative leaves with `... CHECKSIGVERIFY ... CHECKSIGVERIFY ... CHECKSIG` (three signatures).
   - 3 CSV-delayed leaves with `CSV DROP` + two signatures.
2. **Taproot script-path-only approach** is valid:
   - unspendable internal key,
   - spending through script leaves,
   - ArkAddress derived from taproot output key and server key.
3. A 6-leaf tree is a reasonable fit for escrow with collaborative + delayed exits.

### Important correctness caveats

1. **“2-of-3 multisig” wording is inaccurate for these scripts.**
   In `escrow-sample.rs`, collaborative leaves require **three explicit signatures** (e.g., `alice + hodlhodl + server`), not “any 2 of 3”.

   Suggested wording: this is a **path-based contract** with:
   - collaborative paths: **party pair + server**,
   - delayed paths: **party pair after CSV**.

2. **No options validation in the sample pattern.**
   `vhtlc.rs` has explicit validation (`VhtlcOptions::validate`) for locktimes/delays; the escrow plan should do the same for `unilateral_exit_delay` and key material.

3. **CSV correctness is under-specified.**
   For delayed paths to work reliably, the spending tx must set proper sequence semantics (and version). The plan should explicitly require this in spend orchestration.

4. **Tree determinism across languages is a risk.**
   The weighted-tree algorithm in `escrow-sample.rs` (all weights currently `1`) is deterministic only if all implementations use exactly the same ordering/build rules.

---

## 2) Arkade protocol fit

### What fits well

The proposed release flow maps to Arkade’s standard pattern seen in `e2e-tests/tests/dlc_common/mod.rs` and client flows in `ark-client/src/boltz.rs`:

1. Build offchain tx (`build_offchain_transactions` style),
2. Sign ark tx,
3. Submit (`submit_offchain_transaction_request`),
4. Sign returned checkpoint PSBT(s),
5. Finalize (`finalize_offchain_transaction`).

This is the right high-level flow.

### What is missing for production-grade fit

1. **Checkpoint order must not be assumed.**
   `dlc_common` explicitly matches returned checkpoint PSBTs by txid.
2. **Server-side normalization can strip metadata/sigs.**
   `boltz.rs` shows recovery logic for missing `witness_script` and preserving/merging `tap_script_sigs`.
3. **Pending transaction recovery path is essential.**
   `boltz.rs` has dedicated pending spend continuation logic. The plan should include equivalent behavior for escrow releases.

---

## 3) Architecture (Rust crate + Magnus/Ruby + TS SDK + sample)

### Strong points

1. **Good separation of responsibilities**:
   - Rust: consensus/script/signing core,
   - Ruby (Magnus): server orchestration API,
   - TS: client-side verification/signing,
   - sample: e2e integration path.
2. Keeping all critical cryptography in Rust and exposing a narrow Ruby API is a sound direction.

### Architecture risks

1. **Cross-language script/address drift** (Rust vs TS) can silently break signatures.
2. **Runtime model in Magnus (`block_on`)** can become operationally fragile if not carefully constrained (threading/latency).
3. **State machine boundaries are not explicit enough** (trade created → funded → attested → release submitted → finalized).

---

## 4) Signing protocol (HodlHodl ↔ Bob PSBT exchange)

### Core flow is correct

The planned 2-step exchange is conceptually correct:
- Bob signs ark_tx first,
- server signs checkpoint(s) after submit,
- Bob signs checkpoint(s),
- HodlHodl finalizes.

### Security/robustness requirements to add

1. **Bob-side mandatory verification before each signature**:
   - input script path is expected release path,
   - destination address is Bob’s expected Ark address,
   - amount/fees are acceptable,
   - no unexpected outputs.
2. **HodlHodl-side verification of Bob signatures** before submit/finalize.
3. **Match checkpoint PSBTs by txid**, not index.
4. **Preserve and merge partial signatures/metadata** (do not overwrite maps).
5. **Handle interrupted flows** (submit succeeded, finalize not completed) with resume logic.

---

## 5) Risks and gaps

1. **Contract semantics mismatch in docs** (“2-of-3”) can lead to wrong threat assumptions.
2. **No explicit dispute/refund operational workflow** in the plan (only happy path is deeply specified).
3. **No explicit key management model** for arbiter keys (HSM, rotation, auditability).
4. **No idempotency/replay constraints** on release endpoints (`/release`, `/submit`, `/finalize`).
5. **No canonical test vectors** for script hex, tapleaf hashes, output key, ArkAddress across Rust/TS/Ruby.
6. **No pending-tx reconciliation strategy** for crashes or network failures.
7. **Fee/dust/change behavior not specified** for release construction.

---

## 6) Suggestions / improvements

## P0 (must do before implementation)

1. **Fix contract terminology in PLAN**:
   - Replace “2-of-3, any 2 can spend” with explicit path-based signing requirements.
2. **Add `EscrowOptions::validate`** mirroring `VhtlcOptions::validate` style.
3. **Specify checkpoint handling rules**:
   - txid-based matching,
   - sig map merge,
   - witness_script restoration when needed.
4. **Define recovery workflow** for pending/non-finalized offchain txs.

## P1 (strongly recommended)

1. **Create cross-language fixtures/tests**:
   - script hex per leaf,
   - taproot output key,
   - ArkAddress,
   - control block availability for each leaf.
2. **Add strict signer policy** (Bob and Alice): verify outputs/path/amount before signing.
3. **Define trade state machine + idempotency keys** for REST endpoints.

## P2 (nice to have but valuable)

1. **Reconsider tree construction strategy**:
   - either canonical fixed ordering,
   - or explicit weighted policy with tested vectors.
2. **Document arbiter key security posture** (storage, rotation, incident response).
3. **Add non-happy-path sample** (attestation denied, refund, unilateral exit timing).

---

## Final assessment

- **Correctness:** good foundation, but contract semantics in docs must be corrected and validation added.
- **Arkade fit:** good conceptual fit; missing operational details from real flows.
- **Architecture:** sensible modular split; biggest risk is cross-language drift and lifecycle robustness.
- **Signing protocol:** mostly right; needs explicit verification/merge/recovery rules to be secure and reliable.

If the P0 items are addressed, this plan should be a strong base for implementation.