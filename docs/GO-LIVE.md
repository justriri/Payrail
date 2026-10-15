# Going live with USDT, and buyer-signed conversion

## 1. Real USDT deposits (built; never run on mainnet by this build)
1. Choose a deposit address **you control** and set `PAYRAIL_DEPOSIT_ADDRESS` (this build does not pick one for you).
2. Set `PAYRAIL_VAULT_KEY` (keeps seller credentials readable) and optionally `PAYRAIL_MAX_DEPOSIT_USD` (default 5) and
   `PAYRAIL_DEPOSIT_CONFIRMATIONS` (default 20).
3. `node --env-file=.env scripts/golive-check.ts` (read-only preflight: settings and chain facts).
4. Start: `PAYRAIL_MARKET_LIVE=1 node --env-file=.env scripts/serve.ts --port 4402 --market-db data/marketplace-live.db`
5. In the browser: Buyer -> Sign in with wallet -> Add funds -> verify the sending wallet (signature only) -> send a SMALL
   USDT amount from that wallet to the deposit address -> paste the tx hash. The UI shows PENDING until confirmations,
   then SUCCESS (credited once) or NOT CREDITED with the reason. Only transfers from the verified wallet are credited.

Payouts stay operator-approved (`scripts/payouts.ts`); nothing is sent by the server on its own.

## 2. Buyer-signed conversion (built; wired behind `PAYRAIL_BUYER_SWAP=1`; tested against fakes only)
Flow: quote (indicative) -> buyer approves -> buyer's wallet signs the Textile TakerControl proof -> server requests a firm
quote and validates it (taker, reactor, spender, exact approval, single order, amounts, expiry, calldata) -> server returns
only validated, tagged steps -> the buyer's wallet sends approve + swap -> buyer's wallet sends the USDT to the deposit
address -> the engine verifies each receipt (reactor Fill, token, recipient = the buyer's wallet, minimum, confirmations;
deposit sender = the buyer's wallet, recipient = custody) and credits once.

Code: `src/buyerswap.ts`, `recordClientTx` in `src/marketfunding.ts`, routes `POST /fund/prepare` and `POST /fund/tx`,
UI `buyerSignedPanel` in `web/market.js`, tests in `test/buyersigned.test.ts`.

**Wiring.** `scripts/serve.ts` builds the real conversion runtime (Textile route provider, `createBuyerSwapRuntime`, the
live chain reader) only when BOTH `PAYRAIL_MARKET_LIVE=1` and `PAYRAIL_BUYER_SWAP=1` are set. Both are off by default.
`PAYRAIL_BUYER_SWAP=1` without live mode stops the server with an explanation, and simulation never uses it. Payout
conversion stays off in this runtime (payouts remain operator-approved USDT).

**What is verified:** the server prepares only validated steps, verifies receipts and credits once (`test/buyersigned.test.ts`),
and a simulated start never enables it. **What is NOT verified:** a firm quote from the live Textile API, a real browser
wallet sending these transactions, and any real swap. Run it first with a tiny cNGN amount and watch the engine states.

Known limits: the approve and swap are sent a few seconds apart (the UI waits ~6 s; a very slow block can make the swap
simulate as failing and nothing is spent); the firm quote lives about a minute; no asset is enabled until one verified
execution exists for it (cNGN has evidence both ways, everything else is quoted only).
