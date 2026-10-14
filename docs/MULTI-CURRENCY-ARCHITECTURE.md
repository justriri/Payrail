# Multi-currency funding and payouts: findings and recommended architecture

> **Status: investigation and design only. Nothing in this document is implemented, wired or enabled.**
> No code was changed, no real conversion or payout was executed, `PAYRAIL_MARKET_LIVE` is untouched, and the existing
> simulation and tests are as they were (465 tests). Facts below come from **read-only** requests made on 2026-10-14 to
> Textile's public API and documentation, plus ERC-20 reads on public RPCs. They describe a moment in time: Textile's
> liquidity changes, so every route must be re-discovered live at quote time.

## 1. How the evidence was gathered

| Source | What was read |
|---|---|
| `GET /v2/rfq/levels?chainId=…` | The public price ladder per chain (which pairs have makers and at what sizes). Keyless. |
| `POST /v2/rfq/preview` | Indicative prices, both directions, ≈$5 notional. Reserves nothing. |
| `GET /v2/openapi.json` | The full API surface and request schemas. |
| `GET /v2/ramp/providers` | The fiat on/off-ramp corridors. Keyless. |
| `docs.textilecredit.com` (`llms-full.txt`, 283 KB; address book; API v2) | Search for CWT, recipient, ramp, chains. |
| On-chain `symbol()/name()/decimals()` | Identification of unlabelled ladder tokens. |
| Our repo | Asset registry, `@celo/buy-core` token list, code. |

Not done: no firm quote (it reserves maker inventory), no signature, no transaction, no key access.

## 2. Verified Textile capabilities

### 2.1 On-chain RFQ conversions on Celo (chain 42220) — the only live conversion layer usable for a Celo balance

24 pairs are listed; 20 have liquidity. "Preview" is a ≈$5 indicative price checked in each direction on 2026-10-14.

| Asset | Contract (Celo) | Dec | X → USDT (**funding**) | USDT → X (**payout**) | Notes (indicative depth) |
|---|---|---|---|---|---|
| cNGN | `0xF6829D73…71a4f` | 6 | ✅ | ✅ | deep both ways (tens of $k) |
| wARS | `0x0DC4F928…D90D` | 18 | ✅ | ✅ | deep (≈$4k payout side) |
| wBRL | `0xD76f5Faf…90e0` | 18 | ✅ | ✅ | deep (≈$95k payout side) |
| USDC | `0xcebA9300…118C` | 6 | ✅ | ✅ | thin: ≈$1k each way |
| USAT | `0xD2ab3C9A…F771` | 6 | ✅ | ✅ | ≈$4.8k payout side |
| CELO (ERC-20 form) | `0x471EcE37…a438` | 18 | ✅ | ✅ | thin payout side: ≈$33 |
| wCOP | `0x8a1D45e1…2D76` | 18 | ✅ | ✅ | ≈$5k payout side |
| WETH | `0xD221812d…D9Af` | 18 | ✅ | ✅ | thin payout side: ≈$55 |
| IDRX | `0x18Bc5bcC…3C22` | 2 | ✅ | ⚠️ preview `no_valid_quote`; ladder shows ≈$2 | **shallow payout** |
| wMXN | `0x337E7456…0d34` | 18 | ✅ (≈$200 deep) | ❌ **no makers** | **asymmetric: fundable, not payable** |
| G$ (GoodDollar) | `0x62B8B110…9c7A` | 18 | ❌ no levels | ❌ no levels | listed, no liquidity |
| **CWT** | — | — | **no evidence of any route** | **no evidence** | see 2.2 |

Rules observed: the minimum for a `sellAmount` request is the corridor dollar floor (default **$1 of notional**), so a
cent-sized API earning can never be converted on its own. USDT → X depth is much smaller than X → USDT for some assets;
**a verified X → USDT route does not imply USDT → X** (wMXN is the live counter-example, IDRX/CELO/WETH are shallow).

### 2.2 CWT

**Not supported on anything I can see.** CWT does not appear in: the Celo ladder (24 pairs), the ladders for Ethereum,
Polygon, Base and BNB, Textile's address book, the complete documentation text, the OpenAPI spec, our asset registry or
`@celo/buy-core`. I cannot identify which token "CWT" is. To evaluate it I need its **chain and contract address**; until a
route is visible on the live ladder it must be treated as unsupported.

### 2.3 Other chains and testnets

| Chain | Result |
|---|---|
| Ethereum 1 | ladder: WETH, USDT, wBRL, BRS (5 liquid pairs) |
| Polygon 137 | TESOURO, USDT0 (2 pairs) |
| Base 8453 | TESOURO, USDC, ZARU, cNGN (4 liquid) |
| BNB 56 | cNGN, USDT (2 pairs) |
| Celo Sepolia 11142220 | **"no FX settlement contract deployed"** → no Textile on Celo testnet |
| Textile test keys | only Base Sepolia 84532 and BNB testnet 97 (and local 31337) |

Funds on other chains cannot credit a Celo ledger without a bridge, which Textile does not provide. Payrail's balance,
escrow and fee accounting are all Celo.

### 2.4 Fiat

Textile has a separate **Ramp API** (`/v2/ramp`), run by a licensed provider (**Busha**): NGN ↔ cNGN only.
Live `GET /v2/ramp/providers`: chains **56 (BNB) and 8453 (Base)** only, buy and sell both on, limits ≈ 700 NGN min on
buy / 200 cNGN min on sell. **Celo returns an empty provider list.** A buy needs KYC (identity documents posted to the
provider); a sell needs a resolved bank account and the token sent from the named wallet to a deposit address. So:
local-fiat → Celo USDT is **not** available; fiat payout to a bank from a Celo balance is **not** available.

### 2.5 Who signs and who receives (from the OpenAPI spec and the reactor source)

* An RFQ is **bound to a taker wallet** ("Fills are restricted to this wallet for the whole order life"). The taker
  proves control with an EIP-712 `TakerControl` signature, then sends `approve` and `executeBatch` themselves.
* The reactor pays the maker's output to **`msg.sender`**. `CreateRfqRequest` has **no recipient/receiver field**
  (confirmed against the spec). Converted funds always land in the wallet that signed the swap.
* "Flow session" credentials replace the proof only for the Textile web app, not for integrations.
* Maker-side and partner keys exist; irrelevant to a taker integration.

Consequences:

| Direction | Signer / taker | Funds land in | Then |
|---|---|---|---|
| Buyer funding (X → USDT) | **buyer's own wallet** | buyer's wallet | buyer must transfer USDT to Payrail custody (or escrow) as a second, separately verified step |
| Seller payout (USDT → X) | **custody wallet** (holds collected USDT) | custody wallet | custody wallet transfers X to the seller's verified address as a second step |

## 3. Can the current operator-wallet architecture do this?

| Question | Answer |
|---|---|
| Fund from buyers' own assets? | **No.** The server holds one key (the operator's). Buyers are anonymous accounts. The simulation we built converts "the operator's" cNGN. Live, that would be a faucet from the operator wallet. Buyer funding **must** be signed by the buyer's own wallet. |
| Does the server need buyer keys? | **No, and it must never have them.** The server prepares and validates; the buyer's wallet (browser extension, EIP-1193) signs the proof and sends the transactions. |
| Seller payout conversion with the operator wallet? | **Yes, but only as a bounded signer** over *custody* funds (collected USDT), never the operator's personal balances, and only for an approved payout: fixed amount, fixed token allow-list, fixed recipient = the seller's verified address, minimum output from the quote the seller saw. This is a new signing path and needs its own review. |
| Escrow path | Seller claims USDT on-chain; a conversion afterwards is the seller's own wallet's business (they can swap on Textile themselves). Payout preferences are **advisory** on the escrow path unless the contract is extended. |

## 4. Recommended architecture

### 4.1 Principles

1. **USDT is the unit of account.** Prices, balances, fees, earnings stay USDT. Foreign assets exist only inside funding and payout *conversions*.
2. **Funding and payout are different workflows** with different signers, routes and ledger effects. Never share a route table or assume reversibility.
3. **Providers are plug-ins.** Textile is one `ConversionProvider`; Ramp, Mento or a future provider implement the same interface.
4. **Authorization is a property of the quote**, not of the server: `signer = buyer-wallet | custody-bounded`.
5. **Credit only from verified on-chain facts** read by Payrail itself (existing `verifyConversion`/`confirmDeposit` pattern, generalised).

### 4.2 Interfaces (proposed)

```ts
interface AssetRef { chainId: number; address: string; symbol: string; decimals: number }

type Direction = 'funding' | 'payout';

interface Route {
  provider: string;                // 'textile-rfq'
  direction: Direction;
  from: AssetRef;                  // funding: buyer's asset. payout: USDT
  to: AssetRef;                    // funding: USDT. payout: seller's asset
  available: boolean;
  unavailableReason?: 'no_makers_online' | 'no_levels' | 'below_floor' | 'chain_unsupported' | 'disabled';
  minInputAtomic: bigint;          // corridor floor
  maxInputAtomic: bigint;          // ladder depth (indicative)
  discoveredAt: number;            // routes are never cached past a short TTL
}

interface ConversionProvider {
  id: string;
  discoverRoutes(q: { direction: Direction; chainId: number }): Promise<Route[]>;
  quote(r: { route: Route; inputAtomic: bigint; party: Party }): Promise<ConversionQuote>;
  /** What must be signed, by whom. For 'buyer-wallet' this returns unsigned txs for the browser wallet. */
  prepare(q: ConversionQuote): Promise<ExecutionPlan>;
  /** Pure: judge a receipt against what was authorized. */
  verify(receipt: ChainReceipt, head: bigint, expected: ExpectedFill): Verdict;
}

interface ConversionQuote {
  id: string; provider: string; route: Route;
  inputAtomic: bigint; expectedOutputAtomic: bigint; minOutputAtomic: bigint;
  feeAtomic: bigint; rate: string; expiresAtMs: number;
  signer: 'buyer-wallet' | 'custody-bounded';
  taker: string;                   // who fills, who receives
  recipientAfterConversion: string;// final destination (deposit address or seller address)
  approvalDigest: string;          // binds every field above
}
```

`verify` generalises today's `verifyConversion(receipt, head, {usdt, reactor, recipient, min, confirmations})`:
expected token contract, expected recipient, filler = taker, Fill from the verified reactor, minimum output.

### 4.3 Buyer funding (X → USDT → balance)

```
select asset ─► discoverRoutes(funding) ─► [if already USDT: skip]
  ─► quote (rate, fee, expected, minimum, expiry, limits) ─► buyer approves digest
  ─► browser wallet: sign TakerControl proof; server requests the firm quote bound to the buyer's wallet
  ─► server validates quote calldata (existing validateFirmQuote, payer = buyer wallet; spender/reactor/selectors/outputs)
  ─► browser wallet sends approve(exact) and executeBatch
  ─► server reads the swap receipt: Fill(filler = buyer wallet) + USDT received by buyer wallet >= minimum
  ─► buyer wallet transfers USDT to the Payrail deposit address (or escrow deposit)
  ─► existing confirmDeposit: Transfer from the REGISTERED wallet to the deposit address, token = USDT, confirmations
  ─► ledger credit once (ref fund:<op>), keyed to the buyer who proved the wallet
```
Credit is the **USDT that actually reached custody**, not the swap's expected output. Two on-chain hops are inherent while
Textile cannot set a recipient. A single-hop experience would need a small audited router contract (pull → swap →
forward) deployed to Celo; that is a separate decision and is not assumed here.

Wallet ownership: generalise `funding_wallets` to `(buyer_id, chain_id, address, signature)`; one wallet ↔ one buyer
(already enforced). A transaction is attributed only if it was sent **from** a wallet the buyer proved.

### 4.4 Seller payouts (USDT → preferred asset)

Earnings stay USDT in the ledger. A payout request is the existing state machine plus a conversion leg:

```
requested ─► quoted(seller sees expected asset amount, rate, fee, minimum, expiry)
  ─► seller confirms digest ─► approved (operator, as today)
  ─► CONVERTING (custody-bounded signer: approve exact USDT, executeBatch)  — USDT leaves custody only into the swap
  ─► CONVERTED (receipt verified: Fill, target asset received by custody wallet >= minimum)
  ─► DELIVERING (ERC-20 transfer to the seller's VERIFIED address)
  ─► DELIVERED (receipt verified: token, recipient, amount, confirmations)  ─► ledger payout_confirm
```
* **If conversion fails before any swap:** `payout_cancel`: USDT earnings are restored (already how it works).
* **If swapped but not yet delivered:** a distinct `CONVERTED_UNDELIVERED` state. The liability is now in the target
  asset. It is never silently returned to USDT earnings; it is retried (delivery) or explicitly reconverted with a new quote.
* **Seller address verification:** the seller signs a message proving control of the payout address (same mechanism as the
  buyer funding wallet); the address is bound to the seller account; changes require a new proof and take effect only for
  new payouts (pending payouts keep the address they were quoted for).
* **Preference changes:** stored per listing with an account default; each payout request **snapshots** the preference
  (asset, address) at request time. A change applies to payouts requested after it.
* **Minimum:** Textile's ≈$1 notional floor means a **minimum payout threshold** (earnings accumulate in USDT until the
  threshold) and per-asset depth caps (IDRX ≈$2, CELO ≈$33, WETH ≈$55). The UI offers only assets whose route is live
  *now*; the preference is re-validated at quote time and falls back to USDT with a clear message, never to an unknown rate.

### 4.5 Data model changes

| Table | Change |
|---|---|
| `conversion_assets` (new) | `(chain_id, address)` PK, symbol, decimals, `funding_enabled`, `payout_enabled`, verified_at, source. Operator-curated allow-list; live discovery only *proposes* entries. |
| `funding_wallets` | add `chain_id`; PK `(chain_id, address)` |
| `funding_ops` | add `source_chain_id, source_address, source_decimals, taker_wallet, signer, route_json`; `sell_symbol` no longer assumed `cNGN`; add `deposit_tx` and states `SWAPPED` (USDT in buyer wallet, not yet deposited), `DEPOSIT_PENDING` |
| `payout_preferences` (new) | `(seller_id, listing_id NULL)`, `asset_chain_id, asset_address`, `version`, `effective_from` (append-only versions) |
| `payout_addresses` (new) | `(seller_id, chain_id, address, signature, verified_at)` |
| `payouts` | add `target_chain_id, target_address, quote_id, expected_target_atomic, min_target_atomic, fee_atomic, conversion_tx, delivery_tx, received_target_atomic, preference_version` and states `QUOTED, CONVERTING, CONVERTED_UNDELIVERED, DELIVERING` |
| `conversion_quotes` (new) | generic quote record shared by both directions (id, provider, direction, from/to refs, amounts, expiry, digest, signer, state) |
| `*_events` | funding events exists; add payout events (append-only) |

### 4.6 Ledger and invariants

Funding credits are `deposit`s of USDT with ref `fund:<op>` (exists). Payout conversion does **not** touch internal
prices or fees. Add:

* `payout_confirm` moves USDT `payout_pending → external_funding` only when **DELIVERED** is verified; the target-asset
  amount and tx ids live in `payouts` / receipt, not in USDT ledger lines.
* Invariants (extend `verifyLedger`): open payouts total = `payout_pending`; a payout with `conversion_tx` but no
  `delivery_tx` is never in `confirmed`; a swap tx is claimed by exactly one operation; credited USDT ≤ verified
  Transfer amount to deposit; no USDT credit without a deposit Transfer from a proven wallet.
* Direct vs escrow settlement remain separate buckets; escrow earnings are claimed on-chain by the seller and are outside
  payout conversion.

### 4.7 UI changes

* Buyer **Add funds**: asset picker from `discoverRoutes(funding)` (only live routes), amount, quote card (rate, fee,
  expected, minimum, expiry, limits), wallet connect, step tracker (proof → approve → swap → deposit → credited), history.
  "I already have USDT" skips straight to the deposit step.
* Seller **listing settings**: payout asset selector (USDT default; other assets only if enabled and live), address
  verification, "takes effect for payouts requested after saving".
* Seller **Earnings & payouts**: still USDT; each payout shows asset, expected amount, rate, fee, minimum, status of
  conversion and delivery, and the receipt.
* Receipts: funding receipt (swap tx, deposit tx, credited amount); payout receipt (USDT in, target out, rate, both txs).

### 4.8 Failure and recovery matrix

| Event | Funding | Payout |
|---|---|---|
| Unsupported / no liquidity | clear "no verified route", no quote | preference falls back to USDT with notice, never an unknown rate |
| Quote expired | `EXPIRED`, nothing sent | `QUOTED` expires, earnings untouched |
| Slippage beyond minimum | on-chain order enforces minimum; below-minimum receipt → `REVIEW` | same → `REVIEW`; USDT not marked paid |
| Swap reverted | `FAILED`, nothing credited | USDT never left custody → restored |
| Swap confirmed, deposit/delivery missing | `SWAPPED` (funds in buyer wallet, not credited) | `CONVERTED_UNDELIVERED` |
| Receipt unreadable / delayed | `VERIFYING`/`UNRESOLVED`, never spendable | same; never completed |
| Duplicate notification / replay | tx claim table + unique ledger ref | unique payout ref + tx claim |
| Server restart | `recoverFunding` re-reads chain | `recoverPayouts` re-reads chain; no signing during recovery |

## 5. Staged plan

| Stage | Scope | Evidence level |
|---|---|---|
| 0 (done) | Single-asset simulation, engine, verification, ledger, UI | automated + browser |
| 1 | Provider interface + route registry + multi-asset **simulation** (including asymmetric/thin/missing routes); payout preference + address-proof data model; simulated payout conversion | automated + browser |
| 2 | Property tests of the invariants; failure/recovery matrix tests; live **read-only** route discovery (like today's probes) | automated + read-only live |
| 3 | Textile **testnet**: only Base Sepolia / BNB testnet with a Textile `tx_test_` key (requires asking Textile). Verifies the taker proof → approve → executeBatch → receipt flow with a buyer-owned test wallet. **Celo Sepolia has no Textile contract**, so Celo-side steps (deposit, escrow) stay on mock tokens | testnet |
| 4 | Mainnet-only: real liquidity, real wallets, smallest amounts, plan-only first; needs your explicit approval and a custody decision | mainnet |

## 6. What cannot be implemented yet, and why

| Item | Blocker |
|---|---|
| CWT funding or payout | No route anywhere I can see; I do not know the token. Need chain + contract address, then a live ladder entry. |
| Local fiat → Celo USDT | Ramp is NGN ↔ cNGN on **BNB/Base** only; none on Celo; buy needs KYC. |
| Fiat bank payout from Celo | Same: sell corridor is BNB/Base only. |
| Single-transaction funding straight to the deposit address | Textile has no recipient parameter. Needs two wallet transactions, or a router contract (new deployment, audit). |
| Buyer funding in the live server | Server must never hold buyer keys; needs **browser-wallet signing** (EIP-1193 `signTypedData` for the proof and `sendTransaction`), not built. |
| Payout conversion in the live server | Needs a **bounded custody signer** (new signing path, own review) and a separate custody wallet; must not use the operator's personal wallet. |
| wMXN, G$ payouts | USDT → X has no makers (wMXN) or no levels (G$). |
| IDRX / CELO / WETH payouts at size | Depth ≈ $2 / $33 / $55. |
| Payouts below ≈ $1 | Corridor floor; requires a payout threshold. |
| Funding from other chains | No bridge; ledger and escrow are Celo-only. |
| Textile testnet on Celo | No FX settlement contract on Celo Sepolia. |
| "Real-time" guarantees | Liquidity is makers' published levels and changes without notice; routes must be re-checked at every quote. |

## 7. Recommendation

1. Keep the current simulation and the live adapter **unwired**.
2. Approve **Stage 1** (provider interface, route registry, multi-asset simulation, payout preferences and address
   proofs, simulated payout conversion). It is safe: no signing, no real funds.
3. Decide separately, later: (a) browser-wallet signing for buyer funding (recommended), versus an audited router
   contract for single-hop funding; (b) a dedicated custody wallet with a bounded signer for payout conversion; (c) which
   payout assets to enable (suggest USDT, cNGN, wARS, wBRL first; deep and symmetric).
4. Ask Textile about test keys for Base Sepolia/BNB testnet and about CWT, if CWT is a real requirement.
