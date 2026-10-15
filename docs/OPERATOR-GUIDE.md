# Operator guide: review, recovery and reconciliation

Everything here is **verification-first**. There is no button that marks a transaction paid or credits a buyer. An operator
can only ask Payrail to *look again*, supply a transaction hash *to be verified from the chain*, or *close* an item
without crediting anything. Every action is written to the append-only audit log and to the item's own event history.

## 1. See what needs attention
`node scripts/operator.ts queue [--db data/marketplace.db] [--failed]`

| Category | Meaning | Money status |
|---|---|---|
| review-required | Something did not verify (wrong amount/recipient/token, missing deposit record). | Not credited / not paid. Not refunded. |
| unresolved | Outcome unknown (no receipt yet) or swap done but delivery not proven. | Unchanged; USDT stays reserved until proven. |
| pending | In flight and still within normal time. | Unchanged. |
| failed | Provably did not happen (reverted/refused) or closed by an operator. | Earnings restored / nothing credited. |

`node scripts/operator.ts inspect funding|payout <id>` shows the quote, buyer/seller, expected asset and amount,
transaction references, failure reason, every state change and every operator action.
Items marked `(SIMULATED)` involve no real funds.

## 2. Safe actions (library: `src/operator.ts`)
| Action | When | What it does |
|---|---|---|
| `recheckItem` | item has a tx | Re-runs the engine's independent verification. Once-only credit/completion. |
| `retryPayoutDelivery` | swap verified, delivery not | Re-attempts **only** the delivery transfer. Never swaps again. |
| `attachFundingDepositEvidence` | funding REVIEW/UNRESOLVED, no deposit recorded | Records the tx hash as a claim, then verifies token, sender (the buyer's proven wallet), recipient (custody), amount and confirmations. A hash already used by anything else is refused. |
| `attachPayoutDeliveryEvidence` | payout review/undelivered | Same, against the seller's verified address. |
| `closeFundingWithoutCredit` | funding REVIEW/UNRESOLVED | Needs a written reason and an evidence reference. Credits nothing; history kept. |

If evidence does not verify, the item **stays** review-required/unresolved. An unverifiable transaction is never completed.

## 3. Reconcile
`node scripts/operator.ts reconcile` (exit code 2 if anything is off). Checks: ledger integrity, every CREDITED funding op has
exactly one ledger deposit (and vice versa), reserved payouts equal the ledger's `payout_pending`, no transaction hash is used
twice, and counts of open items.

## 4. Never
Do not edit the database by hand; do not enable `PAYRAIL_MARKET_LIVE` to "fix" an item; do not treat simulated items as real.
Live conversions and payouts are not wired in this build, so real-funds recovery is out of scope until they are.
