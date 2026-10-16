# Payrail agent API

> **Historical document.** It describes development modes (test credits, simulation, testnet escrow) that are not part of the production product. See [PRODUCTION.md](PRODUCTION.md) for what is real today.


Let an AI agent or script discover APIs, inspect their terms, buy one request at a time, and receive a receipt. The agent
is **charged only for responses that meet the seller-approved contract**.

> Status: **test credits** (asset `TESTUSDT`). Real-funds mode is off. Verified locally with automated tests and in the
> browser; not verified against a live chain. See [MARKETPLACE.md](MARKETPLACE.md) for what is and is not verified.

## 1. Get an agent key

A buyer account owner creates a key in the marketplace page (Buyer tab, "AI agent access") with:

* a **per-request cap**, a **rolling 24-hour cap**, and optionally an **allow-list** of listing ids.

The key (`pra_…`) is shown **once**. Only its hash is stored. An agent cannot create keys, change limits, read the
owner's other history, or use any buyer/seller screen. Revoke it any time from the same page.

All requests: `Authorization: Bearer pra_…`. Base path: `/api/market` (default `http://127.0.0.1:4402`).

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/agent/spec` | This API, machine-readable (no key needed) |
| GET | `/agent/me` | Your limits, rolling 24h usage, owner credits |
| GET | `/agent/catalog` | Available APIs: description, price, fee, response requirements, freshness, availability |
| GET | `/agent/listing/{id}` | Inspect one API before buying |
| POST | `/agent/execute` | Run one request (idempotent) |
| GET | `/agent/receipt/{receiptId}` | Receipt for one of **your** requests |
| GET | `/agent/executions` | Your recent requests |

## 3. Example (curl)

```bash
BASE=http://127.0.0.1:4402/api/market
KEY=pra_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# discover
curl -s $BASE/agent/catalog -H "Authorization: Bearer $KEY"

# inspect one listing: price, fee, what a qualifying response is
curl -s $BASE/agent/listing/lst_demo_1234 -H "Authorization: Bearer $KEY"

# buy one request. Reuse the SAME idempotencyKey when retrying.
curl -s -X POST $BASE/agent/execute \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"listingId":"lst_demo_1234","idempotencyKey":"job-42-step-1","input":{"id":"eth"}}'
```

## 4. Example (Node 20+)

```js
const BASE = 'http://127.0.0.1:4402/api/market';
const KEY = process.env.PAYRAIL_AGENT_KEY;
const call = (path, body) => fetch(BASE + path, {
  method: body ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

const { items } = await call('/agent/catalog');
const api = items.find((i) => i.forThisAgent.canExecute && i.name.includes('price'));
const res = await call('/agent/execute', { listingId: api.id, idempotencyKey: 'job-42-step-1', input: { id: 'eth' } });
if (res.outcome === 'QUALIFIED') console.log(res.result.body);          // charged
else if (res.outcome === 'UNRESOLVED') console.log('unknown; not charged; poll the receipt', res.result.executionId);
else console.log('not charged:', res.result.reason);
```

## 5. Example (Python)

```python
import os, requests
BASE = "http://127.0.0.1:4402/api/market"
H = {"Authorization": f"Bearer {os.environ['PAYRAIL_AGENT_KEY']}"}
r = requests.post(f"{BASE}/agent/execute", headers=H,
                  json={"listingId": "lst_demo_1234", "idempotencyKey": "job-42-step-1", "input": {"id": "eth"}}).json()
print(r["outcome"], r["charged"], r["receipt"]["receiptId"])
```

## 6. Reading the result

`POST /agent/execute` returns HTTP 201 (new) or 200 (replay of the same key):

```json
{
  "ok": true,
  "outcome": "QUALIFIED",
  "charged": true,
  "result": { "executionId": "...", "state": "QUALIFIED", "body": { "...": "seller response" }, "checks": [ ... ] },
  "receipt": { "receiptId": "...", "charged": {"atomic":"20000","display":"0.02"}, "platformFee": {...}, "sellerEarned": {...},
               "ledger": [ {"kind":"hold"}, {"kind":"capture"} ], "settlement": "ledger", "validation": { "kind": "structural", "checks": [...] } },
  "advice": "Charged. Use result.body."
}
```

| `outcome` | Meaning | What to do |
|---|---|---|
| `QUALIFIED` | Met the contract; charged. `result.body` is present | Use it |
| `NOT_QUALIFIED` | Failed validation, or never sent; **not charged**; `result.reason` says why; no body returned | Retry with a **new** idempotency key if appropriate |
| `UNRESOLVED` | Outcome unknown (timeout, lost connection); amount **held, not charged** | Do **not** use a new key. Poll `/agent/receipt/{id}`; it is released to the owner if it stays unresolved |
| `RELEASED_UNRESOLVED` | Unknown outcome expired; released; not charged | Nothing owed |
| `IN_PROGRESS` | Still running | Repeat the call with the **same** key to read the stored outcome |

**Validation is structural.** A qualifying response matched the agreed structure, field types and freshness. It does not
prove the data is true. Treat the content as you would any third-party API.

## 7. Errors

Failures return `{ "ok": false, "code": "...", "message": "...", "retryable": bool, "hint": "..." }`.

| code | HTTP | Meaning |
|---|---|---|
| `KEY_INVALID` | 401 | Missing, malformed or revoked key |
| `INSUFFICIENT_CREDITS` | 402 | Owner has fewer credits than the price |
| `BAD_INPUT` | 400 | Invalid input or idempotency key (8–50 chars of `A-Za-z0-9_.:-`) |
| `NOT_FOUND` | 404 | Unknown listing or receipt |
| `LISTING_NOT_PUBLISHED` | 409 | The API is not currently available |
| `CONTRACT_NOT_APPROVED` | 409 | No approved response contract |
| `LISTING_NOT_ALLOWED` | 403 | Outside this key's allow-list |
| `PER_REQUEST_CAP` | 403 | Price exceeds the per-request limit |
| `DAILY_CAP` | 403 | Rolling 24-hour limit reached |
| `IDEMPOTENCY_CONFLICT` | 409 | Key already used for a **different** request |
| `RATE_LIMITED` | 429 | Too many calls to this API; retry shortly |

## 8. Idempotency

`idempotencyKey` identifies one logical purchase. Repeating it with the same input returns the stored outcome and receipt
and never calls the seller or charges again. Using it with different input is rejected (`IDEMPOTENCY_CONFLICT`).

## 9. Privacy and limits of access

An agent can read only its own limits, the public catalog, and receipts of requests made with **its own key**. It cannot
see other buyers, their balances, history or receipts, seller credentials, or seller endpoints.
