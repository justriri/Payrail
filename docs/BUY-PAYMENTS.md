# Buy AI marketplace: how Payrail uses Buy and how the buyer pays

Payrail is a marketplace and payment layer in front of **Buy AI** (`gateway.usebuy.ai`). Buy provides the APIs. The buyer pays with their own wallet. Payrail verifies the result and records the order.

## Where the catalogue comes from
- Fetched live from `https://gateway.usebuy.ai/v1/catalog` (`src/catalog.ts`), cached for 5 minutes. Nothing is stored or seeded locally. If Buy cannot be reached the page says so and shows an empty state; a stale cached copy is labelled STALE.
- Read-only check on 2026-10-16: 170 services listed, 167 available (instagram 35, tiktok 32, youtube 32, linkedin 25, reddit 22, x 19, flights 2, browser/chainstack/cencori 1 each). Indicative prices roughly 0.003 to 1.2 USDT.
- The catalogue price is indicative. The exact price is the one Buy states in the HTTP 402 challenge when the buyer asks for a quote.

## Network and token (verified against the real gateway)
- Celo mainnet (chain 42220), x402 v1, scheme `exact`.
- Offered tokens: USDC, USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, USAT. Payrail only uses **USDT**.
- Payee: `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B` (Buy). Payrail pins it and refuses any challenge that names another payee.
- Unpaid-request probe of 23 services across all platforms: 21 answered 402 offering USDT at the catalogue price with the same payee (the other 2 returned HTTP 400 because of the test bodies, not because of payment rules). No money was moved.

## The flow
1. The buyer opens a Buy API page (`/api.html?src=buy&id=...`), enters the request body and clicks **Get the exact price**.
2. The buyer connects a wallet and signs in with a message signature (no transaction).
3. Payrail sends an unpaid request to Buy, validates the 402 challenge (USDT, celo, exact, pinned payee, domain present, price at or below the cap) and builds an EIP-3009 `TransferWithAuthorization` for exactly that price. Order state `QUOTED`.
4. The wallet signs the typed data (`eth_signTypedData_v4`). The buyer sends no transaction and pays no gas.
5. Payrail verifies the signature against the stored authorization and sends **one** paid request with the `X-PAYMENT` header. Buy settles on-chain and runs the API.
6. Payrail verifies the settlement independently (authorization used, USDT transfer from buyer to Buy for the exact amount). Only then is the order `CONFIRMED`. A 2xx without verifiable evidence is `REVIEW`; ambiguous outcomes are `UNRESOLVED`; neither is shown as paid. A paid request is never resent. **Re-check** only reads the chain.

No deposit wallet, top-up or Payrail balance is involved in a Buy purchase.

## The 3% platform fee
Buy's authorization pays 100% of the price to Buy's address. Payrail is not a party to that transfer, so it cannot deduct 3% from it. Orders therefore record the fee as **due (3%) and `not_collected`**, and the receipt says so. Payrail never reports a fee as collected unless a fee transaction exists.

Compatible designs (neither is implemented; each needs your approval):
1. **Second buyer-signed authorization** to a Payrail fee address, signed at the same time and submitted by Payrail after a verified outcome. Needs a Payrail relayer wallet holding CELO for gas.
2. **Buyer-sent fee transfer** verified on-chain before the API runs. Simple and non-custodial but adds a second wallet prompt and gas for the buyer.
Alternative: ask Buy for a split-payment or referral arrangement.

## Enabling it (off by default)
`PAYRAIL_BUY_PAYMENTS=1` with the production server. Optional: `PAYRAIL_BUY_MAX_USD` (default 0.05 per payment), `PAYRAIL_BUY_PAYTO` (default Buy's address above). Without the flag the pages say payments are not enabled and no quote or payment is possible. The development environment never has Buy payments (its catalogue is simulated).

## Why demo or test USDT appeared before
The server that was running was the development server (`npm run dev:market`, port 4403), which seeds demo APIs, uses test credits and a simulated Buy catalogue. The production server (`scripts/serve.ts`) contains none of that. Use the production server, and the catalogue is Buy's.

## Tests
- `test/buypay.test.ts` and `test/buyroutes.test.ts` use a fake Buy gateway and fake chain (`test/fakebuy.ts`).
- `scripts/browser/verify-buy.mjs` drives the real pages with a fake wallet signing real EIP-712 typed data.

## Still requires a real-wallet transaction (not done)
- A real browser wallet signing the typed data on Celo.
- That Buy accepts an authorization signed by the buyer's wallet and relayed through Payrail's server (the same mechanism the operator flow already used successfully, but the buyer-wallet-via-server path is untested live).
- A real USDT payment of a few cents and checking the receipt on Celoscan.
- Fee collection (blocked on the design decision above).

## Paying with cNGN and other currencies (Textile + Buy)
Roles: **Buy AI** sells the API and is paid in USDT on Celo. **Textile Protocol** is the conversion layer. Textile does not settle API purchases and Buy does not accept cNGN, so the hand-off is USDT in the buyer's own wallet.

Flow (all signed and sent by the buyer's wallet; Payrail holds no key and no funds):
1. Get the exact Buy price. If the wallet holds less USDT than that, the page shows the shortfall and the currencies Textile can convert.
2. Pick a currency and see the estimate: API price, cNGN to sell, rate, Textile fee (already inside the rate; Payrail adds none), USDT received (expected and guaranteed minimum), USDT left in the wallet.
3. Approve: the wallet signs Textile's TakerControl proof, Payrail asks Textile for a firm quote and validates it (taker, reactor, exact approval, single order, minimum, expiry), and the wallet sends the validated approve + swap.
4. Payrail marks the conversion CONFIRMED only from the receipt (success, confirmations, Fill from the Textile reactor for this wallet, USDT of the exact contract delivered to this wallet, at least the minimum shown). Reporting a hash proves nothing.
5. A fresh Buy quote is made with the conversion attached; the wallet signs the EIP-3009 authorization and the normal Buy flow runs. The receipt shows the conversion and the payment.

Facts and limits:
- Textile's corridor minimum is about 1 USD, so the swap is larger than a cent-sized API price; the rest stays in the wallet as USDT. The page says so before approval.
- A currency is offered only if Textile's live ladder lists X -> USDT and the operator allow-list enables it. Others (CWT, G$, wMXN...) are shown as unavailable with the reason; nothing is simulated.
- Route evidence (docs/ROUTE-MATRIX.md): cNGN -> USDT executed by Payrail on mainnet; wARS, wBRL, USDC, USAT live-quoted only, not executed. The page states this per currency.
- Platform fee: unchanged, 3% recorded as due and not collected; no fee is added to the conversion, so the buyer is never charged twice.
- Off by default: `PAYRAIL_BUY_CONVERSION=1` (requires `PAYRAIL_BUY_PAYMENTS=1`); `PAYRAIL_BUY_CONVERT_MAX_USD` (default 2) caps one conversion. It has never run on mainnet through this path.
- Textile pays the swap output to the wallet that signs it; the API has no recipient field, so conversion on behalf of another wallet is impossible by design.

Needs a real-wallet test (not done): cNGN -> USDT -> Buy purchase end to end; wARS, wBRL, USDC, USAT each separately (a route listed in one direction proves nothing about others); firm quote acceptance with a real browser wallet (TakerControl signature format has only been confirmed by an unfunded-wallet probe); gas (CELO or a fee currency) in the buyer wallet.

## Every Textile route into USDT on Celo (checked 2026-10-16, read-only)
Source: Textile's public ladder (`GET /v2/rfq/levels?chainId=42220`) and indicative previews, run through the production listing code with `node scripts/buy-routes-check.ts`; token symbol/decimals read from each contract on-chain. All routes are X -> USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, Celo 42220, settled by the Textile reactor `LimitOrderReactor`; the buyer's wallet is the taker, approves exactly the sell amount to the reactor, then sends `executeBatch` with one order. Minimum swap is Textile's ~1 USD corridor floor for every route.

| Currency | Contract | Dec | Live quote 2026-10-16 | Smallest swap (worth) | In the app | Executed on mainnet by Payrail |
|---|---|---|---|---|---|---|
| cNGN | 0xF682…1a4f | 6 | yes | 1358.3 (0.998 USDT) | enabled | **yes**, 0x102eafff… (2026-10-14) |
| wARS | 0x0DC4…D90D | 18 | yes | 1616.4 (1.000) | enabled | no |
| wBRL | 0xD76f…90e0 | 18 | yes | 5.083 (1.000) | enabled | no |
| USDC | 0xcebA…118C | 6 | yes | 0.999 (1.000) | enabled | no |
| USAT | 0xD2ab…F771 | 6 | yes | 1.00005 (0.999) | enabled | no |
| IDRX | 0x18Bc…3C22 | 2 | yes | 17,940 (1.000) | enabled | no |
| wCOP | 0x8a1D…2D76 | 18 | yes | 3169 (1.000) | enabled | no |
| WETH | 0xD221…D9Af | 18 | yes | 0.00041 (0.999) | enabled | no |
| wMXN | 0x337E…0d34 | 18 | yes (about $200 deep) | 18.45 (1.000) | enabled | no |
| CELO | 0x471E…a438 | 18 | yes | - | **off on purpose** (network gas token; a buyer could spend the CELO needed for gas). Operator can enable it | no |
| G$ | 0x62B8…9c7A | 18 | no: listed with no levels | - | not offered | no |
| CWT | - | - | not on any ladder, address book or spec | - | not offered | no |

Notes:
- "Enabled" means the page offers the currency when the live ladder lists it, the smallest swap fits `PAYRAIL_BUY_CONVERT_MAX_USD` (default 2), and Textile returns a price; otherwise it is shown as unavailable with the reason. Allow-list defaults only apply when conversion is switched on (`PAYRAIL_BUY_CONVERSION=1`).
- Not yet observed for any non-cNGN route: a firm quote (needs a wallet-signed TakerControl proof and reserves maker inventory), the exact `executeBatch` gas, and the swap on mainnet. Tests with fakes cover quote validation, wallet steps, verification and failure handling for every enabled currency, but are not mainnet evidence.
- Gas: the wallet needs CELO (or a fee-currency stablecoin) for the approve and the swap; the earlier cNGN run measured roughly 55k gas for an approve at ~200 gwei.
- USDC and USAT are also accepted by Buy directly (EIP-3009). Converting them to USDT first works but is an extra step; paying Buy in USDC/USAT directly would be simpler and is not implemented because the Buy flow is pinned to USDT.

## What the buyer sees: route status (never better than the evidence)
Every known currency is listed on the Buy API page when the wallet holds less USDT than the price, with one of four statuses (`GET /api/market/buy/currencies`, `status`):
- **Available**: Textile's live ladder shows makers and Payrail itself has executed this route on Celo mainnet (today: cNGN only, tx 0x102eafff…). The buyer-wallet flow is still being proven with real wallets.
- **Needs live test**: implemented and selectable, a live indicative price exists, but the route has never been executed on mainnet by Payrail (wARS, wBRL, USDC, USAT, IDRX, wCOP, WETH, wMXN). The first real conversion is the test.
- **Temporarily unavailable**: Textile lists the pair but has no makers or no price right now, or its smallest swap exceeds `PAYRAIL_BUY_CONVERT_MAX_USD`. The reason is shown.
- **Unsupported**: no compatible route (not on Textile's ladder, G$) or switched off here (CELO, the gas token).
Selectable means Available or Needs live test. The backend refuses estimates for anything else, so the page cannot enable what the server will not do. Each card shows the smallest swap and about what it is worth in USDT; the estimate shows source amount, expected and guaranteed-minimum USDT, Textile's fee, the smallest swap and the platform-fee note before the buyer approves anything. A simulated provider is never labelled Available.

## Can Buy take USDC and USAT directly?
Buy's HTTP 402 challenge offers USDC, USDT and USAT at the same price on Celo (all 21 routes probed unpaid on 2026-10-16), and both USDC and USAT support EIP-3009 authorizations, so a direct payment in USDC or USAT looks possible. Payrail has not done it: its Buy flow is pinned to the USDT contract and the USDT EIP-712 domain, and no USDC/USAT authorization has ever been signed or settled through it. Converting USDC/USAT to USDT with Textile is therefore a workaround, not the simplest path; direct payment would need a different (token-agnostic) quote/sign step and its own live test. The page says so on the USDC and USAT cards.

## Configuration and safe restart
`.env` must contain `PAYRAIL_MARKET_LIVE=1`, `PAYRAIL_BUY_PAYMENTS=1`, `PAYRAIL_BUY_CONVERSION=1` (the server refuses to start with conversion but without Buy payments). Caps: `PAYRAIL_BUY_MAX_USD` (Buy payment, default 0.05) and `PAYRAIL_BUY_CONVERT_MAX_USD` (one conversion; keep it at 2 or more, because Textile's smallest swap is worth about 1 USDT and a cap of 1 can make routes flicker to unavailable).
Restart: stop the running server (Ctrl+C in its terminal), then `npm run serve -- --port 4402` and check the log for `BUY PAYMENTS ENABLED` and `BUY CONVERSION ENABLED`; reload the page with Ctrl+F5. The database file is reused (migrations 12 and 13 are applied automatically on start; back it up first with the existing backup command if you want a restore point). Nothing is sent on start.

## Per-route verification (2026-10-17, read-only: `node scripts/buy-routes-verify.ts`)
For each of the nine enabled currencies, against Celo mainnet and Textile's public API (no signature, no transaction, no firm quote):
- contract code exists; symbol and decimals equal the registry (cNGN 6, wARS 18, wBRL 18, USDC 6, USAT 6, IDRX 2, wCOP 18, WETH 18, wMXN 18);
- `approve(reactor, amount)` simulates to `true`, identically with and without the attribution suffix, from a fresh address; estimated gas for the approval about 47k to 56k (cNGN 56.4k, USDC 56.2k, USAT 54.2k, IDRX 54.1k, wARS/wBRL/wCOP/wMXN 51.8k, WETH 46.6k); a fresh wallet's allowance is 0, so no allowance-reset step is needed;
- Textile's indicative price at the smallest swap and at 3x: output about 0.998 to 1.000 USDT per smallest swap, Textile fee about 0.99 bps of the sold amount (Payrail refuses a firm quote above 100 bps), guaranteed minimum output = expected minus 1%;
- Textile's OpenAPI still has `POST /rfq/request` (the firm-quote call Payrail makes).
Not possible without your wallet: the firm quote itself (it needs a signed TakerControl proof and reserves maker inventory), the `executeBatch` gas, and the swap. Those are the remaining live tests, one per currency.

Guards added in this round: the server reads the wallet's sell-token balance (read-only) and refuses an estimate or a prepare the wallet cannot cover (`INSUFFICIENT_FUNDS`, before anything is signed); the estimate warns, without blocking, when the wallet holds under 0.03 CELO (the wallet may pay gas in a fee currency instead); every currency card carries a separate "Textile: Live / Not live" line that is true only for an offered route whose live ladder shows makers right now (a simulated provider never shows Live), apart from the verification status badge.

## Live test checklist for each currency still marked "Needs live test"
Start the production server with the flags in `.env`, open a Buy API (about 0.005 USDT), sign in, hold 0 USDT, hold at least the smallest swap of the currency plus about 0.03 CELO. Choose the currency, read the estimate, approve. Expect: TakerControl signature, approve (if no allowance), swap; the page shows "Conversion verified" only after the receipt; then sign the Buy payment; the receipt lists both transactions. Mark the route executed only after this succeeds: add its swap hash to `LIVE_EXECUTED` in `src/routeevidence.ts` (the card then reads Available). Per currency the smallest amounts today: wARS 1617, wBRL 5.09, USDC 0.999, USAT 1.00005, IDRX about 17,950, wCOP 3168, WETH 0.000416, wMXN 18.5. The $2 conversion cap is enough for all of them (each smallest swap is worth about 1 USDT); a cap of 1 is not.

## Seller pricing in other currencies, and domain verification (2026-10-21)
**Pricing.** The seller form has a currency selector filled from `GET /api/market/pricing/currencies`, which reads the same Textile route registry as the buyer checkout (USDT plus every currency that is selectable there). `POST /api/market/pricing/normalize` previews the USDT bill; `POST /seller/listings` re-normalises on the server and ignores any USDT figure sent by the page. The listing keeps the original price and currency (`price_currency`, `price_amount_atomic`, rate, quote time and source: migration 14) and bills `price_atomic` in USDT, rounded up from a Textile INDICATIVE preview (taken at the corridor minimum and scaled, because a few cents is below Textile's ~1 USD minimum). A currency Textile cannot convert reliably (unsupported, no makers, no price) is refused with the reason; nothing is reinterpreted as USDT. A converted price older than an hour cannot be published until it is saved again. Without `PAYRAIL_BUY_CONVERSION=1` only USDT pricing exists.

**Official-list gate.** Textile's official address book (read 2026-10-17) lists Celo corridors cNGN, USDC, wARS, wBRL and IDRX against USDT. USAT, wCOP, WETH and wMXN are quoted by Textile's live API but are not in that list, so they are shown as Unsupported (reason: not in the official address book) and cannot be selected for pricing or conversion unless the operator names them in `PAYRAIL_BUY_CONVERT_UNDOCUMENTED` (comma-separated). This is enforced in code, independent of database allow-list rows. The reactor `0xa9AA…35b3` is in the official list.

**Why "Invalid IP address: undefined".** The outbound gateway pins each connection to the address it validated through a custom `lookup` hook. Since Node 20 sockets call that hook with `{ all: true }` and expect an array; the hook answered the old single-address way, so the socket read `undefined` as the IP. `pinnedLookup` in `src/egress.ts` now answers both shapes; a regression test reproduces the original error on a real loopback socket and proves the fix. Address validation (private, loopback, link-local, metadata, rebinding by pinning) is unchanged.

**Why `_payrail-challenge.<host>` was queried.** To list an API, Payrail makes the seller prove they control the endpoint's host: a TXT record `_payrail-challenge.<host>` or the file `/.well-known/payrail-verification.txt` on it, containing a token unique to the listing. Sellers cannot claim a host they do not control (e.g. `jsonplaceholder.typicode.com`), and Payrail does not ask anyone to publish records on third-party domains: such an API cannot be listed under a seller's account. Use a domain you control (for example `api.yourdomain.com`, which can forward to your service).

**Failure classes.** `DOMAIN_PROOF_FAILED` = DNS answered and the record or file is missing or wrong (with instructions); `DNS_UNAVAILABLE` = the resolver could not be asked (ECONNREFUSED, timeout, SERVFAIL): ownership was neither confirmed nor rejected, try again; `ENDPOINT_UNREACHABLE` = the host did not answer or does not exist. The seller form labels each one, plus Invalid endpoint URL and Missing or invalid pricing information.

**Buyer side.** Buy APIs: pick the API, then "Pay with another currency" (see above). The estimate shows the selected API, its listed price and currency, that Buy is paid in USDT on Celo, the Textile route, that the quote is INDICATIVE (a firm quote is requested at approval), what the buyer will spend, expected and minimum USDT, fees, the smallest swap, and that unused USDT stays in the wallet. Seller-listed APIs are billed from the Payrail USDT balance (funded in USDT or through the buyer-signed Textile funding flow); their detail page shows the seller's pricing currency and rate. A direct Textile-to-Buy checkout for seller-listed APIs was not built: those APIs are paid by Payrail's ledger, not by the Buy gateway.

## Purchasing a seller-listed API (checkout), 2026-10-21
Seller-listed APIs are NOT paid through the Buy gateway. They settle in Payrail's own ledger: the buyer's USDT reaches the deposit address, the server verifies the transfer on-chain and credits the buyer's ledger, a request reserves the price, and only a response that meets the listing's contract captures it (seller proceeds and the 3% platform fee are booked in the same ledger transaction; the fee comes out of the seller's share). `src/checkout.ts` makes that flow server-authoritative and ties it into one record. Routes (real-funds mode only): `POST /checkout/start`, `POST /checkout/:id/estimate | attach-conversion | deposit | execute`, `GET /checkout/:id`, `GET /checkouts`.

Sequence: (1) **start**: the server reads the price from the listing (a price sent by the page is ignored), freezes it with the request input, and computes the plan from its own numbers: ledger balance, top-up needed, the wallet's on-chain USDT, and the shortfall. (2) If the wallet lacks USDT but holds a supported currency: **estimate** sizes a Textile conversion from the server's shortfall (source amount, rate, fee, expected and minimum USDT, smallest swap, expiry, USDT that will remain in the wallet); the buyer approves; the existing buyer-signed flow (`/buy/convert/proof|prepare|tx|recheck`) signs and sends approve + swap from the buyer's own wallet; the conversion only counts once its receipt is verified, then **attach-conversion**. (3) The wallet sends exactly the top-up in USDT; **deposit** verifies it on-chain (existing verification) and credits the ledger. (4) **execute**: the server re-checks that the listing is published at the same price and that the ledger covers it, then runs the request ONCE under an idempotency key derived from the checkout; duplicate, concurrent or retried calls report the stored outcome and never call the seller or reserve funds again. Content is returned only for a captured payment.

States: QUOTED, RUNNING, CHARGED, NOT_CHARGED (response did not qualify: funds released, no content), UNRESOLVED (outcome unknown: held, not charged, no content; released by recovery, and the checkout follows the ledger on reconcile), EXPIRED (30 minutes, or the price changed: nothing reserved). A changed price or unpublished listing stops the purchase before anything is reserved. If a conversion succeeds but the API is not charged, the converted USDT is either still in the wallet or credited to the Payrail balance and pays the next checkout without converting again.

Receipt (`GET /checkout/:id`, shown on the page as "Purchase record"): listing, seller, authoritative price and the seller's original pricing currency and rate, state, conversion transaction, top-up transaction(s), the execution receipt (ledger transactions, platform fee, seller earned). Migration 15 adds `listing_checkouts` and append-only `listing_checkout_events`.

Fee honesty: for seller listings the platform fee is booked in the ledger from USDT that really arrived at the deposit address, so it is not merely "due"; moving it out of the deposit address is a separate operator step. For Buy-gateway APIs the 3% remains due and NOT collected (see above). Seller payouts remain disabled.

## The four unproven routes: wARS, wBRL, USDC, IDRX
Traced through discovery, estimate sizing, firm-quote validation, wallet steps, receipt verification, reconciliation and the Buy or checkout payment. Defect found and fixed: the simulated IDRX rate was 10x off the live ladder (1,789 instead of about 17,900 IDRX per USDT), which made simulated IDRX estimates wrong; fixed in `src/dev/simconversion.ts` (development only, not a production path). No defect was found in the production code for these four. `test/routes-four.test.ts` covers, per route, token/decimals/network/direction, minimum swap in the token's own units, failed/short/misdirected/uncertain swaps, reconciliation of a late-landing swap, expired estimate, insufficient sell balance, the conversion cap, conversion-then-Buy-failure. All of it runs against a SIMULATED Textile: none of these four has been executed on mainnet by Payrail, and each still needs one real-wallet conversion (smallest swaps: wARS about 1617, wBRL about 5.09, USDC about 0.999, IDRX about 17,950) before it can be called verified.
