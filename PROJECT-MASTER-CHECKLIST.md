# Payrail — Master Project Checklist

> **Last refreshed:** 2026-10-13, after re-running the checks below (not from memory).
> **Labels:** `[x]` verified complete · `[~]` implemented, not fully verified · `[ ]` not done · `[!]` blocked / needs an external answer.
> **Evidence levels:** **MOCK** = automated test with fakes only · **LIVE** = ran against a real service · **CHAIN** = confirmed on Celo mainnet by independent reads.
> **Deadline (from Loops' own API):** submission **Nov 9 2026, 09:00 UTC (Africa/Abidjan)**.

## Snapshot (re-checked today)

| Check | Result |
|---|---|
| `tsc` type check | exit 0 |
| Full test suite | **330 tests, 330 pass, 0 fail** (~80 s) |
| Evidence regeneration (`scripts/evidence.ts --verify`) | 10 transactions, 4 orders, 3 payments, 7 conversion records, **0 warnings, 1 unresolved** (attempt-2 order flagged "needs a human"; see B10) |
| Git | 2 local commits, 78 tracked files, **no remote**, working tree clean |
| Loops entry (`loops project get`) | tag `celo_b2fff2ac9413`, agent wallet `0x652C…D2a4`, **`hasIdentity: true`**, **project not yet created** |

---

## 1. Completed and verified work

| # | Item | Evidence |
|---|---|---|
| 1 | Config with the tag pinned (a different tag or chain is refused); wallet address derived from the key | MOCK; tag verified on 5 mainnet txs (CHAIN) |
| 2 | Wallet verified: `.env`, app-resolved address, order, receipt and on-chain payer all equal `0x652C9023626d1a00AD0d130C9cdc5C5f3644D2a4` | CHAIN (tx `0x57c3c046…57fe`) |
| 3 | Buy catalog + real-price discovery from the unpaid 402 | MOCK + LIVE |
| 4 | Spending policy and the single authorization gate | MOCK (structural test) |
| 5 | **Direct x402 payments, 2 real**: `0xfb012c51…17ac` (Oct 12), `0x57c3c046…57fe` (Oct 13) | CHAIN: settlement state + Transfer(payer→payTo) |
| 6 | Service delivery proof for payment 2: HTTP 200, response saved, SHA-256 recomputed and matches | independent recomputation |
| 7 | **Mento swap** USDm→USDT (approve `0xbe28a289…`, swap `0xa935302c…`) | CHAIN + `verifyTx` tag |
| 8 | **Textile swap** USDT→cNGN (approve `0xf862f1b7…`, swap `0xab592f83…`, 1,365.928991 cNGN) | CHAIN + `verifyTx` tag |
| 9 | **One live order** (direct) `b5660887-…`: plan → preflight → pay → verify → record | CHAIN; order, receipt, evidence agree |
| 10 | **ERC-8004 agent registered**: agent ID **9906**, tx `0xf654ea5f…cab1b`, block 80032609, owner = agent wallet, tag present | CHAIN; Loops shows `hasIdentity: true` |
| 11 | Order safeguards: preflight, order lock, plan-digest approval, daily swap cap, order-aware duplicate guard, journal-before-send | MOCK (incl. real multi-process tests) |
| 12 | Recovery code: `--reconcile`, `--resume`, swap re-verification, payment resolution | MOCK only (see §3) |
| 13 | **Chain-read reliability fix** (root cause + fix in §2) | MOCK (15 tests) + LIVE read-only (3 consecutive clean evidence runs) |
| 14 | Evidence pack: ledger of 7 real txs, order as one unit, cross-checks vs receipts and swap journals, response-hash recomputation | LIVE read-only |
| 15 | `README.md`, `docs/ARCHITECTURE.md`, `docs/WALLET-KEY-BACKUP.md`, `.env.example` | reviewed against the code |
| 16 | `scripts/check-key-file.ts`: verifies a key file/backup by printing only the public address | MOCK (throwaway keys) |
| 17 | Git set up safely: history stored **outside OneDrive** (`C:\Users\HP\payrail-git\payrail.git`) | see §4 |
| 18 | Loops CLI v0.6.0 installed and signed in; event skill present in `.agents/` and `.claude/` | on disk (both git-ignored) |
| 19 | **Web interface** (`npm run serve` / `serve:sim`): paste a URL, see price/rate/fees/max spend, choose the currency to pay with, approve, track progress, view the response; local-only server, per-run token, strict CSP, text-only rendering, approval bound to a terms digest + hard bounds | MOCK/simulated through the real HTTP API and the real planner/orchestrator (14 tests); LIVE read-only: real status, real service inspection, real Textile cNGN→USDT preview |
| 20 | **User-chosen funding currency** (`sourceSymbol`; UI and `order.ts --source`): the chosen currency is the only one used; no silent fallback | MOCK (planner + orchestrator tests); LIVE read-only plan with cNGN |
| 22 | **LIVE convert-then-pay order, verified on-chain (2026-10-14)**: order `90f8d4be-…`: sold 1,363.665 cNGN → 0.998910 USDT via Textile (swap tx `0x102eafff…acb7`, tagged, block 80038743), then paid 0.005 USDT (tx `0xf3652222…2c9c`, block 80038764); response delivered, SHA-256 recomputed and matches; balances reconcile to the atomic unit; remaining allowance 0 | CHAIN (independent reads, `verifyTx`, receipts) |
| 23 | Live-found defects fixed: OneDrive `EPERM` on journal rename (bounded retries, still throws), stale allowance read after a mined approval (read at the approval block), journals that never signed anything can now be closed (`NEVER_SENT`) | MOCK regression tests (7) + proven by the live run |
| 21 | Mento classifier: a reason-less router revert is "no route for this pair" (verified live: Mento has **no cNGN pool**; Textile is the only cNGN route) | LIVE read-only + MOCK |

---

## 2. Known bugs and remaining fixes

**Found by the live convert-then-pay attempts (2026-10-14) and fixed:** (a) journal saves use temp-file-then-rename, which OneDrive can block with `EPERM` (now retried with backoff; a save that cannot be done still stops the run); (b) the allowance read right after a *mined* approval hit a lagging RPC backend and returned 0, so the order stopped before requesting a quote (now read at the approval's block, with bounded re-reads; same for the pre-swap check and sequence building); (c) a journal that never signed anything could not be closed by the tool (now closed as `NEVER_SENT` only with chain corroboration).

**Fixed this round (with the cause, so it is not rediscovered):**

- **Intermittent "receipt not found" for old transactions — root cause established by repeated read-only probes.**
  `forno.celo.org` is a load balancer over mixed backends (two reth builds and a Geth). For older
  transactions the transaction lookup and block are always answered, but `eth_getTransactionReceipt`
  returns `null` on some backends (pruned receipts). In a 12-call probe, each of two old transactions' receipts was found only about half the time (6/12 and 7/12), while a recent one was found 12/12.
  Ankr and 1RPC answered every receipt; Stakely prunes the same way; DRPC and CeloColombia were unusable.
  It was **not** indexing delay or a lookup-logic bug. A single "not found" meant "that backend lacks it".
- **Fix (`src/chainread.ts`):** multi-endpoint lookup with bounded exponential backoff; receipts validated
  against the requested hash and the transaction's block; distinct outcomes `found`, `receipt_unavailable`,
  `not_found`, `conflict`, `insufficient_agreement`, `error`. Only `found` is evidence; everything else is
  inconclusive and can never be treated as failed or successful, or trigger a repeat payment. Payment
  execution itself was not changed; broadcasting still goes to the primary only.
- Earlier bugs fixed and covered by tests: conversion stamped CONFIRMED when the chain could not confirm it
  (stranded orders); OneDrive reparse points hiding swap journals; duplicate-payment hole; lagging-RPC
  reconciliation; order duplicate guard blocking every new order.

**Still open:**

| # | Item | Priority | Detail |
|---|---|---|---|
| B1 | Third-party RPC reliability | Medium | Fallbacks (Ankr, 1RPC) are public third-party endpoints with no guarantee. Evidence asks for 2 agreeing endpoints; consider your own provider/key for production. Override with `PAYRAIL_RPC_FALLBACK_URLS` |
| B2 | `scripts/register-agent.ts` and `scripts/rehearse.ts` use a single RPC client | Low | Not migrated to the resilient reads; registration worked, but its receipt wait is not retry-hardened |
| B3 | Planner balance reads use `@celo/buy-core`'s own reader | Low | Not covered by the fallback list |
| B4 | **Loops "first tagged tx" shows the registration** (`0xf654ea5f…`), not the earlier tagged approvals/swaps (blocks 79963003–79963880) | Medium | We do not know why or whether the earlier four are credited; check the Celo checklist on the Loops submit page and ask organizers |
| B5 | ~~No way to force the convert route~~ **Resolved**: the user can choose the funding currency (web page or `order.ts --source cNGN`) | — | Convert-then-pay can now be planned for a wallet that also holds USDT |
| B6 | OneDrive symlink regression test cannot run on this machine | Low | `EPERM` creating symlinks, so it exits early; the fix itself is verified only by the real journals now being read |
| B7 | Cosmetic: `scripts/register-agent.ts` line 32 comment says 0.05 CELO, value is 0.15 | Low | Wrong comment, correct value |
| B8 | Occasional unexplained failure in the multi-process lock test (seen once earlier) | Low | Hardened (diagnostics + Windows `EPERM` tolerance); did not recur in the last 4 full runs; cause unconfirmed |
| B9 | Mento paying for a *service* (`findRoute`) never run live | Low | Standalone Mento swap is verified; service-payment route is MOCK |
| B10 | Attempt-2 order `d9c24dc8-…` still shows "needs a human" in evidence | Low | Its approval tx was sent but no swap followed; that approval was later consumed by the successful order (allowance now 0). There is no acknowledgement mechanism; records were not edited. Needs a decision: add an additive acknowledgement note, or explain it in the submission |
| B11 | The web page's own approve button has been exercised via the API only, not clicked in a browser by us | Medium | Drive it once in your browser (`node --env-file=<key file> scripts/serve.ts`) |
| B12 | Standing cost of the test: ≈0.056 CELO gas total (0.373 → 0.317 CELO) | Info | Approval ≈0.0114 + swap ≈0.0450; x402 gas is paid by the gateway |

---

## 3. Untested flows (kept visible; **not** run automatically)

All three remain **unverified against real orders**. Existing evidence does not prove them.

| Flow | Status | What a safe test needs |
|---|---|---|
| **Live convert-then-pay order** | `[x]` **VERIFIED ON-CHAIN 2026-10-14** (order `90f8d4be-…`, see item 22). It took three attempts: attempts 1 and 2 stopped safely (OneDrive rename `EPERM`; stale allowance read) with nothing swapped or paid and only an approval's gas (≈0.011 CELO) spent. Direction cNGN→USDT is now proven; the Mento route for paying a service is still not | Done. Repeat only if you want a second data point |
| **`--reconcile` / `--resume` on a real interrupted order** | `[~]` MOCK only. Only a read-only `--reconcile` on the *completed* order was run (it reported "already COMPLETED" and changed nothing) | A genuinely interrupted order cannot be created on demand without spending. The realistic route is to run the convert-then-pay test above and stop it (Ctrl+C) right after the conversion confirms, then run `--reconcile` and `--resume`. Needs your approval and careful timing |
| **Payment resolution for a real uncertain payment** | `[~]` MOCK only | Needs a real `UNCERTAIN` receipt. None exists, and one should not be created deliberately. `resolve.ts --payment` will be exercised only if a genuine uncertain payment ever occurs; state this limitation honestly in the submission |

Also mock-only: quote-cancel endpoint, Textile reverse corridor (cNGN→USDT), daily-cap and limit *refusals* against a live gateway.

---

## 4. Security and Git-publishing checks

| Check | Result |
|---|---|
| Sensitive files tracked by Git | **None.** `git ls-files` contains no `.env`, key/PEM files, credentials, `receipts/`, `.claude/`, `.agents/` or `.loops` paths (only `.env.example`) |
| Secrets inside tracked files | Every 64-hex string in the staged files was converted to an address and compared with the wallet: **0 matches** (so the key is not in them). Only fake test fixtures matched text patterns |
| Key copies anywhere in the project folder (incl. ignored folders) | **0** |
| Key file location and permissions | `C:\Users\HP\.payrail\rehearsal.env`: outside the project and OneDrive; Windows ACL gives only your account access |
| `.gitignore` | Written before staging; excludes `.env`, `*.env`, key/keystore files, `.payrail/`, `.loops/`, `credentials.json`, `receipts/`, tool folders |
| Remotes / publishing | **No remote; nothing pushed or published** |
| Git history location | Outside OneDrive; `.git` in the project is only a pointer file |
| Backup of the key | `[ ]` **Not done by you yet** — see `docs/WALLET-KEY-BACKUP.md` and `scripts/check-key-file.ts` |

**Before any push (not done):**
- Decide public vs private repository. Commits are authored with your configured name and email
  (`justriri`, your Gmail address), which will be visible in history.
- `evidence/` contains public addresses and transaction hashes (public data) and **no** response bodies.
- `receipts/` (including saved third-party response bodies) is intentionally untracked.
- Review `README.md` and docs once more for anything you do not want public.
- Note: the repo history and the Loops skill files (`.agents`, `.claude`) are intentionally not published.

---

## 5. Documentation and evidence still required

| Item | Status | Notes |
|---|---|---|
| `README.md`, `docs/ARCHITECTURE.md`, `docs/WALLET-KEY-BACKUP.md` | `[x]` | Written from the code; limitations stated |
| `evidence/SUBMISSION-EVIDENCE.md` + `evidence.json` | `[x]` current | Regenerate after any new live activity |
| Known limitation to state: payment #1 has no saved response body | `[x]` stated in evidence | Only a structural summary (57,656 bytes) exists |
| Repo URL for the submission | `[ ]` | No remote exists; needs your decision |
| Demo (video/screens/live walkthrough) and a plain-language pitch for a named user | `[ ]` | Required by the judging criteria (see §6) |
| Evidence of real users / counterparties | `[ ]` | Criteria reward it; none exists |
| Local-currency / non-crypto-friendly interface | `[~]` | Local web page exists (item 19); amounts are still shown in token units, not local-currency units |
| Refresh this checklist after each milestone | `[ ]` | |

---

## 6. Hackathon submission requirements

### From Loops' own event data (the installed event skill + `loops` API)
- Event `agents-on-open-rails`, stage `registration_open`, started Oct 6 2026, **submission deadline Nov 9 2026 09:00 UTC**.
- Scored on **Celo mainnet**; a transaction counts only if its calldata carries the entry's assigned tag. Ours matches: `celo_b2fff2ac9413`.
- **Required for a complete entry:** agent wallet (`[x]` set: `0x652C…D2a4`), ERC-8004 identity (`[x]` done, `hasIdentity: true`), a submitted project (`[ ]` none created).
- A submission is drafted first and only written after an explicit "yes"; `loops project create` needs a name, tagline and repo URL (see §5).

### Tracks you named
| Track | Prize | Fit | Open question |
|---|---|---|---|
| **Build with buy** | 5 × $200 | **Good**: depth (35%) rewards verified paid calls from the tagged wallet; we have 2 | Need a named user/task (40%) and demand evidence (25%) |
| **Open Corridors: USA₮ with x402** | $750 / $250 | Possible with gaps: every payment so far was USDT, not USA₮ | Does Buy's settlement count as "Celo's x402 facilitator"? How is it verified by tag if x402 is untagged? How is a *buyer* scored on "repeat counterparty"? |
| **Open Corridors: Textile FX** | $750 / $250 | **Poor**: rewards a *quoting* agent's P&L; Payrail is a taker | Different product; not recommended |
| LatAm (Ripio wFIAT) | $1,500 / $500 | You said not this track | Would need real wFIAT movement |

**You have not yet chosen the Open Corridors subtrack.**

### Still needs confirmation from organizers `[!]`
- Which wallet "the developer" wants: you said **agent wallet** (`0x652C…D2a4`); not confirmed in writing.
- How and when payment transaction hashes must be submitted; the "next-stage forms" and deadlines.
- Why Loops' first-tagged-tx shows the registration rather than the earlier four tagged transactions (B4).
- Whether entering two tracks is allowed (the CLI accepts several bounty IDs; the rule is not stated).
- USA₮/x402 interpretation questions above.
- Whether a conversion is required for Build with buy, or the two paid x402 calls suffice.

---

## 7. Recommended order of work

1. `[ ]` **Make and verify the wallet-key backup** (you). Criterion: `check-key-file.ts` prints `[PASS]` for the backup.
2. `[!]` **Send the organizers one message** with the open questions in §6 (wallet type, hash submission, forms, B4, multi-track, USA₮/x402). Criterion: written answers recorded here.
3. `[ ]` **Check the Celo checklist on the Loops submit page** and note what it shows for first-tagged-tx (B4).
4. `[ ]` **Choose the Open Corridors subtrack** (or drop it) and name the user/task for Build with buy.
5. `[ ]` **Decide repo visibility**, add a remote yourself, review the staged content, then publish.
6. `[~]` **Convert-then-pay live test** (§3) after B5 is implemented and you approve the bounded command.
7. `[ ]` **Demo + pitch + (optional) simple interface**, then `loops project create` as a draft, review it with `loops evaluate`, and submit only after your explicit yes.
8. `[ ]` Re-run `npm run check` and `node scripts/evidence.ts --verify`; refresh this file; submit before **Nov 9 09:00 UTC**.

### "Ready to submit" means
1. Agent wallet and ERC-8004 identity are on the entry (`[x]` today) and a project is submitted with an approved draft.
2. The organizers' written instructions are recorded and followed.
3. Evidence is regenerated with 0 warnings and 0 unresolved, and lists the services used and proof of payments.
4. `npm run check` passes and results are stated honestly (mock vs live vs on-chain).
5. Any claim about convert-then-pay, recovery or payment resolution is backed by a live on-chain run, or the submission says plainly that those paths are mock-tested.
6. A repo URL, demo and named user exist; no secrets are published.
