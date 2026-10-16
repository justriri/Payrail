# Textile route matrix (Celo mainnet, chain 42220)

Generated 2026-10-16T16:50:39.693Z by `scripts/route-matrix.ts`. **Read-only**: public ladder (as of 2026-10-16T16:50:31.324Z) and indicative previews. No firm quote was requested, nothing was signed, nothing was executed.

Evidence levels: **live-executed** = our own code executed it on mainnet (tx shown); **live-quoted** = the provider ladder showed makers when read (indicative, not current liquidity, not executed); **documented** = listed in the address book; **simulated** = only our simulation offers it.

A route in one direction says nothing about the other. USDT address: 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e. Chain: 42220.

| direction | route | asset contract (Celo 42220) | dec | status when read | ladder min .. max | indicative preview | in address book | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| funding | cNGN -> USDT | 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f | 6 | makers quoting | 1358.303 .. 43155126.941722 cNGN | 4074.909 cNGN -> 2.992994 USDT (fee 0.40745) | yes | live-executed (0x102eafff) |
| funding | wARS -> USDT | 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D | 18 | makers quoting | 1616.415 .. 49356469.885183810030199751 wARS | 4849.245 wARS -> 2.999976 USDT (fee 0.484876012398760123) | yes | live-quoted |
| funding | wBRL -> USDT | 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0 | 18 | makers quoting | 5.083 .. 149327.14403964924182716 wBRL | 15.249 wBRL -> 2.9991 USDT (fee 0.001524747525247475) | yes | live-quoted |
| funding | USDC -> USDT | 0xcebA9300f2b948710d2653dD7B07f33A8B32118C | 6 | makers quoting | 0.998991 .. 2534.17869 USDC | 2.996973 USDC -> 2.9994 USDT (fee 0.000299) | yes | live-quoted |
| funding | CELO -> USDT | 0x471EcE3750Da237f93B8E339c536989b8978a438 | 18 | makers quoting | 1.170823088631 .. 341502.305186078579624667 CELO | 3.512469265893 CELO -> 0.29982 USDT (fee 0.000351211805408759) | no | live-quoted |
| funding | USAT -> USDT | 0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771 | 6 | makers quoting | 1.00005 .. 29169.170286 USAT | 3.00015 USAT -> 2.998201 USDT (fee 0.000299) | no | live-quoted |
| funding | IDRX -> USDT | 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22 | 2 | makers quoting | 17941 .. 10550460121.63 IDRX | 53823 IDRX -> 2.999094 USDT (fee 5.38) | yes | live-quoted |
| funding | wCOP -> USDT | 0x8a1D45e102e886510e891d2Ec656a708991e2D76 | 18 | makers quoting | 3169 .. 93066458.064181133480183381 wCOP | 9507 wCOP -> 2.999101 USDT (fee 0.950604939506049395) | no | live-quoted |
| funding | WETH -> USDT | 0xD221812de1BD094f35587EE8E174B07B6167D9Af | 18 | makers quoting | 0.000410939202 .. 1.043069505489547278 WETH | 0.001232817606 WETH -> 2.997974 USDT (fee 0.000000123269433656) | no | live-quoted |
| funding | wMXN -> USDT | 0x337E7456B420bD3481e7FA61fA9850343d610d34 | 18 | makers quoting | 18.453 .. 4245.205205715025247973 wMXN | 55.359 wMXN -> 2.9991 USDT (fee 0.005535346465353464) | no | live-quoted |
| payout | USDT -> cNGN | 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f | 6 | makers quoting | 1 .. 4944.960094 USDT | 3 USDT -> 4084.315482 cNGN (fee 0.000299) | yes | live-executed (0xab592f83) |
| payout | USDT -> wARS | 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D | 18 | makers quoting | 1 .. 45.076861 USDT | 3 USDT -> 4847.049940585201479174 wARS (fee 0.000000000000000299) | yes | live-quoted |
| payout | USDT -> wBRL | 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0 | 18 | makers quoting | 1 .. 71389.772367 USDT | 3 USDT -> 15.239860267237569447 wBRL (fee 0.000000000000000299) | yes | live-quoted |
| payout | USDT -> USDC | 0xcebA9300f2b948710d2653dD7B07f33A8B32118C | 6 | makers quoting | 1 .. 1001.522071 USDT | no quote: no quote: no_makers_online | yes | live-quoted |
| payout | USDT -> CELO | 0x471EcE3750Da237f93B8E339c536989b8978a438 | 18 | makers quoting | 0.1 .. 32.882475 USDT | 0.3 USDT -> 3.51037453992825622 CELO (fee 0.000000000000000029) | no | live-quoted |
| payout | USDT -> USAT | 0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771 | 6 | makers quoting | 1 .. 701.091062 USDT | 3 USDT -> 2.998351 USAT (fee 0.000299) | no | live-quoted |
| payout | USDT -> IDRX | 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22 | 2 | makers quoting | 1 .. 153789.538854 USDT | 3 USDT -> 53790.85 IDRX (fee 2.99) | yes | live-quoted |
| payout | USDT -> wCOP | 0x8a1D45e102e886510e891d2Ec656a708991e2D76 | 18 | makers quoting | 1 .. 5067.015239 USDT | 3 USDT -> 9501.293888475365440349 wCOP (fee 0.000000000000000299) | no | live-quoted |
| payout | USDT -> WETH | 0xD221812de1BD094f35587EE8E174B07B6167D9Af | 18 | makers quoting | 1 .. 40.976864 USDT | 3 USDT -> 0.001232882339956059 WETH (fee 0.000000000000000299) | no | live-quoted |
| payout | USDT -> wMXN | 0x337E7456B420bD3481e7FA61fA9850343d610d34 | 18 | unavailable (no_levels) | - | n/a | no | live-quoted |

The ladder also lists tokens that are not in the Payrail asset registry (for example CELO, WETH, wCOP, wMXN, G$ when present); they are deliberately not offered here because this server cannot name or size them.

Not executable from this server today: live funding and live payouts are not wired (they need buyer-wallet signing and a bounded custody signer). CWT does not appear on any ladder and is not offered.
