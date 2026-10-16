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
