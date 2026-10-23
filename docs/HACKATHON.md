# Celo "Agents on Open Rails": requirements, fit and submission

Sources checked 2026-10-23: the official event page `https://www.loops.house/agents-on-open-rails` (fetched), the Loops CLI
(`loops events get`, `loops project fields --event agents-on-open-rails`, read-only) and the Luma kick-off page (no rules on it).
Anything not on those sources is marked **unconfirmed**.

## Official facts
- Submission and registration deadline: **Mon 9 Nov 2026, 09:00 GMT** (Loops: `2026-11-09T09:00:00Z`). Winners: Fri 13 Nov.
- Tracks and prizes ($5,000 total): **Stable Agents LatAm** (Ripio wFIAT) $1,500 + $500; **Open Corridors**: Textile FX $750 + $250 and
  USA₮ with x402 $750 + $250; **Build with buy** $1,000 across 5 projects. (Your earlier figures of $2,000 / $2,000 / $1,000 match these totals.)
- Multiple tracks may be entered; a team wins at most one prize per track. "If your project fits no track, enter the closest."
- Scoring: a published onchain query plus a human panel that reviews the repository. Only **Celo mainnet** counts.
- Code must be written during the hackathon (Payrail's first commit is 2026-10-13, after the 6 Oct start).

## Submission fields (Loops: required unless noted)
| Field | Status |
|---|---|
| Project name | you choose |
| Description (detailed write-up) | draft below |
| Repository URL (private allowed, judges get read access; the official page says it must resolve at judging) | https://github.com/justriri/Payrail once pushed |
| Screenshots (at least one) | real ones in `docs/screenshots/` (landing, marketplace, API detail) |
| **Demo URL (required): live demo or website** | **open, see below** |
| Agent wallet (public address) | `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4` (already on the Loops entry) |
| Logo, walkthrough video | optional |
| ERC-8004 identity from the agent wallet (required, every track) | done: agent 9906, tx `0xf654ea5f5286e0a53a1412a7769b48ef38742134d98bd0a7c6938089126cab1b` |
| Attribution tag in code that builds and sends transactions | done: `celo_b2fff2ac9413` (checked with `verifyTx` on the txs Payrail submits) |
| x402 payTo wallet | `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B` (the Buy gateway's receiving address; payer is the agent wallet) |
| Build with buy: services used and proof of payment | `evidence/SUBMISSION-EVIDENCE.md` (regenerate with `node scripts/evidence.ts --verify`) |
| Sponsored gas explanation | x402 settlement gas is paid by the gateway sponsor (`0x0d74D5Ce…FB48`); Payrail's own approve and swap txs paid gas from the agent wallet |

## Track fit (candid)
| Track | Fit | Why |
|---|---|---|
| **Build with buy** | **Best fit** | Payrail pays services it does not own (Buy) and adds the pay-in-your-currency step. Weakness: depth is judged on verified paid calls and independent users; there are 3 paid calls, all to one service from our own wallet, and no independent users |
| Open Corridors, Textile FX | Weak, optional | Judged on a quoting agent's P&L and volume. Payrail is a taker with one real fill (about 1 USDT) and one convert-then-pay order |
| Open Corridors, USA₮ with x402 | Weak | Every payment so far is USDT, not USA₮, and there are no independent counterparties |
| LatAm (Ripio wFIAT) | Not a fit today | No wFIAT (wARS, wBRL) has been executed on mainnet; cNGN is not a Ripio wFIAT (**unconfirmed** whether it qualifies) |

Recommendation: enter **Build with buy**; add **Textile FX** only if you accept a likely weak result. Do not add integrations to claim eligibility.

## Requirements checklist
| Requirement | Evidence | Implemented | Tested | To do |
|---|---|---|---|---|
| Celo mainnet transactions | evidence file, 10 txs | yes | on-chain re-check, 0 warnings | none |
| Attribution tag on tx Payrail sends | `src/attribution.ts`, `verifyTx` | yes | mainnet + unit | none |
| ERC-8004 identity + agent wallet on entry | agent 9906; Loops `hasIdentity: true` | yes | on-chain | none |
| Public GitHub repo resolves | https://github.com/justriri/Payrail | after push | n/a | confirm it opens logged out |
| x402 payTo wallet provided | table above | yes | n/a | paste into the entry |
| Build with buy: services and proof of payment | `x.posts.search`, 3 payments (0.015 USDT) | yes | mainnet | list in description |
| Real users / independent wallets | none | no | n/a | cannot be faked; state plainly |
| Demo URL | none hosted | **no** | n/a | you decide (below) |
| Loops project created and submitted | `exists: false` (read 2026-10-23) | no | n/a | you create it |

## Open items that need you
1. **Demo URL is required and Payrail has no hosted instance.** Options: (a) host a read-only instance yourself (deploying is your decision; I did not deploy anything);
   (b) use a public walkthrough video or the repository page as the "demo" link. Whether Loops accepts a non-live link is **unconfirmed**; ask the organizers or try the CLI validation.
2. Create the Loops project (draft first, review, submit before the deadline). Needs your login: `loops project create --event agents-on-open-rails ...`.
3. Optionally record a 2-3 minute video following `docs/DEMO.md` (no secrets on screen).
4. Back up the wallet key (`docs/WALLET-KEY-BACKUP.md`); not done as of the last checklist.
5. Decide whether to spend about 1 USDT for a second convert-then-pay data point or a browser-wallet purchase (more verified paid calls help Build with buy). Nothing is spent without your approval.
6. Confirm with organizers (unconfirmed): whether Loops credits the earlier tagged swaps (it shows the registration as "first tagged tx"), and whether a non-live demo URL is accepted.

## Draft description (accurate to what works)
**Payrail: pay for APIs with the stablecoin you already hold.**

Agents and people often hold cNGN, wBRL or another local-currency stablecoin while the service they want is priced in USDT. Payrail removes that
gap. It reads the service's real price from its x402 challenge, checks the wallet, and if needed converts with Textile FX (firm quote, one signed
order) before paying through the Buy gateway on Celo. Every step is bounded by spending limits, journaled before it is sent, verified on-chain
afterwards, and recorded with a response hash. An uncertain payment is never retried.

Payrail is also a marketplace beyond the Buy catalog: any seller can register an API, prove ownership (DNS, well-known file or GitHub repository
proof), store credentials in an encrypted vault, test for free, define a response contract and publish. Buyers are charged only when a response
satisfies the contract.

**Verified on Celo mainnet:** three x402 payments to Buy (`x.posts.search`, 0.005 USDT each), a convert-then-pay order (1363.665 cNGN → 0.998910 USDT via
Textile, then a 0.005 USDT x402 payment, response delivered and hashed), a Mento swap, a Textile swap and the ERC-8004 registration (agent 9906).
Transactions Payrail submits carry `celo_b2fff2ac9413`. The seller GitHub verification flow was run against real GitHub and a real hosted API.
**Not yet verified live:** a browser-wallet purchase on mainnet, seller payouts, and any currency other than cNGN as the conversion source.
Code, tests (685) and evidence are in the repository.
