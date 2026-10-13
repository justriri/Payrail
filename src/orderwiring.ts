// Order wiring: the pieces scripts/order.ts plugs into the orchestrator, kept here (not in the script) so
// they can be unit-tested with fakes. Nothing in this file signs or sends anything by itself: it chooses
// WHICH existing gated executor runs for a conversion provider, builds the confirmation gates, and reads
// the chain (read-only) to establish a conversion and to wait for converted funds.
import { erc20Abi, getAddress, parseEventLogs, parseUnits } from 'viem';
import type { Address } from 'viem';
import { assetBySymbol } from './assets.ts';
import type { SwapAuthorization } from './authorization.ts';
import type { ChainReads } from './chainread.ts';
import { TEXTILE_REACTOR } from './config.ts';
import { boundedConfirmers } from './liveswap.ts';
import { MENTO_PROVIDER, MENTO_ROUTER } from './mento.ts';
import type { FundsRequest, OrderDeps } from './orchestrator.ts';
import type { SwapDeps, SwapGates, SwapOutcome } from './swapexec.ts';
import type { SwapRecord } from './swapjournal.ts';

export const TEXTILE_PROVIDER = 'textile-fx-v2';

export class WiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WiringError';
  }
}

export type Confirmers = SwapGates;

// ------------------------------------------------------------------ confirmation gates

/**
 * Chooses how the exact conversion transactions get confirmed:
 *   --auto-confirm  bounded, non-interactive: needs explicit numeric --max-sell and --min-receive limits;
 *                   anything outside them declines (a decline sends nothing).
 *   otherwise       a person types the digest of the exact transactions; requires an interactive terminal.
 */
export function makeConfirmersFactory(o: {
  auto: boolean;
  maxSell?: string | undefined;
  minReceive?: string | undefined;
  attributionTag: string;
  isTTY: boolean;
  line: (s: string) => void;
  terminal: () => Confirmers;
  minSecondsRemaining?: number;
}): (spender: Address, sellSymbol: string, buySymbol: string) => Confirmers {
  const num = /^\d+(\.\d+)?$/;
  return (spender, sellSymbol, buySymbol) => {
    if (o.auto) {
      const sell = assetBySymbol(sellSymbol);
      const buy = assetBySymbol(buySymbol);
      if (!o.maxSell || !o.minReceive || !num.test(o.maxSell) || !num.test(o.minReceive)) {
        throw new WiringError('--auto-confirm requires explicit numeric limits: --max-sell <sell asset amount> --min-receive <buy asset amount>');
      }
      if (!sell || !buy) throw new WiringError(`unknown asset in ${sellSymbol} -> ${buySymbol}`);
      return boundedConfirmers(
        {
          sellSymbol,
          sellAsset: sell.address,
          maxSellAtomic: parseUnits(o.maxSell, sell.decimals),
          minReceiveAtomic: parseUnits(o.minReceive, buy.decimals),
          spender,
          attributionTag: o.attributionTag,
          minSecondsRemaining: o.minSecondsRemaining ?? 10,
        },
        o.line,
      );
    }
    if (!o.isTTY) throw new WiringError('an interactive terminal is required to confirm the transactions (or use --auto-confirm with explicit limits)');
    return o.terminal();
  };
}

// ------------------------------------------------------------------ conversion runners

/** The contract each venue's sell token must be approved to (and which the swap is sent through). */
export const SPENDER_BY_PROVIDER: Readonly<Record<string, Address>> = Object.freeze({
  [TEXTILE_PROVIDER]: TEXTILE_REACTOR,
  [MENTO_PROVIDER]: MENTO_ROUTER,
});

/**
 * One runner per conversion venue, keyed by the provider name a plan can choose. Each runner REFUSES an
 * authorization minted for a different venue, builds its own confirmers for that venue's spender, and then
 * calls the existing gated pipeline (runSwap / runAmmSwap). No new spending path exists here.
 */
export function buildSwapRunners(w: {
  makeSwapDeps: () => SwapDeps;
  makeMentoVenue: () => unknown;
  runTextile: (auth: SwapAuthorization, deps: SwapDeps, gates: SwapGates) => Promise<SwapOutcome>;
  runMento: (auth: SwapAuthorization, venue: never, deps: SwapDeps, gates: SwapGates) => Promise<SwapOutcome>;
  confirmersFor: (spender: Address, sellSymbol: string, buySymbol: string) => Confirmers;
}): Record<string, (auth: SwapAuthorization) => Promise<SwapOutcome>> {
  const gatesFor = (auth: SwapAuthorization, provider: string): SwapGates => {
    if (auth.provider !== provider) {
      throw new WiringError(`authorization is for ${auth.provider}, but this runner is ${provider}`);
    }
    const g = w.confirmersFor(SPENDER_BY_PROVIDER[provider]!, auth.sell.symbol, auth.buy.symbol);
    return { confirm: g.confirm, ...(g.confirmApproval ? { confirmApproval: g.confirmApproval } : {}) };
  };
  return {
    [TEXTILE_PROVIDER]: async (auth) => w.runTextile(auth, w.makeSwapDeps(), gatesFor(auth, TEXTILE_PROVIDER)),
    [MENTO_PROVIDER]: async (auth) => w.runMento(auth, w.makeMentoVenue() as never, w.makeSwapDeps(), gatesFor(auth, MENTO_PROVIDER)),
  };
}

// ------------------------------------------------------------------ independent chain checks (read-only)

export interface ChainReader {
  /**
   * undefined means the transaction DEFINITELY does not exist (yet). A lookup that could not be completed
   * (network, RPC error) must THROW, so it is never mistaken for "not found".
   */
  getReceipt(hash: string): Promise<
    | {
        status: 'success' | 'reverted';
        blockNumber: bigint;
        /** The account that sent the transaction (tx.from), when the reader can tell. */
        from?: string;
        transfers: Array<{ token: string; from: string; to: string; value: bigint }>;
      }
    | undefined
  >;
  latestBlock(): Promise<bigint>;
  /** token balance read at an exact block */
  balanceAt(asset: Address, owner: Address, block: bigint): Promise<bigint>;
  /** the balance as the PLANNER sees it (its own reader, latest) */
  balanceForPlanner(asset: Address, owner: Address): Promise<bigint>;
}

/**
 * Re-establish a conversion from the chain, independent of Payrail's journals: the swap transaction must
 * exist and have succeeded, and a Transfer of the buy asset to the payer of at least the received amount
 * (or the planned minimum) must be in it.
 */
export function createConversionVerifier(r: ChainReader, payer: Address): NonNullable<OrderDeps['verifyConversionOnChain']> {
  return async (swap: SwapRecord) => {
    const swapStep = [...swap.steps].reverse().find((s) => s.kind === 'swap' && typeof s.hash === 'string');
    if (!swapStep?.hash) return { established: false, detail: 'the swap record has no swap transaction hash' };
    let rc: Awaited<ReturnType<ChainReader['getReceipt']>>;
    try {
      rc = await r.getReceipt(swapStep.hash);
    } catch (e) {
      // The chain could not be read: say so, and let the caller retry later. This is NOT "not established".
      return { established: false, retryable: true, detail: `could not read swap transaction ${swapStep.hash}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
    }
    if (!rc) return { established: false, detail: `swap transaction ${swapStep.hash} was not found on-chain` };
    if (rc.from !== undefined && rc.from.toLowerCase() !== payer.toLowerCase()) {
      return { established: false, detail: `swap transaction ${swapStep.hash} was sent by ${rc.from}, not by the wallet ${payer}` };
    }
    if (rc.status !== 'success') return { established: false, detail: `swap transaction ${swapStep.hash} did not succeed (${rc.status})` };
    const want = BigInt(swap.verification.buyReceived ?? swap.amounts.minBuy);
    const got = rc.transfers
      .filter((t) => t.token.toLowerCase() === swap.route.buyAsset.toLowerCase() && t.to.toLowerCase() === payer.toLowerCase())
      .reduce((n, t) => n + t.value, 0n);
    if (got < want) return { established: false, detail: `only ${got} atomic ${swap.route.buySymbol} reached the wallet in ${swapStep.hash}; expected at least ${want}` };
    return { established: true, detail: `swap tx ${swapStep.hash} succeeded at block ${rc.blockNumber}; ${got} atomic ${swap.route.buySymbol} credited` };
  };
}

/**
 * After a conversion, wait (bounded) until the converted funds are visible BOTH by an exact-block read at or
 * after the swap's block AND through the same reader the planner uses, so the re-price cannot run against a
 * lagging node. Bounded: `attempts` tries, `delayMs` apart.
 */
export function createFundsAwaiter(
  r: ChainReader,
  o: { sleep: (ms: number) => Promise<void>; attempts?: number; delayMs?: number },
): NonNullable<OrderDeps['awaitConvertedFunds']> {
  const attempts = o.attempts ?? 6;
  const delayMs = o.delayMs ?? 1500;
  return async (req: FundsRequest) => {
    let last = 'no attempt made';
    for (let i = 1; i <= attempts; i++) {
      try {
        let block = await r.latestBlock();
        for (const h of req.txHashes) {
          const rc = await r.getReceipt(h);
          if (rc && rc.blockNumber > block) block = rc.blockNumber;
        }
        const exact = await r.balanceAt(req.asset, req.owner, block);
        const seen = await r.balanceForPlanner(req.asset, req.owner);
        last = `block ${block}: exact-block balance ${exact}, planner view ${seen}, need ${req.minAtomic} (attempt ${i}/${attempts})`;
        if (exact >= req.minAtomic && seen >= req.minAtomic) return { ok: true, detail: last };
      } catch (e) {
        last = `read failed (attempt ${i}/${attempts}): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
      }
      if (i < attempts) await o.sleep(delayMs);
    }
    return { ok: false, detail: last };
  };
}

/**
 * The production ChainReader over a viem public client (read-only). `getBalance` is the SAME reader the
 * planner uses, so the funds wait and the re-price agree.
 */
export function createChainReader(
  client: {
    getTransactionReceipt(a: { hash: `0x${string}` }): Promise<{
      status: 'success' | 'reverted';
      blockNumber: bigint;
      logs: Parameters<typeof parseEventLogs>[0]['logs'];
    }>;
    getBlockNumber(): Promise<bigint>;
    readContract(a: never): Promise<unknown>;
  },
  getBalance: (asset: Address, owner: Address) => Promise<bigint>,
  /** When given, receipts come from the multi-endpoint, retrying lookup (see src/chainread.ts). */
  reads?: ChainReads<any>,
): ChainReader {
  return {
    async getReceipt(hash) {
      if (reads) {
        const lk = await reads.lookupReceipt(hash as `0x${string}`, { attempts: 5 });
        if (lk.kind === 'found') {
          const r = lk.receipt as unknown as { status: 'success' | 'reverted'; blockNumber: bigint; from?: string; logs: Parameters<typeof parseEventLogs>[0]['logs'] };
          const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs as never }).map((l) => ({
            token: getAddress(l.address),
            from: getAddress(l.args.from),
            to: getAddress(l.args.to),
            value: l.args.value,
          }));
          return { status: r.status, blockNumber: r.blockNumber, ...(r.from ? { from: getAddress(r.from) } : {}), transfers };
        }
        // Only "no endpoint knows the transaction" is absence. Everything else is a lookup that did not
        // conclude, and must not be mistaken for "not found": throw so callers treat it as retryable.
        if (lk.kind === 'not_found') return undefined;
        throw new Error(`receipt lookup inconclusive (${lk.kind}): ${'detail' in lk ? lk.detail : 'fewer endpoints than required agreed'}`);
      }
      try {
        const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
        const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs as never }).map((l) => ({
          token: getAddress(l.address),
          from: getAddress(l.args.from),
          to: getAddress(l.args.to),
          value: l.args.value,
        }));
        const from = (r as { from?: string }).from;
        return { status: r.status, blockNumber: r.blockNumber, ...(from ? { from: getAddress(from) } : {}), transfers };
      } catch (e) {
        // Only a definitive "no such receipt" is absence. Anything else (RPC down, timeout) is a failed lookup.
        const name = e instanceof Error ? e.name : '';
        if (name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError') return undefined;
        throw e;
      }
    },
    latestBlock: () => client.getBlockNumber(),
    balanceAt: async (asset, owner, block) =>
      (await client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber: block } as never)) as bigint,
    balanceForPlanner: (asset, owner) => getBalance(asset, owner),
  };
}
