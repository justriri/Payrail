// Currency-agnostic conversion layer.
//
// Funding (buyer asset -> USDT) and payouts (USDT -> seller asset) are DIFFERENT routes: a verified X -> USDT route
// says nothing about USDT -> X (wMXN is fundable but not payable on Textile today). Routes are therefore always asked
// for per direction, discovered live, never cached for long, and filtered by an operator allow-list.
//
// Providers are plug-ins. Textile is one (simulated here: src/simconversion.ts); a future provider implements the same
// interface and the marketplace code does not change.
import { audit, query } from './db.ts';
import type { Db } from './db.ts';

export interface AssetRef {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
}

export type Direction = 'funding' | 'payout';

export type UnavailableReason =
  | 'no_makers_online'
  | 'no_levels'
  | 'no_valid_quote'
  | 'not_on_ladder'
  | 'chain_unsupported'
  | 'not_enabled'
  | 'below_floor'
  | 'provider_error';

export interface Route {
  provider: string;
  direction: Direction;
  from: AssetRef;
  to: AssetRef;
  available: boolean;
  unavailableReason?: UnavailableReason;
  /** corridor floor, in `from` atomic units */
  minInputAtomic: bigint;
  /** indicative depth, in `from` atomic units (a ceiling, not a promise) */
  maxInputAtomic: bigint;
  /** the provider moves nothing: the asset already is the settlement asset */
  passthrough?: boolean;
  discoveredAt: number;
}

export interface ConversionQuote {
  id: string;
  provider: string;
  direction: Direction;
  from: AssetRef;
  to: AssetRef;
  inputAtomic: bigint;
  expectedOutputAtomic: bigint;
  /** the least the conversion may deliver; below this nothing is credited or marked paid */
  minOutputAtomic: bigint;
  /** the venue fee in `from` units for funding, in `to` units for payouts (already inside the numbers above) */
  feeAtomic: bigint;
  rate: string;
  expiresAtMs: number;
  notes: string[];
}

export interface ConversionProvider {
  readonly id: string;
  readonly simulated: boolean;
  discoverRoutes(direction: Direction): Promise<Route[]>;
  quote(a: { direction: Direction; from: AssetRef; to: AssetRef; inputAtomic: bigint; scenario?: string }): Promise<ConversionQuote>;
}

export const CELO_CHAIN_ID = 42220;
export const USDT_CELO: AssetRef = { chainId: CELO_CHAIN_ID, address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', symbol: 'USDT', decimals: 6 };

// ------------------------------------------------------------------ operator allow-list (conversion_assets table)

export interface AllowedAsset extends AssetRef {
  fundingEnabled: boolean;
  payoutEnabled: boolean;
  note: string | null;
}

/** Conservative defaults: deep, symmetric corridors only. Everything else is listed but disabled until the operator opts in. */
export const DEFAULT_ASSET_POLICY: ReadonlyArray<AllowedAsset> = [
  { chainId: 42220, address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', symbol: 'cNGN', decimals: 6, fundingEnabled: true, payoutEnabled: true, note: 'deep both ways' },
  { chainId: 42220, address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', symbol: 'wARS', decimals: 18, fundingEnabled: true, payoutEnabled: true, note: 'deep both ways' },
  { chainId: 42220, address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', symbol: 'wBRL', decimals: 18, fundingEnabled: true, payoutEnabled: true, note: 'deep both ways' },
  { chainId: 42220, address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', symbol: 'USDC', decimals: 6, fundingEnabled: true, payoutEnabled: false, note: 'thin (about $1k)' },
  { chainId: 42220, address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', symbol: 'USAT', decimals: 6, fundingEnabled: true, payoutEnabled: false, note: 'payout depth about $4.8k' },
  { chainId: 42220, address: '0x8a1D45e102e886510e891d2Ec656a708991e2D76', symbol: 'wCOP', decimals: 18, fundingEnabled: false, payoutEnabled: false, note: 'not enabled yet' },
  { chainId: 42220, address: '0x471EcE3750Da237f93B8E339c536989b8978a438', symbol: 'CELO', decimals: 18, fundingEnabled: false, payoutEnabled: false, note: 'payout depth about $33' },
  { chainId: 42220, address: '0xD221812de1BD094f35587EE8E174B07B6167D9Af', symbol: 'WETH', decimals: 18, fundingEnabled: false, payoutEnabled: false, note: 'payout depth about $55' },
  { chainId: 42220, address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', symbol: 'IDRX', decimals: 2, fundingEnabled: false, payoutEnabled: false, note: 'payout depth about $2' },
  { chainId: 42220, address: '0x337E7456B420bD3481e7FA61fA9850343d610d34', symbol: 'wMXN', decimals: 18, fundingEnabled: false, payoutEnabled: false, note: 'USDT -> wMXN has no makers' },
  { chainId: 42220, address: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A', symbol: 'G$', decimals: 18, fundingEnabled: false, payoutEnabled: false, note: 'no liquidity either way' },
];

/** Idempotent. Never overwrites an operator's later choice. */
export function seedConversionAssets(db: Db, policy: ReadonlyArray<AllowedAsset> = DEFAULT_ASSET_POLICY): void {
  const st = db.prepare('INSERT OR IGNORE INTO conversion_assets (chain_id, address, symbol, decimals, funding_enabled, payout_enabled, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const a of policy) st.run(a.chainId, a.address.toLowerCase(), a.symbol, a.decimals, a.fundingEnabled ? 1 : 0, a.payoutEnabled ? 1 : 0, a.note);
}

export function loadAllowList(db: Db): AllowedAsset[] {
  return query(db, 'SELECT * FROM conversion_assets ORDER BY symbol').map((r) => ({
    chainId: Number(r.chain_id),
    address: String(r.address),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    fundingEnabled: Number(r.funding_enabled) === 1,
    payoutEnabled: Number(r.payout_enabled) === 1,
    note: r.note === null ? null : String(r.note),
  }));
}

/** Operator action (CLI or tests): enable or disable an asset for one direction. */
export function setAssetEnabled(db: Db, chainId: number, address: string, direction: Direction, enabled: boolean, actor: string): void {
  const col = direction === 'funding' ? 'funding_enabled' : 'payout_enabled';
  const r = db.prepare(`UPDATE conversion_assets SET ${col} = ? WHERE chain_id = ? AND address = ?`).run(enabled ? 1 : 0, chainId, address.toLowerCase());
  if (Number(r.changes) !== 1) throw new Error('unknown conversion asset');
  audit(db, actor, 'conversion_asset.set', `${chainId}:${address.toLowerCase()}`, { direction, enabled });
}

// ------------------------------------------------------------------ registry

export interface RouteView extends Route {
  /** operator allow-list */
  enabled: boolean;
  /** available now AND enabled */
  usable: boolean;
  reason: string | null;
}

const REASON_TEXT: Record<UnavailableReason, string> = {
  no_makers_online: 'no market makers are quoting this route right now',
  no_levels: 'listed, but with no liquidity',
  no_valid_quote: 'the provider returned no valid quote for this size',
  not_on_ladder: 'this asset is not listed by the provider',
  chain_unsupported: 'the chain is not supported',
  not_enabled: 'not enabled by the operator',
  below_floor: 'below the provider minimum',
  provider_error: 'the provider could not be reached',
};

export class RouteRegistry {
  private providers: ConversionProvider[];
  private db: Db;
  constructor(db: Db, providers: ConversionProvider[]) {
    this.db = db;
    this.providers = providers;
  }

  /** Every known asset in this direction, with live availability from each provider. Never throws for one bad provider. */
  async routes(direction: Direction): Promise<RouteView[]> {
    const allow = loadAllowList(this.db);
    const out: RouteView[] = [];
    // USDT is the settlement asset: funding it needs no conversion, paying it out needs none either
    out.push({
      provider: 'none', direction, from: USDT_CELO, to: USDT_CELO, available: true, minInputAtomic: 1n, maxInputAtomic: 10_000_000_000n,
      passthrough: true, discoveredAt: Date.now(), enabled: true, usable: true, reason: null,
    });
    const seen = new Set<string>();
    for (const p of this.providers) {
      let rs: Route[] = [];
      try {
        rs = await p.discoverRoutes(direction);
      } catch {
        continue;
      }
      for (const r of rs) {
        const asset = direction === 'funding' ? r.from : r.to;
        const key = `${asset.chainId}:${asset.address.toLowerCase()}`;
        if (seen.has(key)) continue; // first provider wins; a future selector can compare quotes
        seen.add(key);
        const a = allow.find((x) => x.chainId === asset.chainId && x.address.toLowerCase() === asset.address.toLowerCase());
        const enabled = a ? (direction === 'funding' ? a.fundingEnabled : a.payoutEnabled) : false;
        const usable = r.available && enabled;
        out.push({
          ...r,
          enabled,
          usable,
          reason: usable ? null : !r.available ? REASON_TEXT[r.unavailableReason ?? 'provider_error'] : REASON_TEXT.not_enabled,
        });
      }
    }
    // assets the operator listed that no provider knows at all: report clearly instead of silently omitting
    for (const a of allow) {
      const key = `${a.chainId}:${a.address.toLowerCase()}`;
      if (seen.has(key) || a.symbol === 'USDT') continue;
      out.push({
        provider: 'none', direction, from: direction === 'funding' ? a : USDT_CELO, to: direction === 'funding' ? USDT_CELO : a,
        available: false, unavailableReason: 'not_on_ladder', minInputAtomic: 0n, maxInputAtomic: 0n, discoveredAt: Date.now(),
        enabled: false, usable: false, reason: REASON_TEXT.not_on_ladder,
      });
    }
    return out;
  }

  async find(direction: Direction, symbolOrAddress: string): Promise<RouteView | undefined> {
    const k = symbolOrAddress.toLowerCase();
    return (await this.routes(direction)).find((r) => {
      const a = direction === 'funding' ? r.from : r.to;
      return a.symbol.toLowerCase() === k || a.address.toLowerCase() === k;
    });
  }

  provider(id: string): ConversionProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }
}
