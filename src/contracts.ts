// Response contracts: the written definition of what a *qualifying* response is. Buyers are charged only when a
// response satisfies the contract version their request was pinned to. Versions are immutable; a change is a new version.
import { createHash, randomUUID } from 'node:crypto';
import { audit, inTransaction, query, queryOne } from './db.ts';
import type { Db } from './db.ts';

export class ContractError extends Error {
  code: 'BAD_CONTRACT' | 'NOT_FOUND' | 'NOT_OWNER' | 'INVALID_TRANSITION' | 'LISTING_NOT_VERIFIED';
  constructor(code: ContractError['code'], message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export interface FieldRule {
  /** dotted path into the JSON body, e.g. "data.price" */
  path: string;
  type: FieldType;
  min?: number;
  max?: number;
}
export interface FreshnessRule {
  path: string;
  maxAgeSeconds: number;
  format: 'iso' | 'unix' | 'unix_ms';
}
export interface ContractBody {
  schema: 1;
  success: {
    statuses: number[];
    contentType: 'application/json';
    maxLatencyMs: number;
    fields: FieldRule[];
    nonEmpty?: string[];
    freshness?: FreshnessRule;
  };
}

const TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
const PATH = /^[A-Za-z_][A-Za-z0-9_]{0,40}(\.[A-Za-z0-9_]{1,40}){0,5}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function bad(m: string): never {
  throw new ContractError('BAD_CONTRACT', m);
}
function checkPath(p: unknown, what: string): string {
  if (typeof p !== 'string' || !PATH.test(p) || p.split('.').some((s) => FORBIDDEN.has(s))) bad(`${what}: invalid path`);
  return p as string;
}

/** Validate and normalise an untrusted contract body (strict: unknown keys are rejected). */
export function parseContractBody(raw: unknown): ContractBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('contract must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['schema', 'success'].includes(k)) bad(`unknown key "${k}"`);
  if (o.schema !== 1) bad('schema must be 1');
  const s = o.success as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') bad('success is required');
  for (const k of Object.keys(s)) if (!['statuses', 'contentType', 'maxLatencyMs', 'fields', 'nonEmpty', 'freshness'].includes(k)) bad(`unknown key "success.${k}"`);
  const statuses = s.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.length > 10 || !statuses.every((x) => Number.isInteger(x) && x >= 200 && x <= 299)) bad('statuses must be 1-10 success codes (200-299)');
  if (s.contentType !== 'application/json') bad('contentType must be application/json');
  const lat = s.maxLatencyMs;
  if (!Number.isInteger(lat) || (lat as number) < 100 || (lat as number) > 30_000) bad('maxLatencyMs must be 100-30000');
  const fieldsRaw = s.fields;
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0 || fieldsRaw.length > 50) bad('fields must have 1-50 rules');
  const seen = new Set<string>();
  const fields: FieldRule[] = (fieldsRaw as unknown[]).map((f, i) => {
    if (!f || typeof f !== 'object') bad(`fields[${i}] must be an object`);
    const r = f as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!['path', 'type', 'min', 'max'].includes(k)) bad(`unknown key "fields[${i}].${k}"`);
    const path = checkPath(r.path, `fields[${i}]`);
    if (seen.has(path)) bad(`duplicate field ${path}`);
    seen.add(path);
    if (typeof r.type !== 'string' || !TYPES.has(r.type)) bad(`fields[${i}].type invalid`);
    const out: FieldRule = { path, type: r.type as FieldType };
    for (const k of ['min', 'max'] as const) {
      if (r[k] === undefined) continue;
      if (r.type !== 'number' || typeof r[k] !== 'number' || !Number.isFinite(r[k] as number)) bad(`fields[${i}].${k} only applies to numbers`);
      out[k] = r[k] as number;
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) bad(`fields[${i}]: min > max`);
    return out;
  });
  const body: ContractBody = { schema: 1, success: { statuses: [...(statuses as number[])], contentType: 'application/json', maxLatencyMs: lat as number, fields } };
  if (s.nonEmpty !== undefined) {
    if (!Array.isArray(s.nonEmpty) || s.nonEmpty.length > 20) bad('nonEmpty must be a list of up to 20 paths');
    body.success.nonEmpty = (s.nonEmpty as unknown[]).map((p) => checkPath(p, 'nonEmpty'));
  }
  if (s.freshness !== undefined) {
    const f = s.freshness as Record<string, unknown>;
    if (!f || typeof f !== 'object') bad('freshness must be an object');
    for (const k of Object.keys(f)) if (!['path', 'maxAgeSeconds', 'format'].includes(k)) bad(`unknown key "freshness.${k}"`);
    if (!Number.isInteger(f.maxAgeSeconds) || (f.maxAgeSeconds as number) < 1 || (f.maxAgeSeconds as number) > 31_536_000) bad('freshness.maxAgeSeconds must be 1-31536000');
    if (!['iso', 'unix', 'unix_ms'].includes(String(f.format))) bad('freshness.format must be iso, unix or unix_ms');
    body.success.freshness = { path: checkPath(f.path, 'freshness'), maxAgeSeconds: f.maxAgeSeconds as number, format: f.format as FreshnessRule['format'] };
  }
  return body;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const hashContract = (body: ContractBody): string => createHash('sha256').update(canonical(body)).digest('hex');

// ------------------------------------------------------------------ evaluating a response

export interface UpstreamResult {
  status: number;
  contentType: string | undefined;
  /** parsed JSON body, or undefined when the body was not valid JSON */
  json: unknown;
  elapsedMs: number;
}
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface Evaluation {
  qualified: boolean;
  reasons: string[];
  checks: Check[];
}

function lookup(root: unknown, path: string): { found: boolean; value?: unknown } {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur as object, seg)) return { found: false };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}
const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function toMs(v: unknown, fmt: FreshnessRule['format']): number | undefined {
  if (fmt === 'iso') {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return undefined;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return fmt === 'unix' ? v * 1000 : v;
}

/** Pure: does this response satisfy the contract? Every failed rule is listed (so a refund is explainable). */
export function evaluate(body: ContractBody, r: UpstreamResult, nowMs: number): Evaluation {
  const c = body.success;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add('status', c.statuses.includes(r.status), `HTTP ${r.status}; allowed ${c.statuses.join(',')}`);
  const ct = (r.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  add('content-type', ct === c.contentType, `got "${ct || 'none'}"`);
  add('latency', r.elapsedMs <= c.maxLatencyMs, `${r.elapsedMs}ms; limit ${c.maxLatencyMs}ms`);
  const isObj = r.json !== null && typeof r.json === 'object';
  add('json', isObj, isObj ? 'body is a JSON object/array' : 'body is not a JSON object');
  if (isObj) {
    for (const f of c.fields) {
      const got = lookup(r.json, f.path);
      if (!got.found) {
        add(`field:${f.path}`, false, 'missing');
        continue;
      }
      const t = typeOf(got.value);
      let ok = t === f.type;
      let detail = ok ? `${t}` : `expected ${f.type}, got ${t}`;
      if (ok && f.type === 'number') {
        const n = got.value as number;
        if (!Number.isFinite(n)) (ok = false), (detail = 'not finite');
        else if (f.min !== undefined && n < f.min) (ok = false), (detail = `${n} < min ${f.min}`);
        else if (f.max !== undefined && n > f.max) (ok = false), (detail = `${n} > max ${f.max}`);
      }
      add(`field:${f.path}`, ok, detail);
    }
    for (const p of c.nonEmpty ?? []) {
      const got = lookup(r.json, p);
      const v = got.value;
      const empty = !got.found || v === null || v === '' || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
      add(`nonEmpty:${p}`, !empty, empty ? 'empty or missing' : 'present');
    }
    if (c.freshness) {
      const got = lookup(r.json, c.freshness.path);
      const t = got.found ? toMs(got.value, c.freshness.format) : undefined;
      if (t === undefined) add('freshness', false, 'timestamp missing or unparseable');
      else {
        const age = (nowMs - t) / 1000;
        // a timestamp in the future beyond a small clock-skew allowance is not "fresh", it is wrong
        add('freshness', age >= -30 && age <= c.freshness.maxAgeSeconds, `age ${Math.round(age)}s; limit ${c.freshness.maxAgeSeconds}s`);
      }
    }
  }
  const failed = checks.filter((x) => !x.ok);
  return { qualified: failed.length === 0, reasons: failed.map((x) => `${x.name}: ${x.detail}`), checks };
}

/** Suggest a contract from observed successful sample responses. A SUGGESTION: the seller edits and approves it. */
export function inferContract(samples: Array<{ json: unknown; elapsedMs: number }>): ContractBody {
  const objs = samples.filter((s) => s.json && typeof s.json === 'object' && !Array.isArray(s.json));
  if (objs.length === 0) bad('need at least one successful JSON-object sample');
  const flat = (o: unknown, prefix = '', depth = 0, out: Record<string, string> = {}): Record<string, string> => {
    if (depth > 3 || !o || typeof o !== 'object' || Array.isArray(o)) return out;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || FORBIDDEN.has(k)) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      const t = typeOf(v);
      if (t === 'object') flat(v, p, depth + 1, out);
      else if (t !== 'null') out[p] = t;
    }
    return out;
  };
  const maps = objs.map((s) => flat(s.json));
  const first = maps[0]!;
  const fields: FieldRule[] = Object.keys(first)
    .filter((p) => maps.every((m) => m[p] === first[p]))
    .slice(0, 50)
    .map((path) => ({ path, type: first[path] as FieldType }));
  if (fields.length === 0) bad('samples share no stable fields');
  const body: ContractBody = {
    schema: 1,
    success: { statuses: [200], contentType: 'application/json', maxLatencyMs: Math.min(30_000, Math.max(1_000, Math.ceil((Math.max(...samples.map((s) => s.elapsedMs)) * 3) / 500) * 500)), fields },
  };
  const strings = fields.filter((f) => f.type === 'string').map((f) => f.path);
  if (strings.length) body.success.nonEmpty = strings.slice(0, 20);
  for (const f of fields) {
    if (!/(updated|timestamp|as_?of|time|date|at)$/i.test(f.path.split('.').pop()!)) continue;
    const v = lookup(objs[0]!.json, f.path).value;
    const fmt: FreshnessRule['format'] | undefined = f.type === 'string' && toMs(v, 'iso') !== undefined ? 'iso' : f.type === 'number' ? ((v as number) > 1e12 ? 'unix_ms' : 'unix') : undefined;
    if (fmt && toMs(v, fmt) !== undefined) {
      body.success.freshness = { path: f.path, maxAgeSeconds: 300, format: fmt };
      break;
    }
  }
  return parseContractBody(body);
}

// ------------------------------------------------------------------ versions (stored, immutable)

export interface ContractVersion {
  id: string;
  listingId: string;
  version: number;
  status: 'proposed' | 'approved' | 'superseded';
  bodyHash: string;
  body: ContractBody;
  approvedAt: string | null;
}
const toVersion = (r: Record<string, unknown>): ContractVersion => ({
  id: String(r.id),
  listingId: String(r.listing_id),
  version: Number(r.version),
  status: r.status as ContractVersion['status'],
  bodyHash: String(r.body_hash),
  body: JSON.parse(String(r.body_json)) as ContractBody,
  approvedAt: r.approved_at === null ? null : String(r.approved_at),
});

function ownedListing(db: Db, listingId: string, actorId: string) {
  const l = queryOne(db, 'SELECT id, seller_id, status FROM listings WHERE id = ?', listingId);
  if (!l) throw new ContractError('NOT_FOUND', `no listing ${listingId}`);
  if (String(l.seller_id) !== actorId) throw new ContractError('NOT_OWNER', 'this listing belongs to another seller');
  return l;
}

/** Add a new proposed version. Identical content to an existing live version returns that version (idempotent). */
export function proposeContract(db: Db, listingId: string, actorId: string, raw: unknown, now: () => number = Date.now): ContractVersion {
  const body = parseContractBody(raw);
  const hash = hashContract(body);
  return inTransaction(db, () => {
    const l = ownedListing(db, listingId, actorId);
    if (!['verified', 'published', 'unpublished'].includes(String(l.status))) throw new ContractError('LISTING_NOT_VERIFIED', 'verify ownership before defining a contract');
    const same = queryOne(db, "SELECT * FROM contract_versions WHERE listing_id = ? AND body_hash = ? AND status <> 'superseded'", listingId, hash);
    if (same) return toVersion(same);
    const m = queryOne<{ v: bigint | null }>(db, 'SELECT MAX(version) AS v FROM contract_versions WHERE listing_id = ?', listingId);
    const version = Number(m?.v ?? 0n) + 1;
    const id = `con_${randomUUID()}`;
    db.prepare("INSERT INTO contract_versions (id, listing_id, version, body_json, body_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)").run(
      id, listingId, version, JSON.stringify(body), hash, new Date(now()).toISOString(),
    );
    audit(db, actorId, 'contract.proposed', id, { listingId, version, hash }, new Date(now()));
    return toVersion(queryOne(db, 'SELECT * FROM contract_versions WHERE id = ?', id)!);
  });
}

/** Approve a proposed version; the previously approved version becomes superseded. Existing executions keep their pin. */
export function approveContract(db: Db, contractId: string, actorId: string, now: () => number = Date.now): ContractVersion {
  return inTransaction(db, () => {
    const c = queryOne(db, 'SELECT * FROM contract_versions WHERE id = ?', contractId);
    if (!c) throw new ContractError('NOT_FOUND', `no contract ${contractId}`);
    ownedListing(db, String(c.listing_id), actorId);
    if (c.status === 'approved') return toVersion(c);
    if (c.status !== 'proposed') throw new ContractError('INVALID_TRANSITION', `a ${String(c.status)} version cannot be approved`);
    const at = new Date(now()).toISOString();
    db.prepare("UPDATE contract_versions SET status = 'superseded' WHERE listing_id = ? AND status = 'approved'").run(String(c.listing_id));
    db.prepare("UPDATE contract_versions SET status = 'approved', approved_at = ? WHERE id = ?").run(at, contractId);
    audit(db, actorId, 'contract.approved', contractId, { listingId: String(c.listing_id), version: Number(c.version) }, new Date(now()));
    return toVersion(queryOne(db, 'SELECT * FROM contract_versions WHERE id = ?', contractId)!);
  });
}

export function listContracts(db: Db, listingId: string): ContractVersion[] {
  return query(db, 'SELECT * FROM contract_versions WHERE listing_id = ? ORDER BY version', listingId).map(toVersion);
}
export function currentContract(db: Db, listingId: string): ContractVersion | undefined {
  const r = queryOne(db, "SELECT * FROM contract_versions WHERE listing_id = ? AND status = 'approved'", listingId);
  return r ? toVersion(r) : undefined;
}
export function getContract(db: Db, id: string): ContractVersion | undefined {
  const r = queryOne(db, 'SELECT * FROM contract_versions WHERE id = ?', id);
  return r ? toVersion(r) : undefined;
}
