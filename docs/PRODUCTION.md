# Payrail in production: what is real, what is verified, what is blocked

> Update 2026-10-23: the evidence table below predates Buy payments (`PAYRAIL_BUY_PAYMENTS`), in-app Textile conversion (`PAYRAIL_BUY_CONVERSION`), seller payout requests and GitHub verification. For those, [BUY-PAYMENTS.md](BUY-PAYMENTS.md) and the README's "What is verified" table are current. Nothing in the marketplace has been run with a real browser wallet on mainnet.

Payrail has **no demo, test-credit, sandbox or simulation mode**. `scripts/serve.ts` refuses `--simulate`, `--no-demo`,
`--escrow-testnet` and `--scenario`, seeds no demo APIs, builds no simulated provider, and starts the marketplace only when the
operator sets `PAYRAIL_MARKET_LIVE=1` (real USDT on Celo mainnet, chain 42220).

## Development environment (separate)
`npm run dev:market` starts `scripts/dev-serve.ts` on port 4403 with its own database in `data/dev/`. It shows test credits, demo and
sandbox APIs, a sandbox seller and a simulated Buy gateway, labelled DEVELOPMENT everywhere. It cannot open `data/marketplace-live.db`
or any file stamped `production` or holding verified on-chain deposits, it refuses to start if `PAYRAIL_MARKET_LIVE` is set, and it never
reads the production deposit address or vault key. The production server, in turn, refuses databases inside `data/dev/` or stamped
`development`, stamps its own database `production`, and has no route for the development scripts. See `test/environments.test.ts`.

## What the production server enforces (backend, not just screens)
- Anonymous buyers (`POST /buyer`) and test credits (`POST /credits`) are refused (`NOT_AVAILABLE`). Buyers exist only through a
  wallet signature that names the network and is single-use.
- `/me` reports real USDT balances only. Test-credit balances are never exposed or spendable.
- A listing is sellable only if it is priced in real USDT, is not a Payrail demo row and is not on the in-process sandbox host
  suffix. Everything else is invisible (`/catalog`, `/listing`, `/quote` return nothing) and unpurchasable (`/execute`,
  `/agent/execute` return `NOT_REAL_LISTING`) even if such rows exist in the database.
- Sellers cannot list a sandbox endpoint (`NOT_A_REAL_ENDPOINT`); every new listing is a real-USDT listing.
- Simulated conversion, simulated funding and simulated payout routes are refused in real-funds mode (`NOT_AVAILABLE`).
- Seller payout requests are refused (`PAYOUTS_DISABLED`) unless the operator opts in in code; nothing is paid out automatically.
- A deposit is credited only after the receipt shows success, enough confirmations, the USDT contract, the verified sending wallet
  and the deposit address; it is credited once per transfer, capped per deposit, and recorded with transaction hash, chain id, token,
  recipient, confirmations, verification status and time.
- A purchase is charged only for a validated outcome; failed, held or unverifiable outcomes are never charged. The 3% fee is unchanged.
- The server never signs for a buyer and holds no buyer key. It never requests a private key or seed phrase.
- Proven by tests: `test/production.test.ts` (rejections and on-chain verification), `test/production-graph.test.ts` (the production
  process never loads any `src/dev/` module) and the browser regressions below.

## What was removed from the product
Test credits, the anonymous test buyer, demo listings and their seeding, sandbox sellers and presets, the "Show demo APIs" toggle, demo
wallet and authorization shortcuts, simulation scenario pickers, simulated funding/conversion/payout screens, the testnet escrow
panel, demo/test copy on every page, and the `serve:sim` script. The Buy payment page no longer has a simulation banner.

## What remains, for development tests only
`src/dev/` (demo network, simulated providers, testnet escrow helper, scenario lists), `scripts/dev/` (Celo Sepolia escrow scripts)
and the non-real-funds branches of `src/market.ts` that the unit tests drive. `scripts/serve.ts` never imports them and always runs the
marketplace in real-funds mode. The browser regressions (`scripts/browser/harness.mjs`) run the PRODUCTION code with a FAKE chain
reader, a fake seller API and a fake wallet whose signatures come from a local test key; they never touch a network or real funds.

## Real-money flows: evidence
| Flow | Implemented | Verified |
|---|---|---|
| Wallet sign-in (buyer and seller) | yes | automated tests with local signers; **not with a real wallet extension** |
| Fund with USDT (one-click Pay or manual transfer + hash) | yes | automated tests and browser tests against a fake chain; your own mainnet deposit of 0.5 USDT was credited by the manual path (1 verified deposit on file) |
| Create, verify and publish a real API | yes | tests with fake DNS and fake seller API; **not against a real seller endpoint** |
| Pay and use an API (outcome billing, receipts, 3% fee) | yes | automated tests and fake-chain browser tests; **no real mainnet purchase yet** |
| Seller earnings accounting | yes | ledger tests and reconciliation |
| Currency conversion (cNGN and others) | built behind `PAYRAIL_BUYER_SWAP=1`, **off** | fake providers only; no live Textile firm quote or swap has been executed by this server |
| Seller payouts | **disabled** | the secure payout design (bounded signer, verified addresses, human approval) is not built |

## Blockers before wider production use
1. Run a controlled mainnet purchase end to end with a real wallet (runbook) and reconcile (`scripts/operator.ts reconcile`).
2. Custody: funds pass through the deposit address and ledger until spent; there is no on-chain escrow and no withdrawal path for buyers.
3. Seller payouts: design, build and review the bounded signer; until then earnings cannot leave the ledger.
4. Conversion: execute and verify each Textile route with a real buyer wallet before enabling it.
5. Operator tooling is CLI-only and read-only; there is no authenticated operator interface.
6. No third-party security review or audit has been done. Passing tests is not production readiness.

## Existing data
`node scripts/audit-legacy-data.ts <db>` reports (read-only) any legacy demo or test-credit rows in a marketplace file. They are hidden and
refused by production and are never deleted automatically. Starting the updated server applies two ADDITIVE migrations (9: per-role wallet
accounts, 10: extra deposit-record columns) to the database it opens: copy the file first.

## Buy AI purchases
Buy APIs are paid by the buyer's own wallet (USDT, Celo) through `PAYRAIL_BUY_PAYMENTS=1`; see [BUY-PAYMENTS.md](BUY-PAYMENTS.md). The catalogue is fetched from Buy, never stored locally. The 3% fee is recorded as due and not collected.
