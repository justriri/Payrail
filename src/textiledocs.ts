// Textile's OFFICIAL list of live corridors on Celo, read from its published address book (https://docs.textilecredit.com/protocol/address-book).
// This is the authority for "which currencies does Textile support on Celo": a currency is only offered when it appears there AND the
// token address Payrail uses for it appears on that same page. The page is fetched at runtime (cached for an hour), so a currency Textile adds
// to its official list can be offered without a code change, provided Payrail knows its token contract (src/assets.ts). When the page cannot be
// read, the last good answer is used; with none, the built-in snapshot below (read 2026-10-17) is used and flagged as such.
import { CELO_CHAIN_ID } from './conversion.ts';

export const ADDRESS_BOOK_URL = 'https://docs.textilecredit.com/protocol/address-book';
/** snapshot of the Celo corridors on the official page on 2026-10-17: only used when the page cannot be read */
export const SNAPSHOT_CELO_SYMBOLS: readonly string[] = ['cNGN', 'USDC', 'wARS', 'wBRL', 'IDRX'];

export interface OfficialCorridors {
  /** symbols with a live Celo corridor against USDT */
  symbols: ReadonlySet<string>;
  /** lower-case contract addresses that appear on the page (a token must be listed here to be trusted) */
  addresses: ReadonlySet<string>;
  source: 'official-page' | 'last-good-copy' | 'built-in-snapshot';
  fetchedAt: string;
}

/** Pure parser. Returns undefined when the page does not have the expected shape (so a changed page never silently enables or disables anything). */
export function parseOfficialCorridors(html: string): { symbols: Set<string>; addresses: Set<string> } | undefined {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ');
  const m = new RegExp(`Celo \\(${CELO_CHAIN_ID}\\)\\s+((?:[A-Za-z0-9$.]+\\s*(?:↔|<->|&harr;)\\s*[A-Za-z0-9$.]+\\s*,?\\s*)+)`).exec(text);
  if (!m) return undefined;
  const symbols = new Set<string>();
  for (const pair of m[1]!.split(',')) {
    const [a, b] = pair.split(/↔|<->|&harr;/).map((x) => x.trim());
    if (!a || !b) continue;
    // corridors are written "X ↔ USDT"; the non-USDT side is the currency
    if (b === 'USDT' && a !== 'USDT') symbols.add(a);
    else if (a === 'USDT' && b !== 'USDT') symbols.add(b);
  }
  if (symbols.size === 0) return undefined;
  const addresses = new Set((text.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));
  return { symbols, addresses };
}

export function createOfficialCorridors(o: { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; url?: string } = {}): () => Promise<OfficialCorridors> {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 60 * 60_000;
  let good: { at: number; value: Omit<OfficialCorridors, 'source' | 'fetchedAt'> } | undefined;
  return async () => {
    if (good && now() - good.at < ttl) return { ...good.value, source: 'official-page', fetchedAt: new Date(good.at).toISOString() };
    try {
      const r = await f(o.url ?? ADDRESS_BOOK_URL, { signal: AbortSignal.timeout(8_000) });
      if (r.ok) {
        const parsed = parseOfficialCorridors(await r.text());
        if (parsed) {
          good = { at: now(), value: parsed };
          return { ...parsed, source: 'official-page', fetchedAt: new Date(good.at).toISOString() };
        }
      }
    } catch { /* fall through to the last good copy */ }
    if (good) return { ...good.value, source: 'last-good-copy', fetchedAt: new Date(good.at).toISOString() };
    return { symbols: new Set(SNAPSHOT_CELO_SYMBOLS), addresses: new Set(), source: 'built-in-snapshot', fetchedAt: '2026-10-17T00:00:00.000Z' };
  };
}
