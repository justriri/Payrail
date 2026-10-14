# Payrail Marketplace

Outcome-based API marketplace on top of the existing Buy/x402 payment flow. **Pay only for responses that meet a
written contract.** The Buy flow (cNGN → USDT → x402) is unchanged and independent.

## What exists, and how it was verified

Verification levels: **T** = automated test (mock/fake network), **L** = local integration (real HTTP server, in-process
demo network), **R** = read-only check against the real chain, **X** = executed on-chain. Nothing in the marketplace is
level **X**.

| Area | Module | Level | Notes |
|---|---|---|---|
| Double-entry ledger, holds, fee, idempotency | `src/ledger.ts` | T | invariants re-derived by `verifyLedger` |
| Envelope-encrypted seller credentials | `src/vault.ts` | T | AES-256-GCM, per-secret key, wrapped by a master key outside the DB |
| SSRF-safe outbound gateway | `src/egress.ts`, `src/gateway.ts` | T | fake resolver/transport; no live SSRF probe run |
| Seller sign-in, listings, ownership (wallet signature **and** DNS TXT / well-known file) | `src/seller.ts` | T, L | real DNS/HTTPS not exercised |
| Contracts (versioned, immutable) + validator + tester | `src/contracts.ts`, `src/tester.ts` | T, L | |
| Execution: hold → call → validate → capture/release; `UNRESOLVED` on timeout | `src/execute.ts` | T, L | |
| Demo APIs with failure injection | `src/demoapis.ts` | T, L | in-process only |
| Merged catalog, buyer/seller API, screens | `src/market.ts`, `web/market.*` | L | page rendered and driven in headless Edge |
| On-chain deposit verification | `src/funding.ts` | T, **R** | parser run read-only against a real past transaction |
| Seller payouts state machine + operator CLI | `src/payouts.ts`, `scripts/payouts.ts` | T | `--send` never executed |
| Agent keys with caps | `src/agents.ts` | T, L | |
| Escrow contract | `contracts/` | T (forge), **X on Celo Sepolia testnet** | mock token; **mainnet: not deployed, unaudited** |
| Backend escrow settlement path | `src/escrow.ts` | T, **X on testnet** | hold→call→capture/release against the deployed testnet contract; chain re-read confirmed states; timeout expiry not waited out on-chain |

## Two modes, kept apart

* **Test credits** (default): ledger asset `TESTUSDT`. Capped per buyer. Can never be paid out.
* **Real funds** (opt-in, `PAYRAIL_MARKET_LIVE=1` + `PAYRAIL_DEPOSIT_ADDRESS`): ledger asset `USDT`.
  Deposits are credited only after the server verifies an on-chain Transfer from a wallet the buyer proved they control.
  Payouts are requested by sellers, approved and sent **only by the operator CLI**; the web server never signs.

The two assets are separate ledger assets, so test credits and real funds cannot mix by construction.

## Money rules

* The price is held before the seller's API is called. Captured only when the response satisfies the contract version
  pinned at request time. Otherwise released in full.
* Fee: `round_half_up(price × fee_bps / 10000)`, taken from the seller's share (default 3%), snapshotted at hold time.
* Unknown outcome (timeout, connection lost) ⇒ `UNRESOLVED`: held, never silently charged. Released to the buyer after
  a window (`RELEASED_UNRESOLVED`); the seller earns nothing from it.
* Idempotency per buyer key; a repeated key never calls the seller or charges twice.

## Known limits and trust assumptions

* **Custody:** real funds sit in the platform's deposit address; the ledger is the source of truth. A bug or compromise
  of the operator affects deposited funds. Deposit and payout caps exist because the system is new.
* **Qualifying is attested by the operator**, not proven on-chain. Contracts and evidence are stored and auditable.
* **Escrow contract**: deployed and exercised on Celo Sepolia only (see `contracts/*.testnet.json`). The backend still decides holds/captures (stated in the source). Escrow settlement is opt-in per request and disabled unless configured.
* **Ownership proof** depends on DNS/HTTPS at verification time; it is not re-checked continuously.
* **Seller can change behaviour** after approval; the contract bounds what is *paid for*, not what the API does.
* A one-sample contract suggestion is a starting point, not a guarantee of correctness.
* Browser wallet signing was not exercised with a real wallet extension.

## Operating it

```
node scripts/serve.ts --simulate                       # everything simulated, demo APIs seeded
node scripts/serve.ts --demo --env-file=.env           # live Buy flow read-only + test-credit marketplace
node scripts/payouts.ts --db data/marketplace.db --list
```
Set `PAYRAIL_VAULT_KEY` (32 bytes, hex or base64) so seller credentials survive restarts.
