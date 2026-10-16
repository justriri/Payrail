# Controlled live test runbook (real USDT, small amounts)

Nothing in this runbook has been executed by the build. Every step that moves money is yours to run and approve.

## What is ready, and what is not

| Flow | State | Evidence |
|---|---|---|
| Buyer wallet sign-in (signature, network named, single-use) | Implemented | Unit and HTTP tests with local signers. Never tried with a browser wallet extension. |
| Real USDT funding: one-click from your wallet (or send manually and paste the hash) | Implemented | `test/market.test.ts` runs the whole path against a fake chain reader: token, sender (your verified wallet), recipient, amount, confirmations, credited once. **Never run on mainnet.** |
| Create, verify and publish a real API (`REAL USDT` option) | Implemented | Same test covers DNS proof, credential, contract, publish with fakes. In real-funds mode the server now uses the real SSRF-safe egress and real DNS. **Untested against the real internet.** |
| Pay and Use API with outcome-based billing in USDT | Implemented | Charges only validated outcomes. Real-USDT path covered by the fake-chain test. |
| Receipts and on-chain verification of deposits | Implemented | Receipt page; deposits verified from the chain before any credit. |
| Seller earnings accounting (USDT ledger) | Implemented | Ledger tests; `scripts/operator.ts reconcile`. |
| Buyer-signed conversion (non-USDT assets) | Built, wired behind `PAYRAIL_BUYER_SWAP=1` | Fakes only. **Do not use in the first live test.** |
| Seller payouts | **Disabled for live use** | `POST /seller/payouts` returns `PAYOUTS_DISABLED` unless the operator opts in in code. Earnings stay in the ledger. |

Not claimed live: any asset other than USDT as a funding source, and payouts.

## One-click Pay (USDT)
On a real-USDT API page, **Pay and Use API** now does everything from your own wallet in order, with each step shown as it
happens: connect wallet, sign in (signature), verify the funding wallet (signature), check your balance, send **only the
shortfall** as one USDT transfer to the deposit address, wait for the server to verify it on-chain and credit it, then run the
API. You never copy an address or a transaction hash. If the transfer is short, only what arrived is credited and the API is
not run; if your wallet declines, nothing is charged; a price above the per-deposit limit is refused before anything is sent.
A transfer that was sent but not yet confirmed can be re-checked with **Check pending top-up** (it is never re-sent).
Funds still pass through Payrail's deposit address and sit in the Payrail ledger until spent (custodial).
Verified with a fake chain and a fake wallet (`scripts/browser/verify-pay.mjs`); not yet with a real wallet and mainnet.

## Safety limits already in place
- `PAYRAIL_MARKET_LIVE` is off unless you start the server with it.
- Deposit cap per transfer: `PAYRAIL_MAX_DEPOSIT_USD` (default 5). Use 1 for the first test.
- Credit only after `PAYRAIL_DEPOSIT_CONFIRMATIONS` confirmations (default 20).
- The server never holds a buyer key. It asks for signatures only (login message, funding-wallet proof).
- No private key or seed phrase is ever requested.

## Steps

1. **Fund two wallets you control** on Celo mainnet (chain 42220): a sending wallet with about 2 USDT and a little CELO for gas,
   and a *deposit* wallet (can be a different account of the same wallet app). Do not use an exchange address.
2. **Add settings to `.env`** (never commit it; `.env` is git-ignored):
   ```
   PAYRAIL_DEPOSIT_ADDRESS=0x<your deposit wallet address>
   PAYRAIL_VAULT_KEY=<64 hex characters>        # e.g. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   PAYRAIL_MAX_DEPOSIT_USD=1
   PAYRAIL_DEPOSIT_CONFIRMATIONS=20
   ```
   Keep a backup of `PAYRAIL_VAULT_KEY`: it decrypts stored seller credentials.
3. **Preflight (read-only):** `node --env-file=.env scripts/golive-check.ts`. Every line must be OK (a WARN for
   `PAYRAIL_MARKET_LIVE` is expected until you start live). It checks chain id 42220, the USDT contract and that the deposit
   address is a plain wallet.
4. **Start live (payouts stay disabled, buyer-signed conversion stays off):**
   `PAYRAIL_MARKET_LIVE=1 node --env-file=.env scripts/serve.ts --port 4402 --market-db data/marketplace-live.db`
   Open `http://127.0.0.1:4402/market.html#/buyer`. The banner must say REAL FUNDS MODE.
5. **Buyer:** Sign in with wallet (signature only) -> Wallet and funding -> verify your sending wallet (signature only) ->
   send 0.5 USDT from that wallet to the deposit address using your wallet app -> paste the transaction hash.
   Expect PENDING until confirmations, then SUCCESS. Check the transaction on a Celo explorer (token = USDT
   `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, recipient = your deposit address).
6. **Seller (optional, needs a public https API you control):** Seller -> sign in with wallet -> Create API (every listing is priced in real USDT)
   -> prove the wallet and the domain (DNS TXT or well-known file) -> add the credential if needed
   -> Test -> approve the suggested contract -> Publish.
7. **Buy it:** Buyer -> Explore APIs -> View API -> Pay and Use API -> Confirm. Check the charge, the receipt and your
   balance. Opening the page charges nothing; only the confirmed request does, and only if the response qualifies.
8. **Reconcile:** `node scripts/operator.ts reconcile --db data/marketplace-live.db` must report `ok: true`.

## Stop conditions
Stop and do not continue if: the banner does not say REAL FUNDS MODE, a deposit is credited without a transaction you made,
a balance differs from the on-chain amount, or any step asks for a private key or seed phrase.

## After the test
Stop the server (Ctrl+C). The database `data/marketplace-live.db` holds the ledger; it is git-ignored.

## Buy AI purchase test (a few cents)
1. Start the production server with `PAYRAIL_BUY_PAYMENTS=1` and `PAYRAIL_BUY_MAX_USD=0.05` (needs your approval to restart).
2. Open a cheap Buy API (about 0.005 USDT), click Get the exact price, sign in with your wallet, then sign the payment.
3. Expect state CONFIRMED, a Celoscan link showing a USDT transfer from your wallet to `0x20fa...333B`, and the API response.
4. Stop if the receipt says REVIEW or UNRESOLVED; use Re-check, never pay again.
