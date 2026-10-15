// Live (network-backed) wiring for the swap pipeline and conversion planning. Used by the CLIs.
// Planning is read-only. The only spend-capable pieces are createSwapChain() (validated steps only) and the
// EIP-712 identity proof, and both are reachable only through runSwap() after its gates.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { verifyTx } from '@celo/attribution-tags';
import { encodeFunctionData, erc20Abi, toHex } from 'viem';
import type { Address, LocalAccount } from 'viem';
import type { Config } from './config.ts';
import type { createLive } from './live.ts';
import type { ConversionDeps } from './planner.ts';
import { createSwapChain } from './swapchain.ts';
import { DEFAULT_SWAP_LIMITS } from './swapexec.ts';
import type { ApprovalSummary, SwapDeps, SwapSummary } from './swapexec.ts';
import { cancelRfq, firmQuote, getRfqStatus } from './textile.ts';
import type { TakerProof } from './textile.ts';
import { takerControlTypedData } from './takerproof.ts';

type Live = ReturnType<typeof createLive>;

/** Read-only dependencies for planConversion. */
export function createConversionDeps(live: Live, policy: ConversionDeps['policy']): ConversionDeps {
  return {
    now: () => Date.now(),
    policy,
    getBalances: live.planDeps.getBalances,
    getNativeBalance: live.planDeps.getNativeBalance,
    gasPriceWei: live.planDeps.gasPriceWei,
    getAllowance: (token, owner, spender) =>
      live.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    // eth_estimateGas is a read-only simulation; nothing is signed or sent.
    measureApproveGas: (token, owner, spender, amount) =>
      live.client.estimateGas({
        account: owner,
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
      }),
    routes: live.planDeps.routes,
    swapExecution: true,
  };
}

async function takerProofFor(account: LocalAccount, chainId: number): Promise<TakerProof> {
  const nonce = toHex(randomBytes(32));
  const issuedAt = Date.now();
  const t = takerControlTypedData(account.address, chainId, nonce, issuedAt);
  const signature = await account.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { nonce, issuedAt, signature };
}

/** Full swap dependencies, including the signer. Constructing this does not sign or send anything. */
export function createLiveSwapDeps(args: {
  cfg: Config;
  account: LocalAccount;
  live: Live;
  approvalPhase?: 'with-quote' | 'before-quote';
  /** Cumulative daily swap cap (micro-USD), enforced inside the swap lock. */
  dailySwapCapMicroUsd?: bigint;
  log?: (line: string) => void;
}): SwapDeps {
  const { cfg, account, live } = args;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    chain: createSwapChain({ account, rpcFallbackUrls: cfg.rpcFallbackUrls, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) }),
    textile: {
      firmQuote: (a) => firmQuote(a),
      status: (id, claim) => getRfqStatus(id, claim),
      cancel: (id, claim) => cancelRfq(id, claim),
    },
    takerProof: () => takerProofFor(account, cfg.chainId),
    verifyAttribution: (hash) => verifyTx({ client: live.client, hash }),
    signer: account.address as Address,
    receiptDir: live.receiptDir,
    attributionTag: cfg.attributionTag,
    limits: DEFAULT_SWAP_LIMITS,
    approvalPhase: args.approvalPhase ?? 'before-quote',
    ...(args.dailySwapCapMicroUsd !== undefined ? { dailySwapCapMicroUsd: args.dailySwapCapMicroUsd } : {}),
    ...(args.log ? { log: args.log } : {}),
  };
}

// ------------------------------------------------------------------ bounded, non-interactive confirmation
//
// For agents and unattended runs. It is NOT "approve everything": a human sets explicit limits on the command
// line, and each decision approves ONLY if the real, validated, simulated transactions fall inside them.
// Anything unexpected declines, and a decline sends nothing.

export interface ConfirmBounds {
  sellSymbol: string;
  sellAsset: Address;
  /** The most of the sell asset (atomic) that may be debited or approved. */
  maxSellAtomic: bigint;
  /** The least of the buy asset (atomic) the swap must deliver. */
  minReceiveAtomic: bigint;
  spender: Address;
  attributionTag: string;
  /** The swap is declined if fewer seconds than this remain on the quote. */
  minSecondsRemaining: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const num = (v: string): bigint | undefined => (/^\d+$/.test(v) ? BigInt(v) : undefined);

export function boundedApprovalDecision(s: ApprovalSummary, b: ConfirmBounds): { approved: boolean; reason: string; approvedBy?: string } {
  const no = (reason: string) => ({ approved: false, reason });
  const amount = num(s.amountAtomic);
  if (s.token !== b.sellSymbol) return no(`token ${s.token} is not ${b.sellSymbol}`);
  if (amount === undefined || amount > b.maxSellAtomic) return no(`approval amount ${s.amountAtomic} exceeds the bound ${b.maxSellAtomic}`);
  if (!same(s.spender, b.spender)) return no(`spender ${s.spender} is not the verified reactor`);
  if (s.attributionTag !== b.attributionTag) return no('attribution tag is not the official tag');
  if (s.steps.length === 0 || s.steps.length > 2) return no(`unexpected number of approval transactions (${s.steps.length})`);
  for (const st of s.steps) {
    if (st.kind !== 'approve' && st.kind !== 'approve_reset') return no(`unexpected transaction kind ${st.kind}`);
    if (!same(st.to, b.sellAsset)) return no(`approval targets ${st.to}, not the sell token`);
  }
  if (s.simulations.length === 0 || s.simulations.some((x) => x.verdict !== 'identical')) return no('a tagged simulation was not identical to the untagged one');
  return { approved: true, reason: 'within bounds', approvedBy: 'bounded:auto(approval)' };
}

export function boundedSwapDecision(s: SwapSummary, b: ConfirmBounds): { approved: boolean; reason: string; approvedBy?: string } {
  const no = (reason: string) => ({ approved: false, reason });
  const pays = num(s.takerPays);
  const buy = num(s.buyAmount);
  if (pays === undefined || buy === undefined) return no('quote amounts are not numeric');
  if (pays > b.maxSellAtomic) return no(`the swap would debit ${pays}, above the bound ${b.maxSellAtomic}`);
  if (buy < b.minReceiveAtomic) return no(`the swap would deliver ${buy}, below the bound ${b.minReceiveAtomic}`);
  if (s.attributionTag !== b.attributionTag) return no('attribution tag is not the official tag');
  if (s.steps.length !== 1 || s.steps[0]!.kind !== 'swap') return no(`expected exactly one swap transaction, got ${s.steps.map((x) => x.kind).join(',')}`);
  if (!same(s.steps[0]!.to, b.spender)) return no(`swap targets ${s.steps[0]!.to}, not the verified reactor`);
  if (s.simulations.some((x) => x.verdict !== 'identical' && x.verdict !== 'deferred_until_allowance_exists')) return no('a tagged simulation was not identical');
  if (s.secondsRemaining < b.minSecondsRemaining) return no(`only ${s.secondsRemaining}s remain on the quote`);
  return { approved: true, reason: 'within bounds', approvedBy: 'bounded:auto(swap)' };
}

export function boundedConfirmers(b: ConfirmBounds, line: (s: string) => void) {
  return {
    async confirmApproval(s: ApprovalSummary) {
      const d = boundedApprovalDecision(s, b);
      line(`[bounded] approval ${d.approved ? 'AUTHORIZED' : 'DECLINED'}: ${d.reason}`);
      return d.approved ? { approved: true, approvedBy: d.approvedBy ?? 'bounded:auto' } : { approved: false };
    },
    async confirm(s: SwapSummary) {
      const d = boundedSwapDecision(s, b);
      line(`[bounded] swap ${d.approved ? 'AUTHORIZED' : 'DECLINED'}: ${d.reason} (pays ${s.takerPays}, receives ${s.buyAmount} atomic)`);
      return d.approved ? { approved: true, approvedBy: d.approvedBy ?? 'bounded:auto' } : { approved: false };
    },
  };
}

/** Interactive confirmers: the human must TYPE the first 8 characters of the digest of the exact transactions. */
async function ask(prompt: string, digest: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim() === digest.slice(0, 8);
  } finally {
    rl.close();
  }
}

export function terminalConfirmers(line: (s: string) => void) {
  return {
    async confirmApproval(s: ApprovalSummary) {
      line('\n--- APPROVAL (no quote exists yet; nothing else will be sent) ---');
      line(`token     : ${s.token}`);
      line(`spender   : ${s.spender}   (the verified Textile reactor)`);
      line(`amount    : exactly ${s.amountAtomic} atomic (no unlimited allowance)`);
      line(`allowance : currently ${s.currentAllowanceAtomic}`);
      line(`why       : ${s.reason}`);
      for (const st of s.steps) line(`  tx        : ${st.kind} -> ${st.to}`);
      for (const sim of s.simulations) line(`  simulated : ${sim.step}: ${sim.verdict} (tagged ${sim.tagged}; untagged ${sim.untagged})`);
      line(`gas est.  : ${s.gas.estimatedCostWei} wei of ${s.gas.nativeBalanceWei} wei CELO`);
      line(`tag       : ${s.attributionTag}`);
      line(`digest    : ${s.digest}`);
      const ok = await ask('Type the first 8 characters of the digest to authorize the APPROVAL (anything else cancels): ', s.digest);
      return ok ? { approved: true, approvedBy: 'human:typed-digest(approval)' } : { approved: false };
    },
    async confirm(s: SwapSummary) {
      line('\n--- FIRM QUOTE VALIDATED AND SIMULATED. Review the exact swap ---');
      line(`sell     : ${s.sell}`);
      line(`receive  : ${s.receive}`);
      line(`fee      : ${s.fee}`);
      line(`expires  : ${s.expiresAt} (${s.secondsRemaining}s left: be quick)`);
      line(`why      : ${s.sequenceReason}`);
      for (const st of s.steps) line(`  tx       : ${st.kind} -> ${st.to}`);
      for (const sim of s.simulations) line(`  simulated: ${sim.step}: ${sim.verdict} (tagged ${sim.tagged}; untagged ${sim.untagged})`);
      line(`gas est. : ${s.gas.estimatedCostWei} wei of ${s.gas.nativeBalanceWei} wei CELO`);
      line(`tag      : ${s.attributionTag}`);
      line(`digest   : ${s.digest}`);
      const ok = await ask('Type the first 8 characters of the digest to authorize the SWAP (anything else cancels): ', s.digest);
      return ok ? { approved: true, approvedBy: 'human:typed-digest(swap)' } : { approved: false };
    },
  };
}
