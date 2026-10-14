# Payrail — Pay in Your Currency

Payrail is an agent that pays for online services using money you already hold, and converts currency
only when it has to. It was built for the Celo "Agents on Open Rails" hackathon and runs on **Celo mainnet**.

> **Safety first.** Payrail can spend real money. Everything is **plan-only by default**: nothing is
> signed, quoted or sent unless you pass an explicit flag *and* the safety checks pass. Read
> [Safety model](#safety-model) before running anything that spends.

## The problem

Many AI agents and people hold a stablecoin or local-currency token, but the service they want to use
asks to be paid in something else. Doing the conversion by hand is slow and error-prone, and an agent
that can spend money needs strict limits and a clear record of what it did.

## What Payrail does

1. **Discovers** a service and its *real* price (the price comes from the service's own HTTP 402 answer,
   not from a catalog that might be out of date).
2. **Checks balances** and decides: pay directly, or convert first.
3. **Applies a spending policy** (limits, allow-lists, human approval where required).
4. **Executes**: pays with x402, or converts through a venue and then pays.
5. **Verifies independently** that the payment settled and the service delivered.
6. **Keeps records**: receipts, an order history, recovery tools, and an evidence pack you can inspect.

## Features that exist today

| Area | What it does |
|---|---|
| Service discovery | Lists and searches the [Buy](https://usebuy.ai) gateway catalog |
| Real-price discovery | Makes an *unpaid* request, reads the 402 challenge, validates payee/asset/resource |
| Direct payment | x402 (v1, exact) payment in USDT / USDC / USAT through `@celo/buy-core` |
| Conversion | Textile FX (firm quotes, one signed order) and Mento V3 (router) |
| Attribution | Every transaction Payrail itself sends carries the ERC-8021 tag (see below) |
| Orders | One flow: plan → preflight → [convert] → re-price → pay → verify → record |
| Safeguards | Per-payment, daily and per-swap limits, locks, journals, duplicate protection |
| Recovery | `--reconcile`, `--resume`, swap re-verification, uncertain-payment resolution |
| Evidence | Services used, payments, conversions, orders; re-checked against the chain |
| Identity | ERC-8004 agent registration script (`scripts/register-agent.ts`) |

### Supported routes

- **Direct:** the wallet already holds an accepted asset (USDT, USDC or USAT) → pay.
- **Convert then pay:** the wallet holds a supported source (cNGN, wARS, wBRL, IDRX) →
  convert to an accepted asset through Textile FX or Mento → pay.
- **Standalone conversion:** top-ups between the pairs allowed by policy (see `src/policy.ts`).

## Technologies and external services

- **TypeScript on Node.js** (runs `.ts` files directly; no build step), [viem](https://viem.sh).
- **Celo mainnet** (chain 42220).
- **Buy gateway** (`gateway.usebuy.ai`) and `@celo/buy-core` for x402 payments.
- **Textile FX** (`api.textilecredit.com`) for request-for-quote conversions.
- **Mento** for router-based conversions.
- **`@celo/attribution-tags`** for ERC-8021 attribution tags and verification.
- Public Celo RPC endpoints (a primary plus fallbacks) for read-only chain data.

## Prerequisites

- **Node.js 22.18 or newer** (`node -v`). The project runs TypeScript files directly.
- npm (comes with Node).
- For *spending* commands only: a dedicated wallet with a little CELO for gas and a small balance of an
  accepted stablecoin. Use a **new, dedicated wallet** with limited funds, never your main wallet.

## Install

```sh
npm install
```

## Configure

Copy the example file and edit it:

```sh
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

`.env` holds **public** settings only (tag, chain, wallet *address*, optional RPC URLs and limits).
**Never put a private key in this folder.** The signing key lives in a separate file outside the project
(see [Wallet key handling](#wallet-key-handling)) and is loaded only for commands that sign.

The variables are documented in `.env.example`. The important ones:

| Variable | Purpose |
|---|---|
| `PAYRAIL_ATTRIBUTION_TAG` | The event's tag. Must match the pinned value exactly or Payrail refuses to run |
| `PAYRAIL_WALLET_ADDRESS` | Your wallet's **public** address (for read-only plans and balances) |
| `PAYRAIL_RPC_URL` | Optional primary RPC (https only) |
| `PAYRAIL_RPC_FALLBACK_URLS` | Optional comma-separated fallback RPCs; empty value disables fallbacks |
| `PAYRAIL_MAX_PER_PAYMENT_USD`, `PAYRAIL_MAX_PER_DAY_USD`, `PAYRAIL_MAX_SWAP_USD`, `PAYRAIL_MAX_SWAP_PER_DAY_USD` | Spending limits |

## Try it without spending anything

These commands are read-only. They never sign or send:

```sh
# List services and prices (indicative)
node --env-file=.env scripts/services.ts --available --limit 10

# Show what Payrail would do to buy a service (plan only; prints a plan digest)
node --env-file=.env scripts/order.ts --service x.posts.search

# Wallet balances and allowances (needs only the public address)
node --env-file=.env scripts/balances.ts

# Which currency conversions are live right now
node --env-file=.env scripts/routes.ts

# History of payments, swaps and orders
node --env-file=.env scripts/history.ts
```

A plan prints the route, the cost, the gas estimate, whether approval is needed, and a **plan digest**.

## Web interface

A local web page lets you paste an API address, see exactly what would happen, approve it, and view the
response. It runs on your own computer (`127.0.0.1` only) and **never asks for a private key**: signing is done
by the server using the key file you load when you start it.

```sh
npm run serve:sim      # SIMULATION: fake balances, conversion and payment. Safe to explore; clearly labelled
npm run serve          # LIVE, read-only: inspect real services, balances and quotes (no key loaded, cannot pay)
node --env-file=<your key file> scripts/serve.ts    # LIVE with payments enabled; every payment needs your approval
```

Then open `http://127.0.0.1:4402/`. The page lists the services in the Buy catalog (search, platform and "within my limit" filters; the first load can take about 10 seconds) with a **Use this service** button on each card, and also lets you paste an address. It shows your balances, lets you choose which currency to pay with
(for example cNGN, which is converted first), shows the rate, fees, the most you could spend and the
destination, and only runs after you tick the approval box and press **Approve and pay**. It then shows the
conversion and payment transactions and the service's response. If anything fails or is uncertain, it says
so plainly and tells you what **not** to do (for example, never pay again while a payment is uncertain).

## Spending commands (use with care)

These can move real funds and are never run by default:

| Command | What it can do |
|---|---|
| `scripts/order.ts --service <id> [--source cNGN] --execute` | Run an order (pay, or convert then pay; `--source` picks the currency you pay with) |
| `scripts/convert.ts --from A --to B --amount N --execute --approve` | A standalone conversion |
| `scripts/pay-direct.ts --pay` | One direct payment (the original single-payment test tool; `order.ts` is the main flow) |
| `scripts/register-agent.ts --send` | Register the ERC-8004 agent identity (costs gas) |

Spending commands need the key file loaded with `--env-file`, an interactive confirmation (or explicit
`--auto-confirm --max-sell … --min-receive …` limits), and pass every safeguard first. When policy
requires approval you must supply the plan's digest with `--approve-digest`.

## Tests and type checks

```sh
npm run typecheck     # TypeScript, no emit
npm test              # all tests (mocks and fakes only; nothing touches real funds)
npm run check         # both
```

The automated tests use fakes. They send nothing and are **not** evidence of on-chain activity.

## Evidence for submission

```sh
node scripts/evidence.ts --verify
```

This writes `evidence/SUBMISSION-EVIDENCE.md` and `evidence/evidence.json`. It lists the services used,
every payment, every conversion, completed orders and the ERC-8004 registration, and (with `--verify`)
re-checks each transaction against the chain using several RPC endpoints, recomputes the SHA-256 of
every saved service response, and reports any warning or unresolved item. Warnings are never hidden.

## Safety model

- **Plan first.** Planning is read-only. Spending needs an explicit flag.
- **One gate.** Only the planner can authorize spending; the executors refuse anything it did not mint.
- **Limits.** Per payment, per day, per swap and per day of swaps; allow-listed hosts, assets and pairs.
- **Journal before sending.** A pending record is written before anything is sent, and an unresolved
  record blocks all further spending until a human resolves it.
- **Locks.** A cross-process lock stops two payments or two orders from interleaving.
- **Tag check.** Calldata is verified to carry exactly the official ERC-8021 tag before signing.
- **Independent verification.** A seller's "OK" is never trusted; settlement is checked on-chain.
- **Uncertain means stop.** An uncertain payment or swap is never retried automatically.

## Wallet key handling

- The key is read from **environment variables loaded with `node --env-file=<file>`**, from a file that
  is **outside the project folder and outside any cloud-synced folder** (for example under your user
  profile in a `.payrail` directory).
- The project's `.gitignore` excludes `.env` and key files, and no script prints the key.
- **You** are responsible for backing the key file up (see `docs/WALLET-KEY-BACKUP.md`).

## Attribution tags

Transactions that Payrail sends itself (approvals, swaps, the ERC-8004 registration) carry the event's
ERC-8021 tag in their calldata, and are checked with `verifyTx`. x402 payments to the Buy gateway are
submitted by the gateway, so Payrail cannot tag them; the organizers confirmed no tag is needed there.

## Current limitations

Honest status as of the last audit (see `PROJECT-MASTER-CHECKLIST.md` for the full list):

- **Verified live on mainnet:** direct x402 payments (3), a Mento swap, a Textile swap, one direct order,
  one **convert-then-pay order from cNGN** (Textile swap then x402 payment, response delivered), and the
  ERC-8004 registration.
- **Not yet run live (tested with fakes only):** `--reconcile`/`--resume` on a real interrupted order,
  uncertain-payment resolution, paying a service through Mento.
- **Interface:** a local web page and the command line; no hosted/multi-user service, and no fiat on/off-ramp. The web server's live conversion-and-payment path has been exercised end to end with a real cNGN conversion (driven through its API).
- **One service provider** (Buy) is registered, although the provider seam supports more.
- **No fiat on/off-ramp**, and amounts are shown in token units, not local-currency units.
- **Public RPC quirk:** some public nodes prune old receipts, so Payrail asks several endpoints and treats
  an unanswered lookup as inconclusive, never as failed.

## Project layout

```
src/        the library (planner, policy, executors, orchestrator, evidence, chain reads …)
scripts/    command-line tools (read-only unless a spending flag is given)
test/       tests (mocks and fakes only)
docs/       ARCHITECTURE.md and WALLET-KEY-BACKUP.md
receipts/   local records written at run time (not committed)
evidence/   generated submission evidence
```

See `docs/ARCHITECTURE.md` for how the pieces fit together.
