// Textile LimitOrderReactor interface, taken ONLY from the contract's verified source on Blockscout
// (0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3; ReactorStructs.sol, LimitOrderLib.sol, ReactorEvents.sol).
// Nothing here is guessed. If a live quote does not decode with these definitions, validation FAILS CLOSED.
//
// How a fill works (from the verified source): the order is signed by the MAKER (the "swapper"). The taker
// calls execute(SignedOrder); the reactor pulls the order's `input` (the maker's tokens) from the maker via
// Permit2 and sends them to msg.sender (the taker), and pays each `output` (the taker's sell token) from
// msg.sender to its recipient with transferFrom. That transferFrom is why the TAKER must approve the reactor.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, getAddress, parseAbiItem, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';

export const executeAbi = [
  {
    inputs: [
      {
        components: [
          { internalType: 'bytes', name: 'order', type: 'bytes' },
          { internalType: 'bytes', name: 'sig', type: 'bytes' },
        ],
        internalType: 'struct SignedOrder',
        name: 'order',
        type: 'tuple',
      },
    ],
    name: 'execute',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export const EXECUTE_SELECTOR: Hex = toFunctionSelector(executeAbi[0]);

/**
 * executeBatch(SignedOrder[] orders), selector 0x0d7a16c3, from the verified reactor ABI. Textile's firm quote
 * puts its single order through executeBatch ("always execute transactions.swap, which already batches this
 * list"), so a one-element batch is a normal quote. A batch of any other size is NOT accepted here.
 */
export const executeBatchAbi = [
  {
    inputs: [
      {
        components: [
          { internalType: 'bytes', name: 'order', type: 'bytes' },
          { internalType: 'bytes', name: 'sig', type: 'bytes' },
        ],
        internalType: 'struct SignedOrder[]',
        name: 'orders',
        type: 'tuple[]',
      },
    ],
    name: 'executeBatch',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export const EXECUTE_BATCH_SELECTOR: Hex = toFunctionSelector(executeBatchAbi[0]);

/** Decode the signed orders from `execute(...)` (one) or `executeBatch(...)` (any number). Throws otherwise. */
export function decodeSwapOrders(data: Hex): DecodedExecute[] {
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === EXECUTE_SELECTOR.toLowerCase()) {
    const [signed] = decodeFunctionData({ abi: executeAbi, data }).args;
    return [{ order: signed.order, sig: signed.sig }];
  }
  if (sel === EXECUTE_BATCH_SELECTOR.toLowerCase()) {
    const [orders] = decodeFunctionData({ abi: executeBatchAbi, data }).args;
    return orders.map((o) => ({ order: o.order, sig: o.sig }));
  }
  throw new Error(`selector ${sel} is neither execute nor executeBatch`);
}

/** struct LimitOrder { OrderInfo info; InputToken input; OutputToken[] outputs; } (LimitOrderLib.sol) */
export const limitOrderType = [
  {
    type: 'tuple',
    components: [
      {
        name: 'info',
        type: 'tuple',
        components: [
          { name: 'reactor', type: 'address' },
          { name: 'swapper', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'additionalValidationContract', type: 'address' },
          { name: 'additionalValidationData', type: 'bytes' },
        ],
      },
      {
        name: 'input',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'maxAmount', type: 'uint256' },
        ],
      },
      {
        name: 'outputs',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      },
    ],
  },
] as const;

/** event Fill(bytes32 indexed orderHash, address indexed filler, address indexed swapper, uint256 nonce) */
export const fillEvent = parseAbiItem(
  'event Fill(bytes32 indexed orderHash, address indexed filler, address indexed swapper, uint256 nonce)',
);

export interface DecodedLimitOrder {
  reactor: Address;
  swapper: Address;
  nonce: bigint;
  deadline: bigint;
  validationContract: Address;
  validationData: Hex;
  input: { token: Address; amount: bigint; maxAmount: bigint };
  outputs: Array<{ token: Address; amount: bigint; recipient: Address }>;
}

export interface DecodedExecute {
  order: Hex;
  sig: Hex;
}

/** Decode `execute((bytes order, bytes sig))` calldata. Throws if it is anything else. */
export function decodeExecute(data: Hex): DecodedExecute {
  const d = decodeFunctionData({ abi: executeAbi, data });
  const [signed] = d.args;
  return { order: signed.order, sig: signed.sig };
}

export function decodeLimitOrder(order: Hex): DecodedLimitOrder {
  const [o] = decodeAbiParameters(limitOrderType, order);
  return {
    reactor: getAddress(o.info.reactor),
    swapper: getAddress(o.info.swapper),
    nonce: o.info.nonce,
    deadline: o.info.deadline,
    validationContract: getAddress(o.info.additionalValidationContract),
    validationData: o.info.additionalValidationData,
    input: { token: getAddress(o.input.token), amount: o.input.amount, maxAmount: o.input.maxAmount },
    outputs: o.outputs.map((x) => ({ token: getAddress(x.token), amount: x.amount, recipient: getAddress(x.recipient) })),
  };
}

/** Test/fixture helper: the exact inverse of decodeLimitOrder. */
export function encodeLimitOrder(o: DecodedLimitOrder): Hex {
  return encodeAbiParameters(limitOrderType, [
    {
      info: {
        reactor: o.reactor,
        swapper: o.swapper,
        nonce: o.nonce,
        deadline: o.deadline,
        additionalValidationContract: o.validationContract,
        additionalValidationData: o.validationData,
      },
      input: o.input,
      outputs: o.outputs,
    },
  ]);
}
