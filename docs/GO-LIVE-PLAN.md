# Path from simulated marketplace to on-chain product (audit and staged plan)

> **Historical document.** It describes development modes (test credits, simulation, testnet escrow) that are not part of the production product. See [PRODUCTION.md](PRODUCTION.md) for what is real today.


Audited 2026-10-15 at commit 8566438. Status key: REAL = works against the real network when real-funds mode is enabled;
SIM = simulation only; MISSING = not built.

| Journey step | State today | Gap |
|---|---|---|
| Seller wallet sign-in | REAL (signature, single-use nonce) | message not chain-bound |
| **Buyer wallet sign-in** | **Stage 1 (this change): REAL** (signature, network named in message, single-use, per-role account) | UI exercised only with an extension wallet (not headless) |
| Seller create / verify / publish API | REAL (domain + wallet proofs, contracts) | none known |
| Buyer discover, inspect, buy, real API call | REAL (gateway, outcome billing, encrypted credentials) | pays from test credits unless real-funds mode |
| Buyer funding with USDT (no swap) | REAL code path (`confirmDeposit`, wallet proof, confirmations) behind `PAYRAIL_MARKET_LIVE` | never run on mainnet by this build; needs your approval + a deposit address |
| Buyer funding from other assets | SIM | buyer-signed Textile approve + executeBatch + USDT deposit transfer; never operator wallet |
| Seller payout in USDT | REAL code path (operator approval, verified transfer) behind live mode | not exercised on mainnet |
| Seller payout in other assets | SIM | Textile pays the signer, so the custody wallet must swap and then transfer to the seller's verified address: needs a bounded signer (security review) |
| Multi-currency evidence | cNGN both directions executed once; others quoted only | each asset needs its own executed + verified route before enabling |

## Stages
1. **Buyer wallet sign-in** (done, tested). 
2. **Real USDT funding via live mode** (needs approval): enable `PAYRAIL_MARKET_LIVE` with your deposit address and caps; buyer sends USDT from the proven wallet; server verifies token/recipient/amount/confirmations; first real deposit tested with a tiny amount.
3. **Buyer-signed conversion**: client-side approve + executeBatch via the connected wallet, server verifies the swap receipt and the follow-up deposit. Per asset, only after one verified execution.
4. **Bounded payout signer**: per-payout and daily caps, verified destinations only, key in a KMS/HSM, human approval; swap then deliver then verify.
5. **Frontend**: remove simulated wording in live mode (already branches on `simulated`); add pending/success/failed/review states for the live path.

## Needs your approval before any of it
Enabling live mode, any real swap/transfer/payout, funding a deposit address, deploying contracts, publishing.
