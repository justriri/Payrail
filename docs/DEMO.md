# Demo walkthrough (about 5 minutes)

Everything below follows what actually works today. Steps marked **(spends)** move real funds and are optional: the same
result is already recorded on mainnet in [evidence/SUBMISSION-EVIDENCE.md](../evidence/SUBMISSION-EVIDENCE.md).

## Setup (once)
1. `npm install`, copy `.env.example` to `.env`, and put the GitHub OAuth values in `.env.local` ([docs/LOCAL-GITHUB-SETUP.md](LOCAL-GITHUB-SETUP.md)).
2. `npm run serve:local`, then open **`http://127.0.0.1:4402`** (not `localhost`).
3. Have a browser wallet with a little Celo USDT only if you want to try a purchase. Browsing and seller steps need no funds.

## Part 1: the buyer sees one marketplace (1 min)
1. **Landing page** (`/`): the five official Textile corridors on Celo, each marked *Live* only when Textile is quoting it right now.
   *Expected:* cNGN, wARS, wBRL, IDRX show Live; USDC shows Live with a thin-liquidity note, or "Temporarily unavailable" with the reason.
2. **Buyer, Explore APIs**: Buy catalog services and independent seller APIs side by side, each badged with where it comes from.
   *Expected:* about 170 Buy services plus any published seller listings, prices in USDT.
3. Open **payrail test api** (`View API`): price (and the seller's own currency, converted at a Textile rate), billing method,
   the response contract in plain words, the request box and **Pay and Use API**.
   *Expected:* "Outcome-based: charged only if the response meets the contract".

## Part 2: a seller goes from "deployed API" to "published API" (2 min)
Use the dedicated [test API](https://github.com/justriri/payrail-test-apipayrail-test-api) (free Render host: it may take up to a minute to wake).
1. **Seller, Create API**: name, endpoint `https://payrail-test-apipayrail-test-api.onrender.com/api/hello`, price (USDT or a supported local currency). Sign the wallet challenge.
   *Expected:* the listing appears under My APIs as **Draft** (an API that merely exists is not verified or published).
2. **Verify with GitHub**: connect GitHub, enter the repository, commit the proof file, press **Check now**.
   *Expected:* five checks (GitHub connected, repository write access, proof in repository, proof served by the deployed host,
   endpoint answers JSON). A sleeping host shows "did not answer in time ... NOT a failed proof" and the check waits and retries; all five must pass.
3. **Response contract**: suggest, propose, approve (status: "Contract approved: ready to publish"). **Test the API** for free: no buyer is charged.
4. **Publish**, then **View in the marketplace**.
   *Expected:* you land on that listing's own public page (`/api.html?id=…`), not the buyer overview. Unpublish and the same URL answers "not available".

## Part 3: pay in the currency you hold (1 min)
1. Open a Buy service, for example *Search X posts* (about 0.005 USDT), and sign in with the buyer wallet.
2. If the wallet holds less USDT than the price, the page lists the currencies you can convert from, each with its live status.
   Choosing one shows the estimate: source amount, rate, Textile fee, minimum USDT received, smallest swap, what remains after paying.
3. **(spends)** Approve: wallet signatures for the conversion (approve and swap), then the Buy payment. *Expected:* the receipt lists both
   transactions and the response is shown only after settlement is verified on-chain.

## Part 4: proof (1 min)
- `node scripts/history.ts` and `node scripts/evidence.ts --verify` list every payment, conversion and order and re-check them against Celo.
- The convert-then-pay example: order `90f8d4be-0388-467e-a5b0-4b630d0411d2` (1363.665 cNGN → 0.998910 USDT via Textile, then 0.005 USDT to Buy).
- Optional **(spends)** repeat from the command line: `node --env-file=<key file> scripts/order.ts --service x.posts.search --source cNGN` (plan first; add `--execute` only when you accept the plan).

## What this demo does not show
A live public deployment, a browser-wallet purchase on mainnet, or a seller payout (see Known limitations in the README).
