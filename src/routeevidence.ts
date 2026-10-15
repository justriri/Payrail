// What we actually KNOW about each conversion route, and how we came to know it.
//
// Four distinct kinds of statement must never be blurred:
//   live-executed : our own code executed this conversion on mainnet and the transaction was verified (tx hash below)
//   live-quoted   : the provider's public ladder / preview showed liquidity at the stated time (indicative, reserves
//                   nothing, says nothing about liquidity now or about the reverse direction)
//   documented    : the asset appears in the provider's published address book / docs
//   simulated     : our simulation offers it; prices are simulation constants
// A simulated route is NEVER evidence of a live route. A dated snapshot is NEVER current liquidity.
import type { Direction } from './conversion.ts';

export type EvidenceLevel = 'live-executed' | 'live-quoted' | 'documented' | 'simulated' | 'none';

export interface RouteEvidence {
  level: EvidenceLevel;
  /** one plain sentence for the interface */
  basis: string;
  asOf?: string;
  txs?: string[];
  /** whether this server could EXECUTE the route against the live network today (always false while live is unwired) */
  executableLive: false;
}

/** Textile's published address book lists these on Celo (docs.textilecredit.com/protocol/address-book, read 2026-10-14). */
export const DOCUMENTED_ON_CELO = new Set(['cNGN', 'USDT', 'USDC', 'wARS', 'wBRL', 'IDRX']);

/**
 * Routes our own code has executed on Celo mainnet (project evidence ledger). Direction is from the TAKER's point of view.
 */
export const LIVE_EXECUTED: Record<string, { txs: string[]; at: string }> = {
  'payout:cNGN': { txs: ['0xab592f83fe659607fff8c8892373c89bb396348028761fa8844c42f82a1d1c0c'], at: '2026-10-13' }, // USDT -> cNGN
  'funding:cNGN': { txs: ['0x102eafffbaf5d561aa9a5fa65ac9d4910b87613fd1b1b679afca9bdd028bacb7'], at: '2026-10-14' }, // cNGN -> USDT
};

/** Assets that showed makers on the public ladder / preview on 2026-10-14, per direction (indicative only). */
export const LIVE_QUOTED_20261014: Record<'funding' | 'payout', ReadonlySet<string>> = {
  funding: new Set(['cNGN', 'wARS', 'wBRL', 'USDC', 'USAT', 'CELO', 'wCOP', 'WETH', 'IDRX', 'wMXN']),
  payout: new Set(['cNGN', 'wARS', 'wBRL', 'USDC', 'USAT', 'CELO', 'wCOP', 'WETH']),
};

/** The evidence for an asset in a direction, as seen from a provider that is or is not a simulation. */
export function evidenceFor(direction: Direction, symbol: string, o: { providerSimulated: boolean; liveAsOf?: string; liveAvailable?: boolean }): RouteEvidence {
  if (symbol === 'USDT') return { level: 'live-executed', basis: 'USDT is the settlement asset: no conversion is involved.', executableLive: false };
  const executed = LIVE_EXECUTED[`${direction}:${symbol}`];
  if (o.providerSimulated) {
    const snap = LIVE_QUOTED_20261014[direction].has(symbol);
    return {
      level: 'simulated',
      basis: `Simulated route. ${snap ? 'A snapshot of the provider ladder showed makers on 2026-10-14, which is not current liquidity.' : 'It had no makers in the 2026-10-14 snapshot.'}${executed ? ` Our own code executed this direction once on mainnet (${executed.at}).` : ''}`,
      asOf: '2026-10-14',
      ...(executed ? { txs: executed.txs } : {}),
      executableLive: false,
    };
  }
  if (executed) return { level: 'live-executed', basis: `Executed once on mainnet by this project (${executed.at}); liquidity now is only what the live ladder shows.`, txs: executed.txs, ...(o.liveAsOf ? { asOf: o.liveAsOf } : {}), executableLive: false };
  if (o.liveAsOf !== undefined) {
    return { level: 'live-quoted', basis: o.liveAvailable ? 'Makers were quoting on the provider ladder when read (indicative; not a firm quote; not executed by this project).' : 'Listed on the provider ladder but with no liquidity when read.', asOf: o.liveAsOf, executableLive: false };
  }
  if (DOCUMENTED_ON_CELO.has(symbol)) return { level: 'documented', basis: 'Listed in the provider address book; no live check was made.', executableLive: false };
  return { level: 'none', basis: 'No evidence of a route.', executableLive: false };
}
