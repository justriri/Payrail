# Payrail architecture

This document explains how Payrail is built and why. It describes what exists in the code today. Where
something is *not* implemented or not yet verified live, it says so.

## The one-sentence idea

**Plan → authorize → execute → verify → record**, with a hard wall between *deciding* and *spending*.

```
            read-only                      the only gate               can spend (each behind its own gates)
 ┌───────────────────────────┐   ┌────────────────────────┐   ┌───────────────────────────────────────────┐
 │ catalog → requirements →  │   │ authorizeExecution /   │   │ executor.ts   (x402 payment)              │
 │ planner (+ policy, routes)│ → │ authorizeSwap          │ → │ swapexec.ts   (Textile / Mento swaps)     │
 └───────────────────────────┘   │ (planner.ts, mints)    │   │ orchestrator.ts sequences them            │
                                 └────────────────────────┘   └───────────────────────────────────────────┘
                                                                           │
                                       receipts / journals / orders / evidence  ←  verify.ts, chainread.ts
```

## Modules

| Module | Responsibility |
|---|---|
| `config.ts` | Loads env settings. Pins the attribution tag and token addresses; refuses a wrong tag/chain; derives the wallet address from the key if one is loaded |
| `catalog.ts`, `buy.ts`, `providers.ts` | Service catalog (normalised, validated), the Buy provider, a registry that can hold more providers |
| `requirements.ts` | Reads the real price from an unpaid 402 challenge and validates it |
| `assets.ts` | The registry of known tokens (decimals, USD-stable flag, x402-signable flag) |
| `policy.ts` | Spending limits, allow-lists, approval rules (pure functions) |
| `routes.ts`, `textile.ts`, `mento.ts` | Conversion venues: price a route, firm quotes (Textile), router quotes (Mento) |
| `planner.ts` | Decides direct vs convert, totals the cost, estimates gas, explains; the *only* place that mints authorizations |
| `authorization.ts` | The unforgeable permission objects the executors require |
| `executor.ts` | Executes one x402 payment: lock, guards, journal, pay, verify, receipt |
| `swapquote.ts`, `reactor.ts`, `swapexec.ts`, `swapchain.ts` | The swap pipeline: validate a quote, simulate, confirm, send, verify |
| `orchestrator.ts`, `orderstore.ts`, `orderwiring.ts` | The order flow and its persistence/wiring |
| `history.ts`, `activity.ts`, `receipt.ts` | Receipts, duplicate guard, unified history |
| `verify.ts`, `chainread.ts` | Independent settlement verification and reliable chain reads |
| `lock.ts` | Cross-process file locks |
| `paymentresolve.ts`, `swapjournal.ts` | Resolving uncertain payments; the swap journal and daily swap cap |
| `evidence.ts` | Builds the submission evidence pack |
| `attribution.ts` | The ERC-8021 tag gate (`assertTagged`, `withTag`) |

## 1. Service discovery and price discovery

1. `catalog.ts` fetches `GET /v1/catalog` from the Buy gateway and normalises every entry; malformed
   entries are isolated and reported, not fatal. Catalog prices are **indicative only**.
2. `requirements.ts` makes an **unpaid** request to the service. The HTTP 402 response is the price
   authority. It is checked: the payee, asset and resource must match, redirects are refused, the
   request body is validated against the service's schema, and the host must be allow-listed.
3. If the real price is far above the indicative one (`priceToleranceFactor`), the plan stops for review.

## 2. How the planner chooses direct vs conversion

`planPayment` (in `planner.ts`):

1. Reject endpoints policy does not allow; read the real 402 offers; keep offers on Celo, scheme `exact`,
   in assets Payrail can sign and policy permits.
2. Apply hard policy limits to the price first (a human cannot approve past a limit).
3. Read balances of the accepted assets and the allowed swap sources.
4. **If any accepted asset is held in sufficient amount → `DIRECT_PAY`** (the first by preference order).
5. Otherwise look for a conversion route: for each accepted target, for each held source, ask the
   configured providers (Textile, Mento) for the cheapest route that delivers at least the price.
6. Estimate gas for the approve and swap transactions, apply swap policy, and produce a plan with the
   route, cost, fee, gas, uncertainties and a plain-language explanation.

The result is a **`PaymentPlan`**. A plan has a 60-second validity window and is never stored.

## 3. Where spending authorization happens

Only `planner.ts` can mint spend permission (`authorizeExecution`, `authorizeSwap`,
`authorizeConversion`). Executors accept only objects minted there, and a structural test enforces that
no other module mints one. Each authorization re-checks: plan freshness, no blockers, approval present
when policy requires it, and the exact request body hash.

For orders, approval is **bound to a digest of the exact plan** (route, payee, asset, amount, venue,
costs). An approval for a different plan is refused, and the digest is recomputed at execution time.

## 4. How attribution tags are applied

- The tag is pinned in `config.ts`; a different value stops the program.
- For transactions Payrail itself sends (approvals, swaps, the ERC-8004 registration) the calldata is
  built, then `withTag` appends the ERC-8021 suffix and `assertTagged` verifies it *again immediately
  before signing*: exactly one Schema 0 code, exactly the official tag, canonical encoding, at the end.
- Tagged and untagged calldata are **both simulated** and must behave identically.
- After sending, Celo's `verifyTx` re-checks the on-chain transaction.
- **x402 payments are not tagged**: the gateway submits them. Payrail only signs the authorization.

## 5. How payments and conversions are executed and verified

### Direct payment (`executor.ts`)
1. Check the authorization, payer, request body and amount.
2. Take the cross-process lock; re-check duplicates and the daily limit *inside* the lock.
3. Re-read the balance; refuse if short.
4. **Write the pending journal, then send** one paid request through `@celo/buy-core`. Redirects are
   never followed; the challenge is re-checked before anything is signed.
5. Verify independently (`verify.ts`): the token's own authorization state and a matching
   `Transfer(payer → payTo, amount)` in the settlement transaction.
6. Save the exact response body (with its SHA-256) and write a receipt classified
   `CONFIRMED`, `REJECTED` (proven not settled) or `UNCERTAIN`.
7. Clear the journal only for resolved outcomes.

### Conversion (`swapexec.ts`)
1. Lock; single-use plan id; refuse if anything is unresolved; check the daily swap cap.
2. Approve exactly the needed amount (never unlimited) *before* requesting a firm quote.
3. Validate the real quote strictly (reactor, order structure, filler restrictions, amounts, deadlines).
4. Simulate, show the human (or a bounded auto-confirmer) the exact transactions, then send.
5. Verify from the receipt, logs and **exact-block** balance reads; an unexplained difference ends
   `UNCERTAIN`, never "success".

### Reliable chain reads (`chainread.ts`)
Public RPC nodes sometimes answer "receipt not found" for old transactions (some backends prune old
receipts). Lookups therefore ask several endpoints with bounded retries and distinguish **found**,
**receipt unavailable**, **not found**, **conflict**, **insufficient agreement** and **error**. Only a
validated receipt is evidence; every other outcome is inconclusive and can never turn a sent payment
into "failed" or trigger a repeat payment.

## 6. Orders, receipts, history, recovery and evidence

### Order flow (`orchestrator.ts`)
`planOrder` wraps the payment plan. `executeOrder` then: validates → checks the approval digest → takes the
**order lock** → runs a **preflight** (no unresolved journal, order not already paid, daily payment limit,
daily swap cap) → mints the first authorization → creates the order record → [converts] → waits for the
converted funds by exact-block reads → **re-prices** the service and re-checks payee, asset and the approved
ceiling → pays → records.

### Persistence (`receipts/`, written at run time)
| Path | Contents |
|---|---|
| `receipts/<id>.json` | Payment receipts (route, conversion link, order id, settlement, delivery hash) |
| `receipts/responses/` | The exact service response bytes |
| `receipts/swaps/`, `receipts/pending/` | Swap journals; unresolved items that block spending |
| `receipts/orders/` | Order records linking conversion, payment and delivery |
| `receipts/resolutions/` | Decisions about uncertain payments (receipts are never edited) |
| `receipts/registrations/` | The ERC-8004 registration record |

### Recovery
- `reconcileOrder` rebuilds an order's real state from the swap journal, an independent on-chain check
  and the payment receipts/journals. It sends nothing. A conversion is promoted only when the chain
  establishes it; a lookup that could not conclude changes nothing and can be retried.
- `resumeOrder` reconciles first, never repeats a conversion, and pays only when the conversion is
  established and no payment exists or may be in flight.
- `resolve.ts --swap` / `--payment` re-verify an uncertain swap or payment from the chain.

### Evidence (`evidence.ts`)
Builds a ledger of every real transaction (payments, approvals, swaps, registration), presents a
conversion and its payment as one order, cross-checks each order against its receipt and swap journal,
and with `--verify` re-checks the chain. Mock tests are never presented as transactions.

## 7. Spending limits and safeguards

| Safeguard | Where |
|---|---|
| Per-payment, per-day payment limits | `policy.ts`, re-checked inside the lock in `executor.ts` |
| Per-swap value and daily swap cap | `policy.ts`, `swapjournal.ts`, `swapexec.ts` |
| Allow-lists: hosts, payment assets, swap sources, conversion pairs | `policy.ts` |
| Human approval rules; approval bound to a plan digest | `policy.ts`, `orchestrator.ts` |
| Single authorization gate | `planner.ts`, `authorization.ts` |
| Journal before send; unresolved journal blocks everything | `history.ts`, `executor.ts`, `swapexec.ts` |
| Cross-process locks (execution and order) | `lock.ts` |
| Order-aware duplicate guard | `history.ts` |
| Tag gate and tagged/untagged simulation equality | `attribution.ts`, `swapquote.ts` |
| Plan expiry (60 s) and single-use plan ids | `planner.ts`, `swapexec.ts` |
| Unlimited approvals are never requested | `swapquote.ts` |

## What is *not* done / not live-verified

- Convert-then-pay inside a single order has been exercised only with fakes.
- `--reconcile` and `--resume` on a real interrupted order, payment resolution on a real uncertain
  payment, and paying a service through Mento are mock-tested only.
- Only one service provider (Buy) is registered.
- There is no graphical interface.
- Version control, README and these documents were added late; see `PROJECT-MASTER-CHECKLIST.md`.
