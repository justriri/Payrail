# Payrail: services used and proof of payments

Generated 2026-10-23T12:27:15.742Z

## Addresses

| Role | Address | Note |
|---|---|---|
| payTo (recipient of the x402 payment) | `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B` | the service gateway's receiving address |
| payer (Payrail wallet) | `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4` | signed the payment authorization; NOT the payTo |

## Services used

| Service | Endpoint | Payments | Confirmed | Total paid |
|---|---|---|---|---|
| `x.posts.search` | https://gateway.usebuy.ai/v1/social/x/posts/search | 3 | 3 | 0.015 USDT |

## Orders (a conversion and the payment it funded, as one unit)

### Order b5660887-a162-4116-ab65-c2a86512a7c6: COMPLETED (COMPLETED)

- **Service:** `x.posts.search` via buy-gateway
- **Route taken:** direct
- **Approved:** pay 5000 atomic USDT to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`; plan digest `c21d6495285092f51c72f42456ed006b272a647bfa44ac5b6b9523b01b0a8291`
- **Payment:** CONFIRMED; receipt `direct-2026-10-13T14-41-27-277Z`; tx [0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe](https://celoscan.io/tx/0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe)
- **Service delivery:** delivered true; HTTP 200; response sha256 `08d00251fe2226a89174efc8fbe1a7ec70fe2bdb1c8f2f516df11de5bdd8ff04`; stored at `responses/direct-2026-10-13T14-41-27-277Z.body`
- **Ledger entries:** #6
- _Cross-check:_ payment tx matches receipt direct-2026-10-13T14-41-27-277Z (CONFIRMED)
- **On-chain re-check:** every linked transaction found and successful: true

### Order 25aa7922-e01d-441d-9296-a77e14d87b0e: STOPPED (CONVERSION_FAILED)

- **Service:** `x.posts.search` via buy-gateway
- **Route taken:** not paid
- **Approved:** pay 5000 atomic USDT to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`; plan digest `69447979ad240afab6f20eb65a8365ba41c73eacb7fae87b479e70dbdbf223b5`; approved by human:web
- **Conversion:** textile-fx-v2 FAILED; swap plan `9e11ef02-663e-47d0-9a22-10165d0b13cb`; sold 1363850000 atomic cNGN; received ? atomic USDT
- **Payment:** none was made for this order
- **Ledger entries:** none
- _Cross-check:_ conversion tx hashes match swap record 9e11ef02-663e-47d0-9a22-10165d0b13cb (FAILED)

### Order d9c24dc8-87c4-41be-8791-a82bff1bbb81: STOPPED (CONVERSION_FAILED)

- **Service:** `x.posts.search` via buy-gateway
- **Route taken:** not paid
- **Approved:** pay 5000 atomic USDT to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`; plan digest `a64ac08073cee5c12022af5b8439498ad40ec8aba006b4773e4808f347e926a0`; approved by human:web
- **Conversion:** textile-fx-v2 FAILED; swap plan `e3f2c034-4aee-46f0-b684-b09388432eb3`; sold 1363665000 atomic cNGN; received ? atomic USDT
  - tx [0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32](https://celoscan.io/tx/0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32)
- **Payment:** none was made for this order
- **Ledger entries:** #8
- _Cross-check:_ conversion tx hashes match swap record e3f2c034-4aee-46f0-b684-b09388432eb3 (FAILED)
- **On-chain re-check:** every linked transaction found and successful: true
- **Acknowledged** (2026-10-14T10:00:09.283Z, by human:project-owner (instructed in chat, 2026-10-14)). The order record still says "needs attention"; this note explains why it is understood and safe:
  - _Note:_ Attempt 2 of the cNGN→USDT conversion. The approval of 1363.665 cNGN to the Textile reactor was mined. The allowance read immediately afterwards returned 0 because the RPC node was lagging (the chain held the full amount at the approval's block), so Payrail correctly stopped before requesting a swap quote or executing a swap. No swap or API payment occurred in this attempt. The existing approval was reused by the successful later attempt, and the remaining allowance to the reactor is now zero.
  - _Verified:_ an approval for 1363.665 cNGN to the Textile reactor was mined successfully from the Payrail wallet (tagged: celo_b2fff2ac9413) (0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32 block 80038278, status success, approve(0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3, 1363665000), confirmed by 2 endpoint(s))
  - _Verified:_ the allowance read recorded right after the approval was 0, although the chain held the full approved amount at the approval block (the read was stale; consistent with a lagging RPC node) (journal residualAllowance=0; exact-block allowance at block 80038278 = 1363665000)
  - _Verified:_ Payrail stopped before requesting a swap quote or executing a swap (swap journal e3f2c034-4aee-46f0-b684-b09388432eb3: state FAILED, code APPROVAL_INEFFECTIVE, quote id none, steps approve)
  - _Verified:_ no swap and no API payment occurred during this attempt (order has no payment record (true); receipts stamped with this order: 0; swap transaction hashes in the journal: 0)
  - _Verified:_ the existing approval was reused by the later, successful attempt (order 90f8d4be-0388-467e-a5b0-4b630d0411d2 COMPLETED; its swap 0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7 (block 80038743, after the approval block 80038278) moved 1363665000 cNGN atomic from the wallet; it sent no approval of its own)
  - _Verified:_ the remaining allowance to the reactor is now zero (allowance(0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4, 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) = 0)

### Order 90f8d4be-0388-467e-a5b0-4b630d0411d2: COMPLETED (COMPLETED)

- **Service:** `x.posts.search` via buy-gateway
- **Route taken:** converted
- **Approved:** pay 5000 atomic USDT to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`; plan digest `730f567a0137c919a2bb214db447f17da8e6514783ebb42e41129475f80304ee`; approved by human:web
- **Conversion:** textile-fx-v2 CONFIRMED; swap plan `7f6a2512-00ff-4b84-a2b2-b41c2f0b3350`; sold 1363665000 atomic cNGN; received 998910 atomic USDT
  - tx [0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7](https://celoscan.io/tx/0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7)
- **Payment:** CONFIRMED; receipt `direct-2026-10-14T00-58-50-389Z`; tx [0xf3652222377fb527211fb4fbd1a7e6c6f7f7341048334eb4223806b88c9f2c9c](https://celoscan.io/tx/0xf3652222377fb527211fb4fbd1a7e6c6f7f7341048334eb4223806b88c9f2c9c)
- **Service delivery:** delivered true; HTTP 200; response sha256 `4a2451147286359972506af30aaff4f85d7892ad8ca9175bf2f829ba90b15177`; stored at `responses/direct-2026-10-14T00-58-50-389Z.body`
- **Ledger entries:** #9, #10
- _Cross-check:_ conversion tx hashes match swap record 7f6a2512-00ff-4b84-a2b2-b41c2f0b3350 (CONFIRMED)
- _Cross-check:_ payment tx matches receipt direct-2026-10-14T00-58-50-389Z (CONFIRMED)
- **On-chain re-check:** every linked transaction found and successful: true


## Transaction ledger (every real on-chain transaction)

Only transactions that were actually sent to Celo mainnet are listed. Mock tests, simulations and read-only previews are not transactions and are not listed.

### 1. x402 payment: [0xfb012c514207add68399c8c575d89e9c352c94ac8131378d8e1ffa233f8217ac](https://celoscan.io/tx/0xfb012c514207add68399c8c575d89e9c352c94ac8131378d8e1ffa233f8217ac)

- **Purpose:** Pay for the service x.posts.search through the x402 protocol
- **Provider:** Buy gateway (x402, gateway.usebuy.ai)
- **Token / amount (journal):** 0.005 USDT
- **Origin:** payment receipt
- **payer (signed the payment authorization):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **payTo (recipient of the stablecoin transfer):** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **transaction submitter:** the gateway/facilitator; shown as tx.from when verified on-chain
- **Settlement (journal):** authorization settled; Transfer(payer -> payTo) found: true; receipt status CONFIRMED
- **Attribution:** not applicable; x402 settlements are submitted by the facilitator; attribution tags are not yet supported by x402 and the organizers confirmed none is needed for Buy
- **On-chain re-check (2026-10-23T12:27:20.674Z):** found: true; status: success; block 79920194; tx.from `0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48`; to `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
  - verifyTx attribution codes: none
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x20faAca5F980E29639A0FCC6dcA6988E18ed333B, 5000 atomic
  - submitted by 0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48 (not the Payrail wallet), as expected for a gateway-sponsored x402 settlement

### 2. approve: [0xbe28a28915b7da5772cce9eb38121ebc472ea6d3dbddb9a7c223cdb2b4a80159](https://celoscan.io/tx/0xbe28a28915b7da5772cce9eb38121ebc472ea6d3dbddb9a7c223cdb2b4a80159)

- **Purpose:** Approve USDm for the mento-router-v3 contract so USDm -> USDT can be converted
- **Provider:** mento-router-v3
- **Token / amount (journal):** 1.0152676852242757 USDm
- **Origin:** confirmed conversion
- **sender / signer (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (token):** `0x765DE816845861e75A25fCA122bb6898B8B1282a`
- **Settlement (journal):** mined; conversion state CONFIRMED; received 1016308 atomic
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:22.365Z):** found: true; status: success; block 79963003; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0x765DE816845861e75A25fCA122bb6898B8B1282a`
  - verifyTx attribution codes: celo_b2fff2ac9413
  - call: approve(spender 0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6, amount 1015267685224275700 atomic)

### 3. swap: [0xa935302cf2629db8b9b12003aba76e8986d5b69ca25af23ec25672b97847d953](https://celoscan.io/tx/0xa935302cf2629db8b9b12003aba76e8986d5b69ca25af23ec25672b97847d953)

- **Purpose:** Convert USDm -> USDT through mento-router-v3
- **Provider:** mento-router-v3
- **Token / amount (journal):** 1.0152676852242757 USDm
- **Origin:** confirmed conversion
- **sender / signer (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (venue):** `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6`
- **Settlement (journal):** mined; conversion state CONFIRMED; received 1016308 atomic
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:23.848Z):** found: true; status: success; block 79963010; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6`
  - verifyTx attribution codes: celo_b2fff2ac9413
  - Transfer of 0x765DE816845861e75A25fCA122bb6898B8B1282a: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x0FEBa760d93423D127DE1B6ABECdB60E5253228D, 1015267685224275700 atomic
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x0FEBa760d93423D127DE1B6ABECdB60E5253228D -> 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4, 1016308 atomic

### 4. approve: [0xf862f1b78a64d0451c214d72efdf018baa41ebb58aac3c320f045f88df1c103b](https://celoscan.io/tx/0xf862f1b78a64d0451c214d72efdf018baa41ebb58aac3c320f045f88df1c103b)

- **Purpose:** Approve USDT for the textile-fx-v2 contract so USDT -> cNGN can be converted (the attempt it belonged to ended FAILED/QUOTE_INVALID before any swap was sent)
- **Provider:** textile-fx-v2
- **Token / amount (journal):** 1 USDT
- **Origin:** stopped attempt (FAILED/QUOTE_INVALID); no swap was sent
- **sender / signer (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (token):** `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
- **Settlement (journal):** mined; conversion state FAILED
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:25.371Z):** found: true; status: success; block 79963336; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
  - verifyTx attribution codes: celo_b2fff2ac9413
  - call: approve(spender 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3, amount 1000000 atomic)

### 5. swap: [0xab592f83fe659607fff8c8892373c89bb396348028761fa8844c42f82a1d1c0c](https://celoscan.io/tx/0xab592f83fe659607fff8c8892373c89bb396348028761fa8844c42f82a1d1c0c)

- **Purpose:** Convert USDT -> cNGN through textile-fx-v2
- **Provider:** textile-fx-v2
- **Token / amount (journal):** 1 USDT
- **Origin:** confirmed conversion
- **sender / signer (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (venue):** `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`
- **Settlement (journal):** mined; conversion state CONFIRMED; received 1365928991 atomic
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:26.966Z):** found: true; status: success; block 79963880; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`
  - verifyTx attribution codes: celo_b2fff2ac9413
  - Transfer of 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f: 0x25A5c1Ae633eB3e1988CfdEed07CdbD2E998AB52 -> 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4, 1365928991 atomic
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x25A5c1Ae633eB3e1988CfdEed07CdbD2E998AB52, 999901 atomic
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x51727A09b55d56BF8f3CBe61f460327330aECbA4, 99 atomic

### 6. x402 payment: [0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe](https://celoscan.io/tx/0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe)

- **Purpose:** Pay for the service x.posts.search through the x402 protocol
- **Provider:** Buy gateway (x402, gateway.usebuy.ai)
- **Token / amount (journal):** 0.005 USDT
- **Origin:** payment receipt; part of order `b5660887-a162-4116-ab65-c2a86512a7c6`
- **payer (signed the payment authorization):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **payTo (recipient of the stablecoin transfer):** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **transaction submitter:** the gateway/facilitator; shown as tx.from when verified on-chain
- **Settlement (journal):** authorization settled; Transfer(payer -> payTo) found: true; receipt status CONFIRMED
- **Attribution:** not applicable; x402 settlements are submitted by the facilitator; attribution tags are not yet supported by x402 and the organizers confirmed none is needed for Buy
- **On-chain re-check (2026-10-23T12:27:28.518Z):** found: true; status: success; block 80001720; tx.from `0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48`; to `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
  - verifyTx attribution codes: none
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x20faAca5F980E29639A0FCC6dcA6988E18ed333B, 5000 atomic
  - submitted by 0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48 (not the Payrail wallet), as expected for a gateway-sponsored x402 settlement

### 7. erc8004 registration: [0xf654ea5f5286e0a53a1412a7769b48ef38742134d98bd0a7c6938089126cab1b](https://celoscan.io/tx/0xf654ea5f5286e0a53a1412a7769b48ef38742134d98bd0a7c6938089126cab1b)

- **Purpose:** Register the Payrail agent identity on the ERC-8004 Identity Registry (agent ID 9906)
- **Provider:** ERC-8004 Identity Registry (Celo mainnet)
- **Token / amount (journal):** 0 CELO (gas only)
- **Origin:** agent identity registration
- **sender / owner of the agent identity (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (Identity Registry):** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- **Settlement (journal):** CONFIRMED; block 80032609; agent ID 9906; owner verified: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4; stored tokenURI matches: true
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:29.962Z):** found: true; status: success; block 80032609; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
  - verifyTx attribution codes: celo_b2fff2ac9413

### 8. approve: [0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32](https://celoscan.io/tx/0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32)

- **Purpose:** Approve cNGN for the textile-fx-v2 contract so cNGN -> USDT can be converted (the attempt it belonged to ended FAILED/APPROVAL_INEFFECTIVE before any swap was sent)
- **Provider:** textile-fx-v2
- **Token / amount (journal):** 1363.665 cNGN
- **Origin:** stopped attempt (FAILED/APPROVAL_INEFFECTIVE); no swap was sent; part of order `d9c24dc8-87c4-41be-8791-a82bff1bbb81`
- **sender / signer (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (token):** `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`
- **Settlement (journal):** mined; conversion state FAILED
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:33.838Z):** found: true; status: success; block 80038278; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`
  - verifyTx attribution codes: celo_b2fff2ac9413
  - call: approve(spender 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3, amount 1363665000 atomic)

### 9. swap: [0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7](https://celoscan.io/tx/0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7)

- **Purpose:** Convert cNGN -> USDT through textile-fx-v2
- **Provider:** textile-fx-v2
- **Token / amount (journal):** 1363.665 cNGN
- **Origin:** confirmed conversion; part of order `90f8d4be-0388-467e-a5b0-4b630d0411d2`
- **sender / signer (Payrail wallet):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **called contract (venue):** `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`
- **Settlement (journal):** mined; conversion state CONFIRMED; received 998910 atomic
- **Attribution:** journal verified: true (celo_b2fff2ac9413); Payrail submitted this transaction itself, so it carries the ERC-8021 tag
- **On-chain re-check (2026-10-23T12:27:35.175Z):** found: true; status: success; block 80038743; tx.from `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`; to `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`
  - verifyTx attribution codes: celo_b2fff2ac9413
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x25A5c1Ae633eB3e1988CfdEed07CdbD2E998AB52 -> 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4, 998910 atomic
  - Transfer of 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x25A5c1Ae633eB3e1988CfdEed07CdbD2E998AB52, 1363528648 atomic
  - Transfer of 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x51727A09b55d56BF8f3CBe61f460327330aECbA4, 136352 atomic

### 10. x402 payment: [0xf3652222377fb527211fb4fbd1a7e6c6f7f7341048334eb4223806b88c9f2c9c](https://celoscan.io/tx/0xf3652222377fb527211fb4fbd1a7e6c6f7f7341048334eb4223806b88c9f2c9c)

- **Purpose:** Pay for the service x.posts.search through the x402 protocol
- **Provider:** Buy gateway (x402, gateway.usebuy.ai)
- **Token / amount (journal):** 0.005 USDT
- **Origin:** payment receipt; part of order `90f8d4be-0388-467e-a5b0-4b630d0411d2`
- **payer (signed the payment authorization):** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **payTo (recipient of the stablecoin transfer):** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **transaction submitter:** the gateway/facilitator; shown as tx.from when verified on-chain
- **Settlement (journal):** authorization settled; Transfer(payer -> payTo) found: true; receipt status CONFIRMED
- **Attribution:** not applicable; x402 settlements are submitted by the facilitator; attribution tags are not yet supported by x402 and the organizers confirmed none is needed for Buy
- **On-chain re-check (2026-10-23T12:27:37.480Z):** found: true; status: success; block 80038764; tx.from `0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48`; to `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
  - verifyTx attribution codes: none
  - Transfer of 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: 0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4 -> 0x20faAca5F980E29639A0FCC6dcA6988E18ed333B, 5000 atomic
  - submitted by 0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48 (not the Payrail wallet), as expected for a gateway-sponsored x402 settlement


## Payments (x402)

### direct-2026-10-12T16-02-41-922Z

- **Status:** CONFIRMED; delivered: true; HTTP 200
- **Service:** `x.posts.search` (https://gateway.usebuy.ai/v1/social/x/posts/search)
- **Amount:** 0.005 USDT (asset `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`)
- **payTo:** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **Payer:** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **Transaction:** [0xfb012c514207add68399c8c575d89e9c352c94ac8131378d8e1ffa233f8217ac](https://celoscan.io/tx/0xfb012c514207add68399c8c575d89e9c352c94ac8131378d8e1ffa233f8217ac)
- **Settlement:** authorization `settled`; Transfer(payer -> payTo) found: true
- **Response:** JSON keys [capability, transaction, payment, provider, upstreamRunId, resultCount, output]; output: object; 57656 bytes
- _Note:_ legacy receipt (written before schema v1)
- _Note:_ the response body was not retained for this payment (only a structural summary was kept)
- _Note:_ x402 settlement is submitted by the facilitator and carries no attribution tag; the organizers confirmed none is needed for Buy
- _Note:_ LIVE RE-VERIFICATION 2026-10-23T12:27:18.332Z: receipt success, block 79920194, confirmed by 2 endpoint(s), Transfer(payer -> payTo, 0.005 USDT) found: true

### direct-2026-10-13T14-41-27-277Z

- **Status:** CONFIRMED; delivered: true; HTTP 200
- **Service:** `x.posts.search` (https://gateway.usebuy.ai/v1/social/x/posts/search)
- **Amount:** 0.005 USDT (asset `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`)
- **payTo:** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **Payer:** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **Transaction:** [0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe](https://celoscan.io/tx/0x57c3c046355dcd623efdcf1daa76b7cb8c46db87528a92116afa379d290f57fe)
- **Settlement:** authorization `settled`; Transfer(payer -> payTo) found: true
- **Response:** JSON keys [capability, transaction, payment, provider, upstreamRunId, resultCount, output]; output: object; 48403 bytes; sha256 `08d00251fe2226a89174efc8fbe1a7ec70fe2bdb1c8f2f516df11de5bdd8ff04`; stored at `responses/direct-2026-10-13T14-41-27-277Z.body`
- _Note:_ x402 settlement is submitted by the facilitator and carries no attribution tag; the organizers confirmed none is needed for Buy
- _Note:_ LIVE RE-VERIFICATION 2026-10-23T12:27:19.924Z: receipt success, block 80001720, confirmed by 2 endpoint(s), Transfer(payer -> payTo, 0.005 USDT) found: true
- _Note:_ RESPONSE FILE CHECK: sha256 of responses/direct-2026-10-13T14-41-27-277Z.body recomputed and matches the receipt

### direct-2026-10-14T00-58-50-389Z

- **Status:** CONFIRMED; delivered: true; HTTP 200
- **Service:** `x.posts.search` (https://gateway.usebuy.ai/v1/social/x/posts/search)
- **Amount:** 0.005 USDT (asset `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`)
- **payTo:** `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`
- **Payer:** `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4`
- **Transaction:** [0xf3652222377fb527211fb4fbd1a7e6c6f7f7341048334eb4223806b88c9f2c9c](https://celoscan.io/tx/0xf3652222377fb527211fb4fbd1a7e6c6f7f7341048334eb4223806b88c9f2c9c)
- **Settlement:** authorization `settled`; Transfer(payer -> payTo) found: true
- **Response:** JSON keys [capability, transaction, payment, provider, upstreamRunId, resultCount, output]; output: object; 67154 bytes; sha256 `4a2451147286359972506af30aaff4f85d7892ad8ca9175bf2f829ba90b15177`; stored at `responses/direct-2026-10-14T00-58-50-389Z.body`
- _Note:_ x402 settlement is submitted by the facilitator and carries no attribution tag; the organizers confirmed none is needed for Buy
- _Note:_ LIVE RE-VERIFICATION 2026-10-23T12:27:20.673Z: receipt success, block 80038764, confirmed by 2 endpoint(s), Transfer(payer -> payTo, 0.005 USDT) found: true
- _Note:_ RESPONSE FILE CHECK: sha256 of responses/direct-2026-10-14T00-58-50-389Z.body recomputed and matches the receipt

## Conversions Payrail executed (ERC-8021 tagged)

### USDm -> USDT via mento-router-v3: CONFIRMED (CONFIRMED_BY_REVERIFICATION)

Plan `3d0e5d35-768d-4e23-a5bb-d26f8dd0a7c0`, 2026-10-13T04:00:11.246Z; requested 1015267685224275700 atomic; received 1016308 atomic.

- approve: [0xbe28a28915b7da5772cce9eb38121ebc472ea6d3dbddb9a7c223cdb2b4a80159](https://celoscan.io/tx/0xbe28a28915b7da5772cce9eb38121ebc472ea6d3dbddb9a7c223cdb2b4a80159); mined: true; attribution verified by verifyTx: true (celo_b2fff2ac9413)
- swap: [0xa935302cf2629db8b9b12003aba76e8986d5b69ca25af23ec25672b97847d953](https://celoscan.io/tx/0xa935302cf2629db8b9b12003aba76e8986d5b69ca25af23ec25672b97847d953); mined: true; attribution verified by verifyTx: true (celo_b2fff2ac9413)
- _Note:_ reconciliation: sell balance change 0 vs logged 1015267685224275700; buy balance change 0 vs logged 1016308
- _Note:_ exact-block reconciliation at block 79963010: sell 1015267685224275700 -> 0 (logged 1015267685224275700); buy 624915 -> 1641223 (logged 1016308)

### USDT -> cNGN via textile-fx-v2: CONFIRMED (CONFIRMED)

Plan `c82c0ccf-24b8-40e2-8b86-3e5ade49815b`, 2026-10-13T04:10:41.265Z; requested 1000000 atomic; received 1365928991 atomic.

- swap: [0xab592f83fe659607fff8c8892373c89bb396348028761fa8844c42f82a1d1c0c](https://celoscan.io/tx/0xab592f83fe659607fff8c8892373c89bb396348028761fa8844c42f82a1d1c0c); mined: true; attribution verified by verifyTx: true (celo_b2fff2ac9413)
- _Note:_ order restricts fillers (PreferredFillerValidation): 1 preferred, exclusive until 2026-10-13T04:12:03.000Z
- _Note:_ reconciliation: sell balance change 1000000 vs logged 1000000; buy balance change 1365928991 vs logged 1365928991
- _Note:_ Textile order status: filled

### cNGN -> USDT via textile-fx-v2: CONFIRMED (CONFIRMED)

Plan `7f6a2512-00ff-4b84-a2b2-b41c2f0b3350`, 2026-10-14T00:58:30.475Z; requested 1363665000 atomic; received 998910 atomic.

- swap: [0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7](https://celoscan.io/tx/0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7); mined: true; attribution verified by verifyTx: true (celo_b2fff2ac9413)
- _Note:_ order restricts fillers (PreferredFillerValidation): 1 preferred, exclusive until 2026-10-14T00:59:46.000Z
- _Note:_ reconciliation: sell balance change 1363665000 vs logged 1363665000; buy balance change 998910 vs logged 998910
- _Note:_ Textile order status: filled

## Conversion attempts that were stopped (no swap was sent)

These are safety stops, kept for transparency; only the transactions listed under each (if any) were sent.

- USDT -> cNGN via textile-fx-v2: **FAILED** (QUOTE_INVALID), plan `1d93f12e-a882-4b18-84fa-b0c8d77d5148`, 2026-10-13T04:01:37.903Z
  - approve: [0xf862f1b78a64d0451c214d72efdf018baa41ebb58aac3c320f045f88df1c103b](https://celoscan.io/tx/0xf862f1b78a64d0451c214d72efdf018baa41ebb58aac3c320f045f88df1c103b); mined: true; attribution verified: true
- USDT -> cNGN via textile-fx-v2: **FAILED** (QUOTE_INVALID), plan `17cca772-f930-4769-b576-cd213a342d55`, 2026-10-13T04:06:58.836Z
- cNGN -> USDT via textile-fx-v2: **FAILED** (NEVER_SENT), plan `9e11ef02-663e-47d0-9a22-10165d0b13cb`, 2026-10-14T00:48:24.967Z
- cNGN -> USDT via textile-fx-v2: **FAILED** (APPROVAL_INEFFECTIVE), plan `e3f2c034-4aee-46f0-b684-b09388432eb3`, 2026-10-14T00:50:37.238Z
  - approve: [0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32](https://celoscan.io/tx/0x0e33a9e1a192eb93c090cee957d5745b17632576abfb51cb4cf1583163b2dd32); mined: true; attribution verified: true

## Notes

- Payment proof = the Transfer(payer -> payTo) in the settlement transaction, plus the independent on-chain authorization state.
- x402 settlements are submitted by the facilitator; attribution tags are not yet supported by x402 and the organizers confirmed none is needed for Buy.
- Transactions Payrail submits itself (approvals and swaps) carry the official ERC-8021 tag and are verified with Celo's verifyTx; see the swaps section.
- The automated test suite (npm test) uses mocks and fakes only. It sends nothing and is NOT evidence of on-chain activity; only the transactions in the ledger are real.
