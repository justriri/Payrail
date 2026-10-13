# Payrail — Master Project Checklist

> **Last audited:** 2026-10-13, against the real code, records and a fresh test run (not from memory).
> **How to use this file:** Part 0 is the wallet check. Sections A–H are the audit. **Section H is the checklist to work from.**
> Status labels: `[x]` verified complete · `[~]` implemented, not fully verified · `[ ]` not done · `[!]` blocked / waiting on someone else.
> Evidence levels used throughout: **MOCK** = automated test with fakes only · **LIVE** = ran against a real service · **CHAIN** = independently confirmed on Celo mainnet.

---

## 0. Wallet address verification (2026-10-13)

| Source | Address | Matches `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`? |
|---|---|---|
| `.env` → `PAYRAIL_WALLET_ADDRESS` | `0x652C…D2a4` | yes |
| Address the app resolves (`src/config.ts`), key file **not** loaded | `0x652C…D2a4` | yes |
| Address the app resolves with the key file loaded (derived from the key; key never shown) | `0x652C…D2a4` | yes |
| Order `b5660887-…` → `payer` | `0x652C…D2a4` | yes |
| Receipt `direct-2026-10-13T14-41-27-277Z` → `payer` and `authorization.from` | `0x652C…D2a4` | yes |
| **On-chain** tx `0x57c3c046…57fe` (block 80001720, status success): Transfer `from` | `0x652C…D2a4` | yes |

How the app picks the address: if a private key is loaded, the address is **derived from the key and overrides** `.env`; if both are set and differ, the app refuses to start (`src/config.ts` lines 136–142). So a wrong address cannot silently be used for signing.

Three different addresses appear in the records — do not mix them up:

| Role | Address | What it is |
|---|---|---|
| **Payer / Payrail wallet** | `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4` | Signs the payment authorization; the money leaves from here. This is *your* wallet. |
| **payTo** | `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B` | The Buy gateway's receiving address. Money arrives here. It is **not** yours. |
| **Transaction submitter** | `0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48` | The gateway's sponsor that sent the x402 transaction and paid its gas. Not yours. |

**Which one does the developer need? — INCONCLUSIVE.** The only organizer statement recorded in the project is: *"For all x402 txs, we need your payto wallet address."* "Your payTo" is ambiguous, because Payrail is the **buyer**: its own address is the *payer*, and the *payTo* of its payments is the gateway's address. There is no record in the project of a message asking for an "agent wallet" or a "communication address", and no ERC-8004 agent registration has been done. So:

- The address `0x652C…D2a4` **is verified** as the real Payrail payer wallet.
- Whether that is what the developer wants **cannot be established from the evidence**. Ask them (question G1 below) before sending anything.
- Do not describe `0x652C…D2a4` as a "payTo" — on-chain, the payTo of your payment was `0x20fa…333B`.

---

## A. Original project requirements

**What Payrail is.** "Pay in Your Currency": an agent/product that lets a person or an AI agent pay for supported digital services using money they already hold (for example a local stablecoin such as cNGN), converting only when needed.

**Core flow (as built):** discover service and its real price → read wallet balances → pay directly if an accepted asset is held, otherwise convert (Textile FX / Mento) → apply spending policy and approval → execute → verify settlement independently → keep receipts and history.

**Hackathon:** Celo "Agents on Open Rails". Facts in the project, with their source quality:

| Item | What the project holds | Source quality |
|---|---|---|
| Dates | Oct 6 – Nov 9 2026 | Community pull requests only; official rules page was never reachable |
| Tracks | LatAm, Open Corridors, Build with Buy | Community pull requests only; **not confirmed by organizers** |
| Chain | Celo mainnet (42220) | Project decision |
| Attribution tag | `celo_b2fff2ac9413` (ERC-8021), required on transactions Payrail itself submits | **Supplied by you** as the official tag; enforced in code |
| Buy / x402 | Settlement is submitted by the gateway, so Payrail cannot tag it | Organizer clarification relayed by you, 2026-10-12 |
| Organizer clarification (relayed) | Need the payTo wallet for x402 txs; tags not yet supported by x402; for usebuy.ai the focus is "a good agent using the services"; state which services are used and give proof of payments; no tag needed for Buy | Relayed message; original not stored in the project |
| Judging criteria | **None documented** | — |
| Submission format / forms | **None documented**; you are waiting for the organizers | — |

**Still needing clarification from organizers:** see Section G.

---

## B. Everything completed

Evidence level in the last column. "CHAIN" = confirmed on Celo mainnet.

| # | What was done | Where | Evidence level / proof |
|---|---|---|---|
| 1 | Config loader with the official tag **hard-pinned**; refuses a wrong tag, wrong chain, mismatched wallet/key | `src/config.ts`, `src/attribution.ts` | MOCK; tag verified on-chain on 4 txs (CHAIN) |
| 2 | Dedicated wallet outside OneDrive; key loaded only via `--env-file` | `C:\Users\HP\.payrail\rehearsal.env` (not in project) | LIVE; key never printed |
| 3 | Buy catalog client (170 services), normalisation, safety checks | `src/catalog.ts` | MOCK + LIVE read-only (gateway has returned HTTP 500 at times) |
| 4 | Real-price discovery from the unpaid 402 challenge; refuses redirects, wrong host/payee/asset | `src/requirements.ts` | MOCK + LIVE |
| 5 | Spending policy: $0.01/payment, $0.25/day, $2/swap, **$5/day swap cap**, approval rules, allow-lists | `src/policy.ts` | MOCK |
| 6 | Payment planner: direct vs convert, cost, gas, blockers, explanations | `src/planner.ts` | MOCK; direct path LIVE |
| 7 | Single authorization gate (only the planner mints spend permission; enforced by a test) | `src/authorization.ts`, `test/safeguards.test.ts` | MOCK |
| 8 | Direct x402 payment executor: lock, journal-before-send, duplicate guard, daily limit, verification, receipt, response body saved | `src/executor.ts` | MOCK + **CHAIN: 2 payments** (see D) |
| 9 | Independent settlement verification (authorization state + Transfer log) | `src/verify.ts` | MOCK + CHAIN |
| 10 | Receipts (schema v1, records real route/conversion/order), history, evidence | `src/receipt.ts`, `src/history.ts`, `src/activity.ts` | MOCK + LIVE |
| 11 | Cross-process lock, pending-payment journal, crash safety, real multi-process tests | `src/lock.ts`, `test/concurrency.test.ts` | MOCK (real OS processes) |
| 12 | Textile FX v2 integration: preview, firm quote, strict quote validation, tagged approve + swap | `src/textile.ts`, `src/swapquote.ts`, `src/reactor.ts`, `src/swapexec.ts`, `src/swapchain.ts` | MOCK + **CHAIN: 1 swap** |
| 13 | Mento V3 integration: quote, approve + swap through the Router | `src/mento.ts`, `runAmmSwap` | MOCK + **CHAIN: 1 swap** |
| 14 | ERC-8021 attribution on every Payrail-submitted tx, checked before and after sending | `src/attribution.ts`, `src/swapquote.ts` | **CHAIN: 4 txs verified with Celo `verifyTx`** |
| 15 | Swap journal, exact-block balance reconciliation, quote cancel, UNCERTAIN handling, `resolve.ts --swap` | `src/swapjournal.ts`, `scripts/resolve.ts` | MOCK; resolve path used LIVE once (Mento) |
| 16 | Bounded non-interactive confirmation (`--auto-confirm --max-sell --min-receive`) | `src/liveswap.ts` | MOCK + used LIVE |
| 17 | Daily cumulative swap cap, enforced in preflight and again inside the swap lock | `src/swapjournal.ts`, `src/swapexec.ts` | MOCK |
| 18 | Order orchestrator: plan, preflight, convert, wait for funds, re-price, pay, verify | `src/orchestrator.ts`, `src/orderstore.ts`, `scripts/order.ts` | MOCK + **1 LIVE direct order (CHAIN)** |
| 19 | Order-aware duplicate guard (new orders allowed, same plan/order refused; pending journal always blocks) | `src/history.ts`, `src/executor.ts` | MOCK; direct order LIVE |
| 20 | Approval bound to a digest of the exact plan; order-level lock | `src/orchestrator.ts` | MOCK (digest shown LIVE in plan output) |
| 21 | Order recovery: `reconcileOrder`, `resumeOrder`, mismatch checks, retryable chain errors | `src/orchestrator.ts`, `src/orderwiring.ts` | **MOCK only** |
| 22 | Payment resolution (`resolve.ts --payment`): separate resolution record, receipts never edited | `src/paymentresolve.ts` | **MOCK only** |
| 23 | Chain reader / conversion verifier / funds-wait | `src/orderwiring.ts` | MOCK + **LIVE read-only** (re-established both real swaps) |
| 24 | Evidence pack: ledger, orders, cross-checks, response-hash recomputation, `--verify` | `src/evidence.ts`, `scripts/evidence.ts` | LIVE read-only (see Findings) |
| 25 | Bug fix: OneDrive reparse points hid swap journals (`isFile()` false) | `history.ts`, `activity.ts`, `evidence.ts`, `orderstore.ts` | Found LIVE; MOCK regression test skips here (symlinks not permitted) |
| 26 | Bug fix: unconfirmed conversion was recorded as CONFIRMED, stranding the order | `src/orchestrator.ts` | MOCK |
| 27 | Hardened lock against transient Windows `EPERM`/`EBUSY` | `src/lock.ts` | MOCK; cause of an earlier flake **unconfirmed** |
| 28 | Pay-direct rehearsal CLI keeps the strict "one payment unless --again" rule | `scripts/pay-direct.ts` | MOCK + LIVE |

**Mistakes made and corrected along the way** (so you know what was fixed): missed a USDm deposit through a filtered printout; a duplicate-payment hole before the journal/lock; planner ordering bug; lagging-RPC reconciliation mismatch; two rejected Textile quotes (executeBatch selector, preferred-filler validation) that stopped before any swap.

---

## C. Current working functionality (what demonstrably works today)

| Area | Works today? | Confirmed how |
|---|---|---|
| Wallet and configuration | Yes. Address resolution, tag pinning, key-vs-address mismatch refusal | Code + live runs; Part 0 above |
| Service discovery | Yes when the gateway is up | Live plan on 2026-10-13 (`x.posts.search`) |
| Order planning (direct) | Yes | Live plan: READY, direct, digest stable across runs |
| Order planning (convert) | Plans in tests; never produced by the live wallet (it holds USDT) | MOCK only |
| Buy gateway / x402 payment | Yes — **2 real payments** | CHAIN: `0xfb012c51…17ac` and `0x57c3c046…57fe` |
| Payment authorization and settlement | Yes | Authorization `settled` + Transfer(payer→payTo) on-chain |
| Service delivery and response verification | Yes (second payment): HTTP 200, body saved, SHA-256 recomputed and matches | Independent hash recomputation 2026-10-13 |
| Stablecoin balances | Yes | Live reads, exact-block reads |
| Conversions (Mento) | Yes — 1 real swap USDm→USDT | CHAIN: approve `0xbe28a289…`, swap `0xa935302c…` |
| Conversions (Textile FX) | Yes — 1 real swap USDT→cNGN (1,365.928991 cNGN) | CHAIN: swap `0xab592f83…` |
| Attribution tagging | Yes on approve/swap txs Payrail sends; **not** on x402 (by design) | `verifyTx` on 4 txs |
| Receipts and evidence | Yes | `evidence/SUBMISSION-EVIDENCE.md` regenerated with 1 order, 6 txs |
| Order history | Yes (`scripts/history.ts`, orders linked to their swap and payment) | MOCK + live files |
| Spending limits | Yes ($0.01/payment, $0.25/day, $2/swap, $5/day swaps) | MOCK; limit refusals not triggered live |
| Recovery mechanisms | Exist in code | **MOCK only** |

Not present in the codebase at all: ERC-8004 agent registration, any web UI, any README or setup guide, version control (no git repository), a second service provider besides Buy.

---

## D. Testing and verification status

Fresh run on 2026-10-13: **`tsc` exit 0; 289 tests, 289 pass, 0 fail** (about 86 s). One earlier full run had a single failure in the multi-process lock test that did not repeat in 3 isolated runs and a later full run; cause not confirmed.

| Feature or flow | Unit/mock tests | Live testing | Independent verification | Current status | Evidence or remaining gap |
|---|---|---|---|---|---|
| Config + tag enforcement | Yes | Yes | On-chain tag on 4 txs | **Verified** | — |
| Catalog + 402 discovery | Yes | Yes (read-only) | n/a | **Verified** (gateway availability varies) | Gateway returned HTTP 500 on 2026-10-12/13 at times |
| Direct x402 payment | Yes | 2 real payments | On-chain Transfer + authorization state + response hash | **Verified** | — |
| Order flow, direct route | Yes | 1 real order | Receipt, order file, chain, evidence all agree | **Verified** | One data point |
| Order flow, convert-then-pay | Yes | **None** | None | **Mock only** | Section F1 |
| Mento swap (standalone) | Yes | 1 real swap | On-chain + `verifyTx` | **Verified** | Mento *paying a service* (findRoute) is mock only |
| Textile swap (standalone) | Yes | 1 real swap | On-chain + `verifyTx` | **Verified** | Reverse corridor (cNGN→USDT) never run live |
| Swap crash recovery (`resolve.ts --swap`) | Yes | Used once | On-chain re-verification | **Partly verified** | One real case |
| Order `--reconcile` / `--resume` | Yes (many cases) | **None on a real interrupted order** | Verifier re-established 2 real swaps (read-only) | **Partly tested** | Section F2 |
| Payment resolution (`--payment`) | Yes | **None** | None | **Mock only** | No real UNCERTAIN payment exists to test |
| Evidence + `--verify` | Yes | Yes (read-only) | Hash recomputed; txs re-checked | **Verified**, with a caveat | RPC returns "not found" intermittently for older txs (Findings) |
| Duplicate/lock/limit safeguards | Yes incl. real processes | Exercised by live payments | n/a | **Verified (mock)** | Limit *refusals* never hit live |
| Daily swap cap, order lock, digest | Yes | Digest seen live; others no | None | **Mock only** | — |
| OneDrive symlink handling | Regression test skips here | Bug found and fixed live | Evidence now lists the 4 swaps | **Verified indirectly** | Test cannot run on this machine |
| Chain reader error handling | Yes | Not-found vs error not triggerable on demand | — | **Partly verified** | See Findings |

### Findings from this audit

1. **Public RPC is inconsistent for older receipts (new, important).** Querying `forno.celo.org` repeatedly for the same old transactions returned "found" and `null` alternately (e.g. `0xbe28a289…`: found, found, null, found, null, null, null, found). Recent tx `0x57c3c046…` was found 8/8. Today's evidence re-check reported 2 then 1 "could not be looked up" warnings for this reason. Consequence: `createChainReader` treats "not found" as definitive, so a real, mined swap can look "not established". It fails **closed** (no payment, re-checked next time since the 2026-10-13 fix), but it can wrongly stall an order and produce false evidence warnings.
2. The committed `evidence/SUBMISSION-EVIDENCE.md` (191 lines) pre-dates the newest cross-checks; regenerating produced the same facts plus a response-file hash line. It should be regenerated once the RPC issue is handled.
3. `.env.example` lists only 3 variables; the wallet address and key are not active entries.
4. There is no version control; the only copy of the code lives in a OneDrive folder.

---

## E. Everything still to be done

Priority: Critical / High / Medium / Low. "Needs" = organizer reply, live tx, signing, spending, or other external action.

### E1. Critical blockers (before submission)

| # | What | Why | Pri | Depends on | Verify by | Needs |
|---|---|---|---|---|---|---|
| E1.1 | Find out exactly which wallet address(es) the developer wants and send the right one | A wrong address could void the submission | Critical | Organizer reply | Their written answer matches the address you send | Organizer clarification |
| E1.2 | Get the real submission instructions (how/when to submit payment hashes, forms, deadlines) | Nothing is documented in the project | Critical | Organizer reply | Instructions stored in this file | Organizer clarification |
| E1.3 | Provide payment proof the way they ask: two confirmed x402 payments exist | This is the stated Build-with-Buy evidence | Critical | E1.2 | Hashes + services listed; evidence file regenerated | None (already have them) |

### E2. Core functionality

| # | What | Why | Pri | Depends on | Verify by | Needs |
|---|---|---|---|---|---|---|
| E2.1 | One live convert-then-pay order | The product's headline claim ("pay in your currency") is unproven live | High | E3.1; a way to force the convert route (F1) | Order COMPLETED; swap + payment on-chain; evidence shows one order with 3 txs | **Your approval, spends ~$1 conversion + gas + $0.005** |
| E2.2 | Live proof of `--reconcile` / `--resume` | Recovery has only ever run on fakes | Medium | A real interrupted order (cannot be created safely on demand) | Section F2 | Possibly never needed; see F2 |
| E2.3 | Decide whether Payrail must register an ERC-8004 agent | Only matters if the organizers require it | Medium | Organizer reply | Their answer | **Registration is signing + gas; needs your approval** |
| E2.4 | A second service or provider path beyond `x.posts.search` | Shows the layer is generic (the registry exists, only Buy is registered) | Low | None | A second service planned and paid in a test | Optional |

### E3. Testing and reliability

| # | What | Why | Pri | Depends on | Verify by | Needs |
|---|---|---|---|---|---|---|
| E3.1 | Make the chain reader robust to the inconsistent RPC: bounded retries before concluding "not found", optional second RPC via `PAYRAIL_RPC_URL` | Finding 1 | High | None | Repeated read-only checks of old txs no longer produce warnings; tests added | None (read-only) |
| E3.2 | Find and fix the cause of the occasional lock-test failure | An unexplained flake undermines trust in the suite | Medium | None | 20 consecutive full runs pass | None |
| E3.3 | Test limit refusals against a live gateway without paying (e.g. a plan that exceeds the cap) | Limits were only exercised by mocks | Low | None | Plan shows POLICY_BLOCKED | None (read-only) |
| E3.4 | Version control (git) and a backup | One OneDrive folder is the only copy | High | None | Repository initialised, secrets excluded | None |

### E4. Security and spending safeguards

| # | What | Why | Pri | Depends on | Verify by | Needs |
|---|---|---|---|---|---|---|
| E4.1 | Review `.gitignore`/OneDrive exposure before any git push (`.env`, receipts) | Avoid publishing wallet-linked data | High | E3.4 | No secrets in the repo | None |
| E4.2 | Decide whether to keep the rehearsal wallet's funds minimal | Hot key on a laptop | Medium | None | Balance reviewed | Your decision |
| E4.3 | Re-audit the approval digest and recovery flows once live runs exist | Safeguards only mock-tested | Medium | E2.1 | Review notes | None |

### E5. Hackathon requirements

| # | What | Why | Pri | Depends on | Verify by | Needs |
|---|---|---|---|---|---|---|
| E5.1 | Confirm tag rules for x402 vs Payrail-submitted txs in writing | Currently relayed only | High | Organizer reply | Written answer saved | Organizer |
| E5.2 | Confirm track(s) and whether multi-track is allowed | Unconfirmed | Medium | Organizer reply | Written answer | Organizer |
| E5.3 | Confirm judging criteria | Unknown | Medium | Organizer reply | Written answer | Organizer |

### E6. Documentation and submission

| # | What | Why | Pri | Depends on | Verify by | Needs |
|---|---|---|---|---|---|---|
| E6.1 | README: what Payrail is, setup, commands, safety model | None exists | High | None | A newcomer can run the read-only plan from it | None |
| E6.2 | Architecture explanation (plan → authorize → execute → verify → record) | Judges need to understand it | High | None | One-page diagram/text | None |
| E6.3 | Demo instructions or recording; screenshots | Likely required by a submission | Medium | E1.2 | Demo script works from a clean checkout | Depends on organizer format |
| E6.4 | Regenerate `evidence/` after E3.1 and any new live order | Keeps proof current | High | E3.1 | Zero warnings | None |

### E7. Optional improvements

- Web or chat front-end for orders (Low).
- More currencies/corridors and a second conversion venue in live use (Low).
- Human-friendly notifications for orders needing attention (Low).

---

## F. The unproven flows, investigated

**Status of each gap as of today:** all still exist. None was resolved by the last round of work.

### F1. Live convert-then-pay order — STILL UNPROVEN
- **Why it cannot happen on its own:** the planner pays directly whenever the wallet holds *any* accepted asset (USDT/USDC/USAT) in sufficient amount. The wallet holds 0.636223 USDT, so every plan is "direct". Verified live on 2026-10-13.
- **What is needed to test it safely** (nothing below has been done):
  1. A way to force the convert route **without moving funds**. There is currently **no setting** for this (`policyFromEnv` has no override for the allowed payment assets). It needs a small, reviewed code change, e.g. an env override such as `PAYRAIL_ALLOWED_PAYMENT_ASSETS=USDC` (then USDT is not a permitted payment asset and the planner must convert). Needs your approval to implement.
  2. Confirm a live Textile corridor exists for the chosen source asset (cNGN → the accepted asset); cNGN→USDT was listed as live earlier, the reverse of what has actually been swapped. A read-only `scripts/routes.ts` / plan will show this.
  3. Run the **plan only** and read it: it must say SWAP_REQUIRED with a conversion fee and a gas estimate.
  4. Run with bounded limits (`--auto-confirm --max-sell … --min-receive …`).
- **Maximum exposure** (indicative; to be recomputed from the plan): one conversion at about the venue minimum (~$1, roughly 1,363 cNGN), conversion fee ≈ 1 bp, gas roughly 0.01 CELO, then a $0.005 payment. No other funds move.
- **Needs:** your explicit approval of the exact command and the code change. I will not run it otherwise.

### F2. `--reconcile` / `--resume` on a genuinely interrupted order — STILL UNPROVEN
- A real interrupted order does not exist and should not be created deliberately with real money.
- **What has been verified live (read-only):** the exact function `--reconcile` uses to establish a conversion re-established both real swaps from the chain, and correctly rejected a wrong wallet.
- **What is covered by mocks:** crash after swap journal, after receipt, after payment journal, before journal; transient chain failure; mismatched swap; concurrent resumes; payment resolution outcomes.
- **Safe way to gain confidence without spending:** (a) `node --env-file=.env scripts/order.ts --reconcile b5660887-…` on the real completed order — **run on 2026-10-13: it reported "order is already COMPLETED" and changed nothing** (the order file's `updatedAt` is unchanged). This proves the command runs against real data; it does **not** exercise the interrupted-order paths. (b) after E3.1, repeat the read-only verifier check on the real swaps several times.
- **Needs:** nothing external for (a) and (b).

### F3. Other flows that are mock-only
- Payment resolution (`resolve.ts --payment`): no real UNCERTAIN payment exists.
- Mento used to *pay for a service* (`findRoute`): only the standalone swap has run live.
- Daily swap cap refusal, order lock contention, digest refusals: mocks only.
- Textile reverse corridor and Textile quote cancel endpoint: mocks only.

### F4. Inconsistencies found between code, documentation and requirements
- No documentation file exists, so nothing can contradict the code — which is itself a gap (E6).
- `scripts/rehearse.ts` still lists "organizer answers: Build with Buy requirements, ERC-8004, multi-track, attribution evidence" as missing; the organizer clarification answered only part (tag not needed for Buy; payTo + services + proof required).
- The organizer message asks for "your payTo wallet address", but Payrail is a payer (see Part 0).
- Findings 1–4 in Section D.

---

## G. Organizer questions and external dependencies

**Already asked (per project notes; replies partial):**

| Question | Status |
|---|---|
| Build with Buy requirements | Partly answered (services + proof of payments; no tag) |
| Attribution evidence for untagged x402 | Answered (no tag needed for Buy) |
| ERC-8004 agent registration required? | **Not answered** |
| Multi-track submission allowed? | **Not answered** |

**Still to ask (do not treat as resolved):**

| # | Question | Why |
|---|---|---|
| G1 | When you say "your payTo wallet address", do you want (a) the wallet that **paid** — `0x652C…D2a4` — or (b) the address that **received** the x402 payments — the gateway's `0x20fa…333B`? Do you also need a separate "agent" or "communication" address? | Part 0: the answer decides what to submit |
| G2 | How and when must payment transaction hashes be submitted (form, email, repo, deadline)? | None documented |
| G3 | What are the next-stage forms and their deadlines? | You are waiting |
| G4 | Which transactions are eligible/required for attribution (only ones Payrail submits itself: approvals and swaps)? Is a conversion required, or is the Buy usage enough? | Avoids doing unnecessary live conversions |
| G5 | Is ERC-8004 registration required, optional, or out of scope? | Registration needs signing and gas |
| G6 | May one project enter more than one track? | Unanswered |
| G7 | What are the judging criteria and demo format? | Unknown |
| G8 | Are the two x402 payments (Oct 12 and Oct 13) both acceptable, or do they want a payment made after a specific date? | Prevents repeating live payments |

---

## H. Final master checklist (in recommended order)

| Status | Pri | Item | Done when |
|---|---|---|---|
| [x] | — | Project builds; types check; tests pass (289/289) | `tsc` exit 0, all tests pass on a fresh run |
| [x] | — | Wallet address verified as the payer (Part 0) | Config, order, receipt and chain all match |
| [x] | — | Direct x402 payment proven on-chain (2 payments) | Evidence file lists both with settlement proof |
| [x] | — | Delivery proof retained (second payment) | Response SHA-256 recomputed and matches |
| [x] | — | Mento swap + Textile swap executed with the tag, verified on-chain | `verifyTx` on 4 txs |
| [x] | — | Duplicate/limit/lock/journal safeguards implemented and tested | Mock + multi-process tests |
| [!] | Critical | **E1.1/G1: Learn which wallet address the developer needs** | Written answer received |
| [!] | Critical | **E1.2/G2–G3: Get submission/payment-hash/forms instructions** | Written instructions stored here |
| [~] | High | E3.1: Make chain reads robust to inconsistent RPC | Old txs verify without warnings on repeated runs |
| [~] | High | E6.4: Regenerate evidence after E3.1 | Zero warnings; fresh `SUBMISSION-EVIDENCE.md` |
| [ ] | High | E3.4/E4.1: Put the project under version control (secrets excluded) | Repository exists; `.env`/receipts reviewed |
| [ ] | High | E6.1–E6.2: README + architecture explanation | A newcomer can follow it |
| [~] | High | E2.1: Live convert-then-pay order | Order COMPLETED, 3 txs on-chain *(needs your approval + a force-convert option)* |
| [~] | Medium | F2: `--reconcile` on the completed order (done 2026-10-13: "already COMPLETED", no change); interrupted-order paths still mock-only | A real interrupted order reconciles correctly, or the limitation is stated in the submission |
| [~] | Medium | Payment resolution, Mento-pays-service, caps and refusals live | Mock-only today; see F3 |
| [!] | Medium | E2.3/G5: ERC-8004 decision | Organizer answer; if required, your approval to register |
| [ ] | Medium | E3.2: Fix the intermittent lock-test failure | 20 consecutive full runs pass |
| [ ] | Medium | E6.3: Demo script / recording / screenshots | Matches the organizers' format |
| [!] | Medium | G4–G8: remaining organizer questions | Answers recorded in Section G |
| [ ] | Low | E2.4 second service/provider; optional UI | Optional |

### Concise summary of current state
Payrail works end to end for the **direct** path: it found a real service price, chose to pay directly, paid exactly 0.005 USDT twice, verified settlement independently, saved the delivered response and produced evidence. It has also executed one real Mento swap and one real Textile swap, all Payrail-submitted transactions carrying the official tag. The **convert-then-pay** flow and the **crash-recovery** features are implemented and mock-tested but have never run live. Nothing is documented for judges (no README), and the submission requirements are still unknown.

### The three most important next steps
1. Get answers to G1–G3 from the organizers (which wallet, how to submit hashes, forms).
2. Fix the inconsistent-RPC weakness (E3.1) and regenerate the evidence (E6.4) so the proof you submit is clean and reproducible.
3. Write the README/architecture notes and put the project under version control (E6.1, E6.2, E3.4).

### The single next task to start with
**E3.1 — make chain reads robust to the inconsistent RPC.** It is read-only (no funds, no signing), it fixes a real weakness found today that could produce false "not established" results in recovery and false warnings in the evidence you may submit, and it unblocks regenerating clean evidence. Waiting for the organizers does not block it.

### What "Payrail is complete and ready to submit" means here
All of the following are true:
1. The organizers' written instructions are recorded and followed (wallet address, payment-hash submission, forms).
2. The wallet address submitted is the one they asked for, verified against the chain.
3. The evidence pack is regenerated, has zero warnings, and lists the services used and proof of payments (hashes, payTo, payer, delivery proof).
4. A fresh `tsc` and full test run pass, and the results are stated honestly (mock vs live vs on-chain).
5. A README and architecture explanation exist and a newcomer can run the read-only plan from them.
6. Any claim about convert-then-pay in the submission is backed by a live on-chain order — or the submission states clearly that this path is mock-tested only.
7. No unresolved pending journals, and no secrets in anything submitted.

---

## Appendix: quick reference

- **Payer wallet:** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4` · **payTo (gateway):** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **Tag (do not change):** `celo_b2fff2ac9413`
- **Real transactions:** x402 `0xfb012c514207add68399c8c575d89e9c352c94ac8131378d8e1ffa233f8217ac` · Mento approve `0xbe28a28915b7da5772cce9eb38121ebc472ea6d3dbddb9a7c223cdb2b4a80159` · Mento swap `0xa935302cf2629db8b9b12003aba76e8986d5b69ca25af23ec25672b97847d953` · Textile approve `0xf862f1b78a64d0451c214d72efdf018baa41ebb58aac3c320f045f88df1c103b` · Textile swap `0xab592f83fe659607fff8c8892373c89bb396348028761fa8844c42f82a1d1c0c` · x402 (order) `0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe`
- **Order:** `b5660887-a162-4116-ab65-c2a86512a7c6` (COMPLETED, direct)
- **Read-only commands:** `node scripts/order.ts --service x.posts.search` (plan) · `node scripts/history.ts` · `node scripts/evidence.ts --verify` · `npm run check`
- **Spending commands (need your explicit approval each time):** `scripts/order.ts --execute`, `scripts/convert.ts --execute`, `scripts/pay-direct.ts --pay`
