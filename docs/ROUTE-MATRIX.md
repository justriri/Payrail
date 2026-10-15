# Textile route matrix (Celo mainnet, chain 42220)

Generated 2026-10-15T13:24:40.275Z by `scripts/route-matrix.ts`. **Read-only**: public ladder (as of 2026-10-15T13:24:02.719Z) and indicative previews. No firm quote was requested, nothing was signed, nothing was executed.

Evidence levels: **live-executed** = our own code executed it on mainnet (tx shown); **live-quoted** = the provider ladder showed makers when read (indicative, not current liquidity, not executed); **documented** = listed in the address book; **simulated** = only our simulation offers it.

A route in one direction says nothing about the other. USDT address: 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e. Chain: 42220.

| direction | route | asset contract (Celo 42220) | dec | status when read | ladder min .. max | indicative preview | in address book | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| funding | cNGN -> USDT | 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f | 6 | makers quoting | 1360.583 .. 110103944.06479 cNGN | 4081.749 cNGN -> 2.993532 USDT (fee 0.408134) | yes | live-executed (0x102eafff) |
| funding | wARS -> USDT | 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D | 18 | makers quoting | 1610.62 .. 128273679.864094335977789684 wARS | 4831.86 wARS -> 2.9994 USDT (fee 0.483137686231376862) | yes | live-quoted |
| funding | wBRL -> USDT | 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0 | 18 | makers quoting | 5.0614 .. 397316.844288743087995276 wBRL | 15.1842 wBRL -> 2.9991 USDT (fee 0.001518268173182681) | yes | live-quoted |
| funding | USDC -> USDT | 0xcebA9300f2b948710d2653dD7B07f33A8B32118C | 6 | makers quoting | 0.998941 .. 2466.408347 USDC | 2.996823 USDC -> 2.9994 USDT (fee 0.000299) | yes | live-quoted |
| funding | USAT -> USDT | 0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771 | 6 | makers quoting | 1.00005 .. 103276.417468 USAT | 3.00015 USAT -> 2.999401 USDT (fee 0.000299) | no | live-quoted |
| funding | IDRX -> USDT | 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22 | 2 | makers quoting | 17927 .. 13447143475.2 IDRX | 53781 IDRX -> 2.999174 USDT (fee 5.37) | yes | live-quoted |
| payout | USDT -> cNGN | 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f | 6 | makers quoting | 1 .. 3540.617141 USDT | 3 USDT -> 4090.43071 cNGN (fee 0.000299) | yes | live-executed (0xab592f83) |
| payout | USDT -> wARS | 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D | 18 | makers quoting | 1 .. 434.929391 USDT | 3 USDT -> 4830.895366870604453563 wARS (fee 0.000000000000000299) | yes | live-quoted |
| payout | USDT -> wBRL | 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0 | 18 | makers quoting | 1 .. 89417.321019 USDT | 3 USDT -> 15.175099069506255903 wBRL (fee 0.000000000000000299) | yes | live-quoted |
| payout | USDT -> USDC | 0xcebA9300f2b948710d2653dD7B07f33A8B32118C | 6 | makers quoting | 1 .. 1001.582102 USDT | 3 USDT -> 2.996494 USDC (fee 0.000299) | yes | live-quoted |
| payout | USDT -> USAT | 0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771 | 6 | makers quoting | 1 .. 5703.081404 USDT | 3 USDT -> 2.999551 USAT (fee 0.000299) | no | live-quoted |
| payout | USDT -> IDRX | 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22 | 2 | makers quoting | 1 .. 1.13429 USDT | 1 USDT -> 17922.36 IDRX (fee 0.99) | yes | live-quoted |

The ladder also lists tokens that are not in the Payrail asset registry (for example CELO, WETH, wCOP, wMXN, G$ when present); they are deliberately not offered here because this server cannot name or size them.

Not executable from this server today: live funding and live payouts are not wired (they need buyer-wallet signing and a bounded custody signer). CWT does not appear on any ladder and is not offered.
