# Marketplace funding through Textile (cNGN → USDT → marketplace balance)

> **Status: SIMULATION + automated tests + browser-verified. NOT verified on a testnet. NOT verified with real funds.**
> The live adapter exists but is deliberately not wired into the server. Nothing here has converted real cNGN.

## What was found (architecture audit)

| Question | Finding |
|---|---|
| How does the Buy order flow convert? | `planner.planConversion` → `authorizeConversion` → `swapexec.runSwap` with bounded confirmers, in `orchestrator.ts` (and standalone in `scripts/convert.ts`). Textile is an RFQ: a market maker signs an order; **the wallet is the taker** and calls the reactor. |
| Where does the USDT arrive? | **At the signing wallet.** The reactor pays the input token to `msg.sender`; the order has no recipient parameter. A conversion can never deliver straight to a different deposit address. |
| Who signs? | One server wallet key (env file or keystore unlock). Marketplace buyers are anonymous accounts that hold **no keys**. |
| How is output verified? | Fill event + balance deltas + receipts in `swapexec`/`swapchain`. |
| Can the Buy conversion fund the marketplace as-is? | **No.** It is bound to a Buy order, and it converts the *operator wallet's* funds. Reusing it for buyers needs (a) a custody decision, (b) a restriction on who may trigger it. Both are handled below; neither was assumed. |
| Testnet support? | The Textile route, cNGN and USDT are configured for Celo **mainnet** only. No Textile testnet endpoint or cNGN/USDT testnet deployment is configured, so **Stage C could not be run**. The Sepolia testnet holds only our mock token and escrow. |

## Components reused unchanged

`planConversion`, `authorizeConversion`, `runSwap`, `boundedConfirmers`, `createConversionDeps`, `createLiveSwapDeps`,
the Textile reactor constant and Fill event, the ledger (`deposit`, `verifyLedger`, immutability triggers), `ChainReader`
and `createViemReader`, the billing/escrow/agent paths (untouched).

## New code

| File | Purpose |
|---|---|
| `src/marketfunding.ts` | Funding engine: quote, approval digest, state machine, independent verification, once-only credit, recovery |
| `src/simfunding.ts` | Simulated Textile conversion + fake chain, run through the **same** verification code |
| `src/livefunding.ts` | Live adapter around the existing conversion pipeline. **Not wired.** |
| `src/db.ts` (migration v7) | `funding_ops`, append-only `funding_events`, `funding_tx_claims` |
| `src/market.ts` | `/api/market/fund/*` routes |
| `web/market.*` | "Add funds" card (Buyer tab) |
| `scripts/funding-quote-live.ts` | Read-only plan of the live adapter's quote path |
| `scripts/browser/verify-funding.mjs` | Real-browser regression |
| `test/marketfunding*.test.ts` | 12 engine tests + 3 HTTP tests |

## Flow

```
amount typed ──► quote (nothing converted) ──► summary shown ──► buyer approves the quote's digest
   ──► CONVERTING ──► converter submits ──► VERIFYING ──► receipt read by Payrail itself ──► CREDITED
```

1. **Quote.** Amount validated against min / max / rolling-24h / open-operation limits. A converter quote is stored as
   `QUOTED` with an `approvalDigest` over (operation, buyer, amount, minimum, expected, quote id, expiry, mode, credit asset).
2. **Approval.** Only `POST /fund/approve` with the exact digest moves the operation (compare-and-set), so repeats and races
   convert once. Expired quotes become `EXPIRED` and are never executed.
3. **Conversion.** The converter submits the conversion. Simulated: a fake chain. Live (when wired): the existing
   `runSwap` with confirmers bounded to exactly the approved sell amount and minimum receive.
4. **Verification.** `verifyConversion` reads the swap receipt: success status, enough confirmations, a **Fill from the
   Textile reactor with this wallet as filler**, and **USDT (exact token contract) Transfer logs to the intended
   recipient**. A converter's own "success" is never enough.
5. **Credit.** The verified amount (must be ≥ the agreed minimum) is credited via the ledger `deposit` with reference
   `fund:<opId>`.

## States

| State | Meaning | Spendable? |
|---|---|---|
| `QUOTED` | Quote only; nothing converted | no |
| `CONVERTING` / `VERIFYING` | In flight / waiting for confirmations | no |
| `UNRESOLVED` | Outcome unknown (uncertain submit, chain unreadable, tx not visible). Re-checked; **never auto-failed** | no |
| `CREDITED` | Verified and credited once | **yes** |
| `FAILED` | Provably nothing converted (refused, reverted) | no |
| `REVIEW` | Landed but wrong token / recipient / no Fill / below the minimum / tx already claimed. Needs an operator | no |
| `EXPIRED` / `CANCELLED` | Never executed | no |

## How duplicate credits are prevented

* Ledger deposit reference `fund:<opId>` is `UNIQUE (kind, ref)`; a repeat returns `created:false`.
* `funding_tx_claims.tx_hash` is a primary key: a swap transaction can fund **one** operation for **one** buyer.
* Approval is a compare-and-set on state; idempotency keys cover quotes.
* Crash windows are covered by tests: after submit/before verify, after credit/before state update, before any tx recorded.
* `funding_events` is append-only (triggers). Ledger entries stay immutable.

## Separation of test and real funds

Simulated funding credits asset **`TESTUSDT`** and is labelled SIMULATED everywhere. Real funding would credit `USDT`
and requires real-funds mode. A live converter is refused unless real-funds mode is on and the buyer is in
`allowedBuyerIds`. Simulated funding does not consume the capped test-credit grant.

## Verification levels

| Level | What |
|---|---|
| Automated tests (465 total) | quotes, limits, expiry, approval, success, reverted/refused/mismatch/short/uncertain, delayed confirmation, recovery, duplicate tx, cross-buyer, agents, escrow separation, ledger reconciliation |
| Browser (headless Edge, 13 checks) | quote, approval, reload, credited, failed, review, delayed, spend |
| Live read-only | `scripts/funding-quote-live.ts` reached the live Textile preview; the wallet holds ~2.26 cNGN, so it correctly reported `INSUFFICIENT_BALANCE` (1364) and `BELOW_MINIMUM` (2). **No live quote mapping was verified.** |
| Testnet | **Not available** (see audit). Not claimed. |
| Real funds | **Not done.** |

## Real-funds readiness checklist (do NOT do without explicit approval)

1. **Custody decision.** Textile delivers to the signing wallet, so either (a) the marketplace deposit/custody address *is*
   the signing wallet, or (b) build a bounded second hop (USDT transfer to the deposit address, only after verified
   conversion, only to the configured address, idempotent). (b) is a new signing path and needs its own review.
2. **Who may fund.** Set `allowedBuyerIds` to the operator's own buyer account. Anonymous buyers must not be able to spend
   operator cNGN. Per-buyer funding from buyers' own wallets needs browser-wallet signing (a different design).
3. **Wire it.** In `scripts/serve.ts`, inside the explicit `PAYRAIL_MARKET_LIVE=1` branch: `createLiveFundingConverter`
   with `createConversionDeps(live, policy)`, `makeSwapDeps` bound to the unlocked account, `reader: createViemReader(rpcUrls)`,
   `creditAsset: 'USDT'`, `minConfirmations` ≥ 20, `recoverFunding` at start-up.
4. **Configuration.** `PAYRAIL_MARKET_LIVE=1`, `PAYRAIL_DEPOSIT_ADDRESS`, `PAYRAIL_VAULT_KEY`, keystore unlocked, funding limits.
5. **Operator tooling for `REVIEW` operations** (not built): inspect receipt, then credit or reject with an audit entry.
6. **A funded wallet.** At least the Textile corridor minimum in cNGN (the wallet currently holds far below it).
7. **First run** with the smallest corridor amount, plan-only first (`scripts/funding-quote-live.ts`).

## Known limitations

* The live adapter holds the plan in memory between quote and approval; a restart makes the quote stale (safe: it fails closed).
* The simulation chain is in-memory; operations in flight when the *simulated* server restarts stay unresolved.
* `REVIEW` has no resolution tool yet.
* Funding credits are in the ledger; escrow-settled purchases use the separate on-chain escrow balance.
