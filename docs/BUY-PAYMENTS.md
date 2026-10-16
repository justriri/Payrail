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
