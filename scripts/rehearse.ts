// Payrail read-only rehearsal: cNGN -> USDT readiness check on Celo mainnet.
//
// SAFETY: this script never signs or broadcasts a transaction, never sends an approval, never calls
// Buy's paid flow, and never transfers funds. The only thing it can sign is the EIP-712 "Textile
// Taker Control" identity proof (it cannot move funds), and only when a key is configured and the
// wallet holds enough cNGN. All chain interaction is eth_call / balance reads.
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  pad,
  parseUnits,
  toHex,
} from 'viem';
import type { Address, Hex } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { toDataSuffix } from '@celo/attribution-tags';
import { assertTagged, withTag } from '../src/attribution.ts';
import { CELO_MAINNET_CHAIN_ID, ConfigError, PERMIT2, TEXTILE_REACTOR, loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { TextileError, firmQuote, getPairLevel, preview } from '../src/textile.ts';
import type { FirmQuoteResult, PreviewResult } from '../src/textile.ts';

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'INCONCLUSIVE' | 'INFO';
const results: Array<{ section: string; status: Status; detail: string }> = [];
let section = '';

function heading(title: string): void {
  section = title;
  console.log(`\n=== ${title} ===`);
}
function note(text: string): void {
  console.log(`  ${text}`);
}
function record(status: Status, detail: string): void {
  results.push({ section, status, detail });
  console.log(`  [${status}] ${detail}`);
}
function fmt(v: bigint, decimals: number): string {
  return formatUnits(v, decimals);
}
function errText(e: unknown): string {
  if (e instanceof Error) {
    const short = (e as Error & { shortMessage?: string }).shortMessage;
    return (short ?? e.message).split('\n')[0].slice(0, 240);
  }
  return String(e).slice(0, 240);
}

// ------------------------------------------------------------------ 1. configuration
heading('1. Configuration');
let cfg: Config;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    for (const p of e.problems) console.log(`  [FAIL] ${p}`);
    console.log('\nRefusing to run: fix the configuration above. Nothing was contacted.');
    process.exit(1);
  }
  throw e;
}
const { tokens } = cfg;

// State shared with finish(); declared up front so an early stop can still print a report.
const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
const walletAddress: Address | undefined = account?.address ?? cfg.walletAddress;
const sellAmount = parseUnits(cfg.sellAmountCngn, tokens.cNGN.decimals);
let cngnBalance: bigint | undefined;
let fq: Extract<FirmQuoteResult, { kind: 'quoted' }> | undefined;
let instructionsOk = false;
let gateOk = true;
let tagGateOnInstructions = false;
let approvalSim: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'SKIP' = 'SKIP';
let swapSim: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'SKIP' = 'SKIP';

record('PASS', `attribution tag matches the official tag (${cfg.attributionTag})`);
record('PASS', `configured network is Celo mainnet (chain ID ${cfg.chainId})`);
record('PASS', 'token addresses equal the verified Celo mainnet addresses:');
for (const t of Object.values(tokens)) note(`${t.symbol.padEnd(5)} ${t.address} (${t.decimals} decimals) - ${t.source}`);
note(`wallet key: ${cfg.privateKey ? 'present (never shown)' : 'not configured'}`);

const client = createPublicClient({ chain: celo, transport: http(cfg.rpcUrl) });

// RPC network + on-chain token sanity (read-only).
let rpcOk = false;
try {
  const id = await client.getChainId();
  if (id === CELO_MAINNET_CHAIN_ID) {
    record('PASS', `RPC reports chain ID ${id}`);
    rpcOk = true;
  } else {
    record('FAIL', `RPC reports chain ID ${id}, expected ${CELO_MAINNET_CHAIN_ID}. Stopping.`);
  }
} catch (e) {
  record('FAIL', `cannot reach the Celo RPC: ${errText(e)}`);
}
if (!rpcOk) finish();

for (const t of Object.values(tokens)) {
  try {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: t.address, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: t.address, abi: erc20Abi, functionName: 'symbol' }),
    ]);
    if (decimals === t.decimals) {
      record('PASS', `on-chain ${t.symbol}: symbol()="${symbol}", decimals()=${decimals} (matches expected)`);
    } else {
      record('FAIL', `on-chain ${t.symbol}: decimals()=${decimals}, expected ${t.decimals}. Do not proceed.`);
    }
  } catch (e) {
    record('FAIL', `could not read ${t.symbol} on-chain: ${errText(e)}`);
  }
}

// ------------------------------------------------------------------ 2. wallet
heading('2. Wallet');
note('What each stage needs:');
note(`- Firm quote (this rehearsal): at least ${cfg.sellAmountCngn} cNGN in the wallet. No CELO needed (nothing is sent).`);
note('- Funded rehearsal (later, separate approval): the same cNGN, plus a small CELO balance for the');
note('  approve and swap gas. cNGN is not a fee currency; USDT or USDC could pay gas instead.');
note('- Paying a Buy service afterwards needs no gas: USDT/USDC/USAT is signed, the gateway submits it.');

if (walletAddress === undefined) {
  record('SKIP', 'no wallet configured (set PAYRAIL_WALLET_ADDRESS or PAYRAIL_PRIVATE_KEY): balance checks skipped');
} else {
  note(`wallet address: ${walletAddress}`);
  try {
    const [cngn, usdt, usdc, celoBal] = await Promise.all([
      client.readContract({ address: tokens.cNGN.address, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress] }),
      client.readContract({ address: tokens.USDT.address, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress] }),
      client.readContract({ address: tokens.USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress] }),
      client.getBalance({ address: walletAddress }),
    ]);
    cngnBalance = cngn;
    note(`cNGN : ${fmt(cngn, tokens.cNGN.decimals)}`);
    note(`USDT : ${fmt(usdt, tokens.USDT.decimals)}`);
    note(`USDC : ${fmt(usdc, tokens.USDC.decimals)}`);
    note(`CELO : ${fmt(celoBal, 18)}`);
    if (cngn >= sellAmount) record('PASS', `cNGN balance covers the ${cfg.sellAmountCngn} cNGN sell amount`);
    else record('FAIL', `cNGN balance ${fmt(cngn, 6)} is below the ${cfg.sellAmountCngn} cNGN sell amount`);
    if (celoBal === 0n && usdt === 0n && usdc === 0n) {
      record('INFO', 'no gas asset yet (no CELO/USDT/USDC): needed before the funded rehearsal, not for this one');
    }
  } catch (e) {
    record('FAIL', `balance read failed: ${errText(e)}`);
  }
}

// ------------------------------------------------------------------ 3. textile preview
heading('3. Textile FX preview (indicative)');
note('A preview is NOT a firm quote: it is priced from the makers\' latest levels, can be a few seconds');
note('stale, is not bound to any wallet, and does not reserve any liquidity.');
let pv: PreviewResult | undefined;
try {
  const level = await getPairLevel(cfg.chainId, tokens.cNGN.address, tokens.USDT.address);
  if (level) {
    note(
      `live ladder: min sell ${fmt(level.minSellAmount, 6)} cNGN, max ${fmt(level.maxSellAmount, 6)} cNGN, ${level.levelCount} price levels`,
    );
    if (sellAmount < level.minSellAmount) {
      record('FAIL', `requested ${cfg.sellAmountCngn} cNGN is below the live minimum of ${fmt(level.minSellAmount, 6)} cNGN`);
    }
  } else {
    record('FAIL', 'cNGN -> USDT is not listed (or has no liquidity) on the live Celo ladder');
  }
  pv = await preview({
    chainId: cfg.chainId,
    sellToken: tokens.cNGN.address,
    buyToken: tokens.USDT.address,
    sellAmount,
  });
  if (pv.kind === 'no_quote') {
    record('FAIL', `Textile returned no quote (reason: ${pv.reason ?? 'not given'}). Stopping before any firm quote.`);
    pv = undefined;
  } else {
    const sell = Number(fmt(pv.sellAmount, 6));
    const buy = Number(fmt(pv.buyAmount, 6));
    note(`requested sell        : ${fmt(pv.sellAmount, 6)} cNGN`);
    note(`estimated receive     : ${fmt(pv.buyAmount, 6)} USDT`);
    note(`fee (already included): ${fmt(pv.feeAmount, 6)} cNGN`);
    note(`taker pays in total   : ${fmt(pv.takerPays, 6)} cNGN`);
    note(`rate                  : ${(buy / sell).toFixed(8)} USDT per cNGN  (~${(sell / buy).toFixed(2)} cNGN per USDT)`);
    note(`available sell amount : ${pv.availableSellAmount !== undefined ? fmt(pv.availableSellAmount, 6) + ' cNGN' : 'not reported'}`);
    note(`API rate limit left   : ${pv.rateRemaining ?? 'unknown'}  | request id: ${pv.requestId ?? 'n/a'}`);
    if (buy > 0) record('PASS', `preview returned ~${buy.toFixed(6)} USDT for ${sell} cNGN (indicative only)`);
    else record('FAIL', 'preview returned zero USDT');
  }
} catch (e) {
  if (e instanceof TextileError) {
    record('FAIL', `Textile preview error: ${e.code}${e.reason ? '/' + e.reason : ''} (HTTP ${e.httpStatus}): ${e.message}`);
  } else {
    record('FAIL', `Textile preview failed: ${errText(e)}`);
  }
}

// ------------------------------------------------------------------ 4. firm quote
heading('4. Textile FX firm quote');
note('A firm quote is a real request to market makers: it reserves inventory until it lapses and uses one');
note('of the 4 concurrent quote slots. It is bound to your wallet and cannot be filled by anyone else.');
const gate: string[] = [];
if (pv === undefined) gate.push('the preview did not succeed');
if (account === undefined) gate.push('no private key configured (needed to sign the EIP-712 identity proof)');
if (account !== undefined && cngnBalance === undefined) gate.push('wallet balance could not be read');
if (cngnBalance !== undefined && cngnBalance < sellAmount) {
  gate.push(`cNGN balance (${fmt(cngnBalance, 6)}) is below the sell amount (${cfg.sellAmountCngn}); Textile would answer insufficient_funds`);
}

if (gate.length > 0 || account === undefined) {
  record('SKIP', 'firm quote not attempted:');
  for (const g of gate) note(`- ${g}`);
} else {
  try {
    const nonce = toHex(randomBytes(32));
    const issuedAt = Date.now();
    const signature = await account.signTypedData({
      domain: { name: 'Textile Taker Control', version: '1', chainId: cfg.chainId },
      types: {
        TakerControl: [
          { name: 'taker', type: 'address' },
          { name: 'chainId', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'issuedAt', type: 'uint256' },
        ],
      },
      primaryType: 'TakerControl',
      message: { taker: account.address, chainId: BigInt(cfg.chainId), nonce, issuedAt: BigInt(issuedAt) },
    });
    note('signed the EIP-712 identity proof (cannot move funds). Requesting firm quote (up to 75s)...');
    const r = await firmQuote({
      chainId: cfg.chainId,
      sellToken: tokens.cNGN.address,
      buyToken: tokens.USDT.address,
      sellAmount,
      taker: account.address,
      takerProof: { nonce, issuedAt, signature },
    });
    if (r.kind === 'no_quote') {
      record('FAIL', `Textile returned no firm quote (reason: ${r.reason ?? 'not given'}); nothing was reserved`);
    } else {
      fq = r;
      record('PASS', 'firm quote obtained (NOT executed; nothing was signed or sent)');
      note(`quote id          : ${r.id}  (field "${r.idField}")`);
      note(`status            : ${r.status}`);
      note(`sell amount       : ${fmt(r.sellAmount, 6)} cNGN`);
      note(`expected receive  : ${fmt(r.buyAmount, 6)} USDT`);
      note(`fee               : ${fmt(r.feeAmount, 6)} cNGN`);
      note(`taker pays total  : ${fmt(r.takerPays, 6)} cNGN`);
      note(`deadlines (raw)   : ${JSON.stringify(r.deadlines)}`);
      note(`approval target   : ${r.approval.to}`);
      note(`swap target       : ${r.swap.to}`);
      note(`quote.reactor     : ${r.reactor}`);
      note(`claim token       : ${r.hasClaimToken ? 'received (not displayed, not stored)' : 'MISSING'}`);
      note(`response keys     : ${r.topLevelKeys.join(', ')}`);
      note(`quote keys        : ${r.quoteKeys.join(', ')}`);
      for (const n of r.notes) note(`documentation difference: ${n}`);
      if (!r.hasClaimToken) record('FAIL', 'claim token missing; cancel/status could not be authorised');
    }
  } catch (e) {
    if (e instanceof TextileError) {
      record('FAIL', `firm quote error: ${e.code}${e.reason ? '/' + e.reason : ''} (HTTP ${e.httpStatus}): ${e.message}`);
      if (e.details) note(`details: ${JSON.stringify(e.details).slice(0, 400)}`);
    } else {
      record('FAIL', `firm quote failed: ${errText(e)}`);
    }
  }
}

// ------------------------------------------------------------------ 5. instruction checks
heading('5. Returned transactions (allow-list checks)');
let approvalSpender: Address | undefined;
if (fq === undefined) {
  record('SKIP', 'no firm quote, so there are no approval/swap transactions to inspect');
} else {
  const problems: string[] = [];
  if (fq.approval.chainId !== cfg.chainId) problems.push(`approval chainId ${fq.approval.chainId}`);
  if (fq.swap.chainId !== cfg.chainId) problems.push(`swap chainId ${fq.swap.chainId}`);
  if (fq.approval.value !== '0') problems.push(`approval value ${fq.approval.value} (expected 0)`);
  if (fq.swap.value !== '0') problems.push(`swap value ${fq.swap.value} (expected 0)`);
  if (fq.approval.to.toLowerCase() !== tokens.cNGN.address.toLowerCase()) {
    problems.push(`approval target ${fq.approval.to} is not the cNGN token`);
  }
  if (fq.reactor.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) {
    problems.push(`quote.reactor ${fq.reactor} is not the known Textile LimitOrderReactor`);
  }
  if (fq.swap.to.toLowerCase() !== TEXTILE_REACTOR.toLowerCase()) {
    problems.push(`swap target ${fq.swap.to} is not the known Textile LimitOrderReactor`);
  }
  if (account && fq.taker.toLowerCase() !== account.address.toLowerCase()) {
    problems.push(`quote taker ${fq.taker} is not this wallet`);
  }
  try {
    const dec = decodeFunctionData({ abi: erc20Abi, data: fq.approval.data });
    if (dec.functionName !== 'approve') {
      problems.push(`approval calldata calls ${dec.functionName}, not approve`);
    } else {
      const [spender, amount] = dec.args as readonly [Address, bigint];
      approvalSpender = getAddress(spender);
      note(`approve(spender=${spender}, amount=${fmt(amount, 6)} cNGN)`);
      const okSpender =
        spender.toLowerCase() === fq.reactor.toLowerCase() || spender.toLowerCase() === PERMIT2.toLowerCase();
      if (!okSpender) problems.push(`approval spender ${spender} is neither the reactor nor canonical Permit2`);
      if (amount !== fq.takerPays) {
        problems.push(`approval amount ${fmt(amount, 6)} differs from takerPays ${fmt(fq.takerPays, 6)} (no unlimited approvals)`);
      }
    }
  } catch (e) {
    problems.push(`approval calldata could not be decoded: ${errText(e)}`);
  }
  note(`swap calldata: ${(fq.swap.data.length - 2) / 2} bytes, selector ${fq.swap.data.slice(0, 10)}`);
  if (problems.length === 0) {
    instructionsOk = true;
    record('PASS', 'approval and swap instructions match the documented, allow-listed contracts and amounts');
  } else {
    for (const p of problems) record('FAIL', p);
    note('Stopping: unrecognised instructions must never be signed.');
  }
}

// ------------------------------------------------------------------ 6. attribution
heading('6. Attribution (ERC-8021, @celo/attribution-tags)');
const plainData = '0x095ea7b3' as Hex; // placeholder calldata head for negative tests
const stub = (plainData + '00'.repeat(64)) as Hex;
const negative: Array<[string, () => string]> = [
  ['missing tag', () => stub],
  ['wrong tag', () => withTagUnsafe(stub, 'celo_000000000000')],
  ['multiple tags (stacked)', () => withTagUnsafe(withTagUnsafe(stub, cfg.attributionTag), cfg.attributionTag)],
  ['two codes in one suffix', () => withTagUnsafe(stub, [cfg.attributionTag, 'minipay'])],
  ['malformed suffix', () => stub + '1234' + '80218021802180218021802180218021'],
  ['tag not at the end', () => withTagUnsafe(stub, cfg.attributionTag) + '00'],
];
for (const [label, build] of negative) {
  try {
    assertTagged(build(), cfg.attributionTag);
    record('FAIL', `gate did NOT block: ${label}`);
    gateOk = false;
  } catch {
    note(`blocked as required: ${label}`);
  }
}
try {
  const good = withTag(stub, cfg.attributionTag);
  assertTagged(good, cfg.attributionTag);
  note('accepted as required: exactly one correct tag at the end');
} catch (e) {
  record('FAIL', `gate rejected a correctly tagged payload: ${errText(e)}`);
  gateOk = false;
}
if (gateOk) record('PASS', 'attribution gate accepts the exact tag and rejects missing/wrong/multiple/malformed suffixes');

// Helper that builds an untrusted tagged payload without the safety assertion (negative tests only).
function withTagUnsafe(data: string, code: string | string[]): string {
  return data + toDataSuffix(code).slice(2);
}

// Real instructions: tag them, then simulate tagged vs untagged (read-only eth_call).
interface SimResult {
  ok: boolean;
  returnData?: Hex;
  error?: string;
}
async function simulate(from: Address, to: Address, data: Hex, override?: Hex[]): Promise<SimResult> {
  try {
    const r = await client.call({
      account: from,
      to,
      data,
      ...(override
        ? { stateOverride: [{ address: tokens.cNGN.address, stateDiff: override.map((slot) => ({ slot, value: pad(toHex(sellAmount * 2n)) })) }] }
        : {}),
    });
    return { ok: true, returnData: r.data ?? '0x' };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
function compare(label: string, a: SimResult, b: SimResult): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (a.ok && b.ok) {
    if (a.returnData === b.returnData) {
      record('PASS', `${label}: untagged and tagged simulations succeed with identical output (${a.returnData?.slice(0, 66)})`);
      return 'PASS';
    }
    record('FAIL', `${label}: both succeed but outputs DIFFER (untagged ${a.returnData}, tagged ${b.returnData})`);
    return 'FAIL';
  }
  if (a.ok !== b.ok) {
    record('FAIL', `${label}: untagged ${a.ok ? 'succeeds' : 'fails (' + a.error + ')'}, tagged ${b.ok ? 'succeeds' : 'fails (' + b.error + ')'}`);
    return 'FAIL';
  }
  record('INCONCLUSIVE', `${label}: both fail identically (${a.error}); this says nothing about the tag`);
  return 'INCONCLUSIVE';
}

heading('7. Tagged vs untagged simulation (eth_call, nothing sent)');
if (fq === undefined || !instructionsOk) {
  record('SKIP', 'no verified firm-quote instructions to simulate');
} else {
  const taker = fq.taker;
  try {
    const approvalTagged = withTag(fq.approval.data, cfg.attributionTag);
    const swapTagged = withTag(fq.swap.data, cfg.attributionTag);
    let untaggedRejected = true;
    for (const d of [fq.approval.data, fq.swap.data]) {
      try {
        assertTagged(d, cfg.attributionTag);
        untaggedRejected = false;
      } catch {
        /* expected */
      }
    }
    tagGateOnInstructions = untaggedRejected;
    record(
      untaggedRejected ? 'PASS' : 'FAIL',
      untaggedRejected
        ? 'tagged calldata for approval and swap passes the gate; the untagged originals are blocked'
        : 'an untagged original passed the gate (unexpected)',
    );

    // Approval: valid to simulate directly (approve does not depend on prior allowance).
    const a1 = await simulate(taker, fq.approval.to, fq.approval.data);
    const a2 = await simulate(taker, fq.approval.to, approvalTagged);
    approvalSim = compare('approval', a1, a2);

    // Swap: needs an existing allowance, otherwise both variants revert for the same unrelated reason.
    const spender = approvalSpender ?? fq.reactor;
    const allowance = await client.readContract({
      address: tokens.cNGN.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [taker, spender],
    });
    let override: Hex[] | undefined;
    if (allowance >= fq.takerPays) {
      note(`existing allowance ${fmt(allowance, 6)} cNGN already covers the swap: simulating directly`);
    } else {
      note(`current allowance is ${fmt(allowance, 6)} cNGN; the swap would revert before approval in both variants.`);
      note('trying a read-only state override of the allowance slot (needs RPC support; may not work)...');
      const base7201 = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00') + 1n;
      const candidates: bigint[] = [];
      for (let i = 0n; i <= 12n; i++) candidates.push(i);
      for (let i = 50n; i <= 60n; i++) candidates.push(i);
      candidates.push(base7201);
      const injected = pad(toHex(sellAmount * 2n));
      for (const p of candidates) {
        const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [taker, p]));
        const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]));
        try {
          const probe = await client.readContract({
            address: tokens.cNGN.address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [taker, spender],
            stateOverride: [{ address: tokens.cNGN.address, stateDiff: [{ slot, value: injected }] }],
          });
          if (probe === sellAmount * 2n) {
            override = [slot];
            note(`found allowance storage slot (mapping position ${p === base7201 ? 'ERC-7201 namespaced' : p})`);
            break;
          }
        } catch (e) {
          note(`state override not usable on this RPC: ${errText(e)}`);
          break;
        }
      }
    }
    if (allowance < fq.takerPays && override === undefined) {
      record(
        'INCONCLUSIVE',
        'swap: could not simulate before approval (no allowance and no usable state override). NOT verified.',
      );
      swapSim = 'INCONCLUSIVE';
    } else {
      const s1 = await simulate(taker, fq.swap.to, fq.swap.data, override);
      const s2 = await simulate(taker, fq.swap.to, swapTagged, override);
      swapSim = compare(override ? 'swap (simulated allowance)' : 'swap', s1, s2);
    }
  } catch (e) {
    record('FAIL', `simulation stage error: ${errText(e)}`);
  }
}

finish();

// ------------------------------------------------------------------ 8. final report
function finish(): never {
  heading('FINAL REPORT');
  const by = (s: string) => results.filter((r) => r.section.startsWith(s));
  const has = (rs: typeof results, st: Status) => rs.some((r) => r.status === st);

  console.log('\nSection results:');
  for (const sec of [...new Set(results.map((r) => r.section))]) {
    const rs = results.filter((r) => r.section === sec);
    const worst = has(rs, 'FAIL') ? 'FAIL' : has(rs, 'INCONCLUSIVE') ? 'INCONCLUSIVE' : has(rs, 'SKIP') ? 'SKIP' : 'PASS';
    console.log(`  ${worst.padEnd(12)} ${sec}`);
  }

  const missing: string[] = [];
  if (!cfgOk()) missing.push('valid configuration');
  if (account === undefined) missing.push('a dedicated rehearsal wallet key outside OneDrive (PAYRAIL_PRIVATE_KEY via --env-file)');
  if (cngnBalance === undefined || cngnBalance < sellAmount) missing.push(`at least ${cfg.sellAmountCngn} cNGN in that wallet`);
  if (fq === undefined) missing.push('a firm quote (blocked by the items above)');
  if (swapSim !== 'PASS') missing.push('a passing tagged swap simulation (needs the approval mined first, or a usable state override)');
  missing.push('organizer answers: Build with Buy requirements, ERC-8004, multi-track, attribution evidence for untagged x402');
  missing.push('a small CELO (or USDT/USDC) balance for gas in the funded rehearsal');

  const hardFail = results.some((r) => r.status === 'FAIL');
  const allVerified =
    !hardFail && fq !== undefined && instructionsOk && gateOk && tagGateOnInstructions && approvalSim === 'PASS' && swapSim === 'PASS';

  console.log('\nMissing prerequisites / unverified items:');
  for (const m of missing) console.log(`  - ${m}`);

  console.log('\nVerdict:');
  if (hardFail) {
    console.log('  NOT READY: at least one check failed. Resolve the FAIL items above. Do not proceed.');
  } else if (allVerified) {
    console.log('  READY for a separate, separately approved funded rehearsal.');
  } else {
    console.log('  NOT YET READY: the checks that ran passed, but required checks have not run or are inconclusive.');
  }
  console.log('\nReminder: no transaction was signed or broadcast. Only previews, reads and simulations ran, so this');
  console.log('does NOT show the flow works end to end. The Buy payment and the swap itself remain unexercised.');
  process.exit(hardFail ? 2 : 0);

  function cfgOk(): boolean {
    return by('1.').every((r) => r.status !== 'FAIL');
  }
}
