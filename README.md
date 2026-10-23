# Payrail: pay for APIs in the currency you already hold

Payrail is an API marketplace and payment agent on **Celo mainnet**. A buyer pays for an API with a stablecoin
they already hold; if the API is priced in USDT and the buyer holds something else (for example cNGN), Payrail
converts it with **Textile FX** and then pays through the **Buy x402 gateway**. Sellers can list their own APIs,
prove they own them, define a response contract, test, publish, and are paid only for responses that qualify.

Built for the Celo **Agents on Open Rails** hackathon. Screenshots of the real running app are in
[docs/screenshots](docs/screenshots); the logo assets (SVG masters, PNGs, favicon) are in [assets/brand](assets/brand)
(rebuild with `node scripts/brand-assets/build.mjs --png`).

> **Safety first.** Payrail can spend real money. The command-line tools are **plan-only by default** and the web
> server never holds a buyer key. Nothing signs or sends unless you pass an explicit flag and every safeguard passes.
> Read [Safety model](#safety-model) before running anything that spends.

## What it does

1. **Discover**: the marketplace lists the live [Buy](https://usebuy.ai) catalog (170 services) next to APIs
   registered by independent sellers. Prices for Buy services come from the service's own HTTP 402 answer.
2. **Choose how to pay**: pay directly with USDT/USDC/USAT, or pick a supported local-currency stablecoin
   (cNGN, wARS, wBRL, IDRX; USDC has thin liquidity). Payrail shows the live Textile rate, fee, minimum and the most you
   could spend before you approve.
3. **Convert** (only when needed) with Textile FX (firm quote, one signed order), then **pay** through Buy's x402
   gateway on Celo. Every transaction Payrail itself submits carries the event's ERC-8021 attribution tag.
4. **Verify**: settlement is checked on-chain, the service response is saved and hashed, and a receipt is recorded.
5. **Sell**: a seller signs in with a wallet, registers an API, proves wallet and domain ownership (DNS record,
   well-known file, or **GitHub repository proof**), stores credentials in an encrypted vault (sent only to the
   verified host), tests for free, proposes a **response contract**, approves it, and publishes. Buyers are charged only
   when a response satisfies the contract (3% platform fee).

## What is verified, and how (no mocks presented as live)

| Capability | Evidence |
|---|---|
| Direct x402 payments to Buy on Celo mainnet | **Mainnet**: 3 payments of 0.005 USDT, re-checked on-chain by `scripts/evidence.ts --verify` |
| Convert-then-pay (cNGN → USDT via Textile, then x402) | **Mainnet**: order `90f8d4be…`, swap tx `0x102eafff…acb7`, payment tx `0xf3652222…2c9c` |
| Mento swap, Textile swap, ERC-8004 identity (agent 9906) | **Mainnet**, all carry the attribution tag (`verifyTx`) |
| Seller GitHub ownership verification (OAuth, repo write access, proof file in repo and on the deployed host, endpoint check) | **Real GitHub + real Render host**, local Payrail: all five checks passed on 2026-10-23 for the dedicated [test API](https://github.com/justriri/payrail-test-apipayrail-test-api) |
| Free-host cold starts during verification (retries 10 s / 30 s / 30 s; a timeout is never a "failed proof" and never verifies) | Automated tests + the real run above |
| Seller listing, contract, test call, publish, public detail page, buyer purchase, outcome billing, ledger, payouts accounting | Automated tests and browser regressions against a **fake chain and fake seller API** |
| Buyer-wallet purchase of a Buy API with in-app currency conversion (EIP-3009 signed in the buyer's wallet) | **Fakes only.** The same conversion and payment pieces are proven on mainnet through the order CLI/agent wallet, not through a browser buyer wallet |
| Seller payouts | Accounting and operator CLI tested with fakes; **no payout has been sent** |
| Hosted/public deployment | **None.** Payrail runs locally; there is no public demo URL yet |

Full detail: [docs/PRODUCTION.md](docs/PRODUCTION.md), [docs/BUY-PAYMENTS.md](docs/BUY-PAYMENTS.md),
[docs/MARKETPLACE.md](docs/MARKETPLACE.md), [evidence/SUBMISSION-EVIDENCE.md](evidence/SUBMISSION-EVIDENCE.md).

## Architecture

```
web/        marketplace UI (landing, buyer, seller, API detail), plain JS, no framework
src/        library: planner, policy, executors, orchestrator, Textile/Mento/Buy clients, evidence,
            marketplace (market, seller, contracts, execute, ledger, checkout, funding, payouts, github*)
scripts/    CLI tools (read-only unless a spending flag is given), server entry point, browser regressions
test/       node:test suites (fakes only; nothing touches real funds)
docs/       architecture, marketplace, production notes, runbooks, demo walkthrough, screenshots
contracts/  PayrailEscrow (Solidity, tests; not deployed, not used by the product)
evidence/   generated proof of the mainnet transactions
```

Storage is SQLite (`node:sqlite`, migrations in `src/db.ts`). Seller-supplied URLs are fetched only through
`src/egress.ts` (https/443 only, no IP literals or private addresses, DNS pinned, no redirects, size and time limits).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup (fresh machine)

Requirements: **Node.js 22.18 or newer**, npm. Nothing to build: Node runs the TypeScript directly.

```sh
git clone https://github.com/justriri/Payrail.git
cd Payrail
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
npm run check               # type check + all tests (about 5 minutes; fakes only)
```

`.env` holds public settings only. **Never put a private key in this folder.** Spending commands load a key from a file
outside the project with `node --env-file=<that file>` (see [docs/WALLET-KEY-BACKUP.md](docs/WALLET-KEY-BACKUP.md)).

### Environment variables

| Variable | Purpose |
|---|---|
| `PAYRAIL_ATTRIBUTION_TAG` | Required. The event tag; Payrail refuses to run with any other value |
| `PAYRAIL_WALLET_ADDRESS` | Optional public address for read-only plans and balances |
| `PAYRAIL_RPC_URL`, `PAYRAIL_RPC_FALLBACK_URLS` | Optional https RPCs (a primary plus fallbacks) |
| `PAYRAIL_MAX_PER_PAYMENT_USD`, `PAYRAIL_MAX_PER_DAY_USD`, `PAYRAIL_MAX_SWAP_USD`, `PAYRAIL_MAX_SWAP_PER_DAY_USD` | Spending limits (small defaults) |
| `PAYRAIL_MARKET_LIVE=1`, `PAYRAIL_DEPOSIT_ADDRESS`, `PAYRAIL_VAULT_KEY` | Turn on the real-funds marketplace (vault key: 64 hex characters you generate) |
| `PAYRAIL_BUY_PAYMENTS=1`, `PAYRAIL_BUY_CONVERSION=1` | Buyer pays Buy services from their own wallet; optional Textile conversion |
| `PAYRAIL_GITHUB_CLIENT_ID`, `PAYRAIL_GITHUB_CLIENT_SECRET`, `PAYRAIL_PUBLIC_URL` | GitHub seller verification; real values go in the git-ignored `.env.local` ([setup](docs/LOCAL-GITHUB-SETUP.md)) |

`.env`, `.env.local`, key files, databases and `receipts/` are git-ignored; only `.env.example` (placeholders) is tracked.

## Run it

```sh
npm run serve          # LIVE read-only: real catalog, balances and quotes; cannot pay (no key loaded)
npm run serve:local    # same, plus .env.local (GitHub OAuth) for the seller verification flow
npm run dev:market     # separate DEVELOPMENT server (port 4403): test credits, simulated Buy, clearly labelled
```

Open `http://127.0.0.1:4402/`. `/` is the landing page, `/market.html` the buyer and seller workspace,
`/api.html?id=<listing id>` an API's public detail and purchase page. To run the real-funds marketplace see
[Marketplace](#marketplace) and [docs/LIVE-TEST-RUNBOOK.md](docs/LIVE-TEST-RUNBOOK.md). The step-by-step
demo is in [docs/DEMO.md](docs/DEMO.md).

## Command-line tools

Read-only (never sign or send):

```sh
node --env-file=.env scripts/services.ts --available --limit 10    # Buy services and indicative prices
node --env-file=.env scripts/order.ts --service x.posts.search     # plan an order; prints a plan digest
node --env-file=.env scripts/balances.ts                           # balances and allowances
node --env-file=.env scripts/routes.ts                             # which conversions are live
node --env-file=.env scripts/history.ts                            # payments, swaps, orders
node --env-file=.env scripts/evidence.ts --verify                  # regenerate evidence and re-check the chain
node scripts/export-receipts.ts                                    # evidence/payment-receipts.json and .csv (local files only)
```

Spending (need a key file, an explicit flag and an interactive confirmation or explicit bounds):

| Command | Can do |
|---|---|
| `scripts/order.ts --service <id> [--source cNGN] --execute` | pay, or convert then pay |
| `scripts/convert.ts --from A --to B --amount N --execute --approve` | a standalone conversion |
| `scripts/pay-direct.ts --pay` | one direct payment (original test tool) |
| `scripts/register-agent.ts --send` | register the ERC-8004 identity (gas) |

## Marketplace

Sellers and buyers sign in with a wallet signature (no passwords). A listing is publishable only when wallet and domain
ownership are proven, a response contract is approved and the endpoint rules pass; **nothing is published
automatically**. Unpublished listings return 404 on every public route. A seller's "View in the marketplace" link opens that
listing's own page (`/api.html?id=…`). The marketplace is off unless the operator starts it with
`PAYRAIL_MARKET_LIVE=1` (real USDT, Celo chain 42220). The development server (`npm run dev:market`) uses a separate
database and cannot touch the production one. Details: [docs/MARKETPLACE.md](docs/MARKETPLACE.md).

## Tests

```sh
npm run typecheck                                    # TypeScript
npm test                                             # 685 tests, fakes only
node scripts/browser/verify-seller.mjs <outputdir>   # browser regressions (need Microsoft Edge); verify-*.mjs, 12 in all
```

The automated tests send nothing and are **not** evidence of on-chain activity.

## Safety model

- **Plan first.** Planning is read-only; spending needs an explicit flag and a plan-digest approval where policy requires.
- **One gate.** Only the planner can authorize spending; executors refuse anything it did not mint.
- **Limits and allow-lists** per payment, per day, per swap; allowed hosts, assets and pairs.
- **Journal before sending**; an unresolved record blocks further spending until a human resolves it. Uncertain is never retried.
- **Locks** stop concurrent payments or orders from interleaving; idempotency keys stop duplicate charges.
- **Tag check**: calldata must carry exactly the official ERC-8021 tag before signing.
- **Independent verification**: a seller's "OK" or a reported hash proves nothing; settlement is checked on-chain.
- **Secrets**: wallet keys never live in the project; seller credentials are sealed with the vault key and sent only to the
  verified host; GitHub tokens are sealed and never returned.

## Attribution

Transactions Payrail itself sends (approvals, swaps, the ERC-8004 registration) carry `celo_b2fff2ac9413` and are checked
with `verifyTx`. x402 payments to Buy are submitted by the gateway, so Payrail cannot tag them; the organizers said no tag is
needed for Build with buy.

## Known limitations

- No hosted deployment or public demo URL yet; Payrail runs on your machine.
- A browser buyer's in-app conversion and purchase flow, and seller payouts, have only been exercised with fakes.
- Only cNGN → USDT has been executed on mainnet; wARS, wBRL, IDRX and USDC are quoted live but not executed by Payrail.
  USDC → USDT often has no market makers.
- No third-party security review. Custody: buyer deposits sit at an operator-controlled address and a ledger.
- One service provider (Buy) is registered; the provider seam supports more. Amounts are in token units, not local currency.
- Some public RPC nodes prune old receipts; Payrail asks several endpoints and treats an unanswered lookup as inconclusive.

More: [docs/PRODUCTION.md](docs/PRODUCTION.md), [PROJECT-MASTER-CHECKLIST.md](PROJECT-MASTER-CHECKLIST.md).
