// AI-agent access. An agent is a separate credential that spends from its owner's balance inside hard limits:
// a per-request cap, a rolling 24-hour cap, and an optional allow-list of listings. The key is shown once and only
// its hash is stored. Agents cannot create keys, change limits, move funds, or touch seller functions.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { executeRequest } from './execute.ts';
import type { ExecuteOptions, ExecutionResult } from './execute.ts';
import type { MasterKey } from './vault.ts';

export class AgentError extends Error {
  code: 'BAD_INPUT' | 'NOT_FOUND' | 'NOT_OWNER' | 'KEY_INVALID' | 'LISTING_NOT_ALLOWED' | 'PER_REQUEST_CAP' | 'DAILY_CAP';
  constructor(code: AgentError['code'], message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  perRequestCapAtomic: bigint;
  dailyCapAtomic: bigint;
  allowedListings: string[] | null;
  status: 'active' | 'revoked';
  createdAt: string;
}
const toAgent = (r: Record<string, unknown>): Agent => ({
  id: String(r.id),
  ownerId: String(r.owner_id),
  name: String(r.name),
  perRequestCapAtomic: BigInt(r.per_request_cap as bigint),
  dailyCapAtomic: BigInt(r.daily_cap as bigint),
  allowedListings: r.allowed_listings === null ? null : (JSON.parse(String(r.allowed_listings)) as string[]),
  status: r.status as Agent['status'],
  createdAt: String(r.created_at),
});
const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

export function createAgent(
  db: Db,
  ownerId: string,
  a: { name: string; perRequestCapAtomic: bigint; dailyCapAtomic: bigint; allowedListings?: string[] },
  now: () => number = Date.now,
): { agent: Agent; key: string } {
  const owner = queryOne(db, 'SELECT kind FROM accounts WHERE id = ?', ownerId);
  if (!owner || owner.kind !== 'buyer') throw new AgentError('NOT_FOUND', 'agents belong to buyer accounts');
  const name = a.name.trim();
  if (name.length < 2 || name.length > 60) throw new AgentError('BAD_INPUT', 'name must be 2-60 characters');
  if (a.perRequestCapAtomic <= 0n || a.dailyCapAtomic <= 0n) throw new AgentError('BAD_INPUT', 'caps must be positive');
  if (a.perRequestCapAtomic > a.dailyCapAtomic) throw new AgentError('BAD_INPUT', 'the per-request cap cannot exceed the daily cap');
  if (a.allowedListings && (a.allowedListings.length > 50 || a.allowedListings.some((x) => !/^[\w-]{1,80}$/.test(x)))) throw new AgentError('BAD_INPUT', 'invalid allowedListings');
  const id = `agent_${randomUUID()}`;
  const key = `pra_${randomBytes(32).toString('base64url')}`;
  db.prepare(
    "INSERT INTO agents (id, owner_id, name, key_hash, per_request_cap, daily_cap, allowed_listings, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
  ).run(id, ownerId, name, hashKey(key), a.perRequestCapAtomic, a.dailyCapAtomic, a.allowedListings ? JSON.stringify(a.allowedListings) : null, new Date(now()).toISOString());
  audit(db, ownerId, 'agent.created', id, { name }, new Date(now()));
  return { agent: toAgent(queryOne(db, 'SELECT * FROM agents WHERE id = ?', id)!), key };
}

export function authenticateAgent(db: Db, key: string): Agent {
  if (!/^pra_[A-Za-z0-9_-]{40,60}$/.test(key)) throw new AgentError('KEY_INVALID', 'invalid agent key');
  const r = queryOne(db, "SELECT * FROM agents WHERE key_hash = ? AND status = 'active'", hashKey(key));
  if (!r) throw new AgentError('KEY_INVALID', 'invalid or revoked agent key');
  return toAgent(r);
}

export function listAgents(db: Db, ownerId: string, now: () => number = Date.now): Array<Agent & { spentLast24hAtomic: bigint }> {
  return query(db, 'SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at', ownerId).map((r) => {
    const a = toAgent(r);
    return { ...a, spentLast24hAtomic: spentSince(db, a.id, now() - 86_400_000) };
  });
}

export function revokeAgent(db: Db, ownerId: string, agentId: string, now: () => number = Date.now): Agent {
  const r = queryOne(db, 'SELECT * FROM agents WHERE id = ?', agentId);
  if (!r) throw new AgentError('NOT_FOUND', 'no such agent');
  if (String(r.owner_id) !== ownerId) throw new AgentError('NOT_OWNER', 'not your agent');
  db.prepare("UPDATE agents SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").run(new Date(now()).toISOString(), agentId);
  audit(db, ownerId, 'agent.revoked', agentId, undefined, new Date(now()));
  return toAgent(queryOne(db, 'SELECT * FROM agents WHERE id = ?', agentId)!);
}

/** Money this agent has committed since `sinceMs`: held, unresolved and captured executions (released ones cost nothing). */
function spentSince(db: Db, agentId: string, sinceMs: number): bigint {
  const r = queryOne<{ s: bigint | null }>(
    db,
    "SELECT SUM(price_atomic) AS s FROM executions WHERE agent_id = ? AND state IN ('HELD','UNRESOLVED','QUALIFIED') AND created_at >= ?",
    agentId,
    new Date(sinceMs).toISOString(),
  );
  return BigInt(r?.s ?? 0n);
}

/** Run one request as an agent. The caps are checked in the same synchronous step that creates the hold. */
export async function executeAsAgent(
  db: Db,
  keys: readonly MasterKey[],
  agent: Agent,
  a: { listingId: string; idempotencyKey: string; input: unknown },
  opts: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const now = opts.now ?? Date.now;
  if (!/^[A-Za-z0-9_.:-]{8,50}$/.test(a.idempotencyKey)) throw new AgentError('BAD_INPUT', 'idempotencyKey must be 8-50 characters (letters, digits, _ . : -)');
  const key = `${agent.id}:${a.idempotencyKey}`;
  const l = queryOne(db, 'SELECT price_atomic FROM listings WHERE id = ?', a.listingId);
  if (!l) throw new AgentError('NOT_FOUND', 'no such listing');
  const prior = queryOne(db, 'SELECT id FROM executions WHERE buyer_id = ? AND idempotency_key = ?', agent.ownerId, key);
  if (!prior) {
    const price = BigInt(l.price_atomic as bigint);
    if (agent.allowedListings && !agent.allowedListings.includes(a.listingId)) throw new AgentError('LISTING_NOT_ALLOWED', 'this agent may not use that listing');
    if (price > agent.perRequestCapAtomic) throw new AgentError('PER_REQUEST_CAP', `price ${price} exceeds this agent's per-request cap ${agent.perRequestCapAtomic}`);
    if (spentSince(db, agent.id, now() - 86_400_000) + price > agent.dailyCapAtomic) throw new AgentError('DAILY_CAP', "this request would exceed the agent's 24-hour cap");
  }
  return executeRequest(db, keys, { buyerId: agent.ownerId, listingId: a.listingId, idempotencyKey: key, input: a.input, agentId: agent.id }, opts);
}
