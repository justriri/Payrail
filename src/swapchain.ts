// Production SwapChain adapter (viem). IMPLEMENTED BUT NOT EXERCISED: no live transaction has ever been
// signed or sent through it. It is type-checked, and the pipeline above it is tested with mocks only.
//
// Safety properties:
//   * prepare() accepts ONLY steps built by buildSequence() (checked with isValidatedStep), which are
//     already tagged and verified, so there is no way to sign arbitrary calldata through this adapter.
//   * the transaction hash is computed locally from the signed bytes BEFORE broadcast, so the caller can
//     journal it first (a crash can never lose track of a possibly-sent transaction).
import { createPublicClient, encodeAbiParameters, erc20Abi, getAddress, http, keccak256, pad, parseEventLogs, toHex } from 'viem';
import { createProductionChainReads, readTransport, rpcUrlList } from './chainread.ts';
import type { Address, Hex, LocalAccount } from 'viem';
import { celo } from 'viem/chains';
import { fillEvent } from './reactor.ts';
import { isValidatedStep } from './swapquote.ts';
import type { SwapChain } from './swapexec.ts';

export function createSwapChain(opts: { account: LocalAccount; rpcUrl?: string; rpcFallbackUrls?: readonly string[] }): SwapChain {
  // Reads fail over between endpoints; BROADCAST goes to the primary only (one signed tx, one submitter).
  const client = createPublicClient({ chain: celo, transport: readTransport(rpcUrlList(opts.rpcUrl, opts.rpcFallbackUrls)) });
  const sendClient = createPublicClient({ chain: celo, transport: http(opts.rpcUrl) });
  const reads = createProductionChainReads(opts.rpcUrl, opts.rpcFallbackUrls);
  const { account } = opts;

  return {
    chainId: () => client.getChainId(),
    tokenBalance: (token, owner) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    allowanceAt: (token, owner, spender, blockNumber) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender], blockNumber }),
    nativeBalanceAt: (owner, blockNumber) => client.getBalance({ address: owner, blockNumber }),
    tokenBalanceAt: (token, owner, blockNumber) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber }),
    allowance: (token, owner, spender) => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    nativeBalance: (owner) => client.getBalance({ address: owner }),
    gasPrice: () => client.getGasPrice(),

    async simulate({ from, to, data }) {
      try {
        const r = await client.call({ account: from, to, data });
        let gas: bigint | undefined;
        try {
          gas = await client.estimateGas({ account: from, to, data });
        } catch {
          gas = undefined;
        }
        return { ok: true, returnData: (r.data ?? '0x') as Hex, gas };
      } catch (e) {
        return { ok: false, error: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200) };
      }
    },

    /**
     * Read-only: simulate `call` as if `spender` had `amount` allowance, by overriding the token's allowance
     * storage for this one eth_call. The slot is DISCOVERED (not assumed): a candidate mapping position is
     * accepted only if overriding it makes allowance(owner, spender) read back exactly the injected value.
     * Returns { unsupported: true } if the node rejects overrides or no known layout matches.
     */
    async simulateWithAllowance(call, a) {
      const inject = pad(toHex(a.amount * 2n));
      const abiAllowance = [
        { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
      ] as const;
      const erc7201 = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00') + 1n;
      const positions: bigint[] = [];
      for (let i = 0n; i <= 12n; i++) positions.push(i);
      for (let i = 50n; i <= 60n; i++) positions.push(i);
      positions.push(erc7201);
      let slot: Hex | undefined;
      for (const p of positions) {
        const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a.owner, p]));
        const candidate = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [a.spender, inner]));
        try {
          const seen = await client.readContract({
            address: a.token,
            abi: abiAllowance,
            functionName: 'allowance',
            args: [a.owner, a.spender],
            stateOverride: [{ address: a.token, stateDiff: [{ slot: candidate, value: inject }] }],
          });
          if (seen === a.amount * 2n) {
            slot = candidate;
            break;
          }
        } catch {
          return { unsupported: true };
        }
      }
      if (!slot) return { unsupported: true };
      try {
        const r = await client.call({
          account: call.from,
          to: call.to,
          data: call.data,
          stateOverride: [{ address: a.token, stateDiff: [{ slot, value: inject }] }],
        });
        return { ok: true, returnData: (r.data ?? '0x') as Hex, gas: undefined };
      } catch (e) {
        return { ok: false, error: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200) };
      }
    },

    async prepare(step, from) {
      if (!isValidatedStep(step)) throw new Error('refusing to sign: not a validated, tagged sequence step');
      if (from.toLowerCase() !== account.address.toLowerCase()) throw new Error('signer does not match the planned wallet');
      const [nonce, fees, gasEst] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        client.estimateFeesPerGas(),
        client.estimateGas({ account, to: step.to, data: step.taggedData }),
      ]);
      const serialized = await account.signTransaction({
        type: 'eip1559',
        chainId: celo.id,
        to: step.to,
        data: step.taggedData,
        value: 0n,
        nonce,
        gas: (gasEst * 120n) / 100n,
        maxFeePerGas: fees.maxFeePerGas!,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
      });
      return {
        hash: keccak256(serialized),
        nonce,
        broadcast: () => sendClient.sendRawTransaction({ serializedTransaction: serialized }),
      };
    },

    async getReceipt(hash) {
      // Absence here means "unknown", never "failed": the lookup retries across endpoints, and anything but a
      // validated receipt (not mined yet, pruned on some nodes, RPC error) is returned as unknown.
      const lk = await reads.lookupReceipt(hash, { attempts: 3 });
      if (lk.kind !== 'found') return undefined;
      const r = lk.receipt as unknown as Awaited<ReturnType<typeof client.getTransactionReceipt>>;
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs }).map((l) => ({
        token: getAddress(l.address),
        from: getAddress(l.args.from),
        to: getAddress(l.args.to),
        value: l.args.value,
      }));
      const fills = parseEventLogs({ abi: [fillEvent], eventName: 'Fill', logs: r.logs }).map((l) => ({
        reactor: getAddress(l.address),
        filler: getAddress(l.args.filler as Address),
        swapper: getAddress(l.args.swapper as Address),
      }));
      return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, transfers, fills };
    },

    async getTransaction(hash) {
      const lk = await reads.lookupTransaction(hash, { attempts: 3 });
      if (lk.kind !== 'found') return undefined;
      const t = lk.tx as unknown as Awaited<ReturnType<typeof client.getTransaction>>;
      return { from: getAddress(t.from), to: t.to ? getAddress(t.to) : null, input: t.input, value: t.value };
    },
  };
}
