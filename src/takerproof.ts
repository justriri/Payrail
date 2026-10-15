// Textile "TakerControl" proof: an EIP-712 signature by the TAKER wallet over (taker, chainId, nonce, issuedAt), domain
// { name: "Textile Taker Control", version: "1", chainId }. Textile binds a firm quote to the wallet that signs this.
//
// This module only BUILDS the typed data and VERIFIES a signature. It signs nothing and sends nothing. The server uses it
// to check that a buyer's browser wallet can produce the authorization Textile requires, without any key on the server.
import { verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';

export const TAKER_CONTROL_TYPES = {
  TakerControl: [
    { name: 'taker', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

export function takerControlTypedData(taker: Address, chainId: number, nonce: Hex, issuedAtMs: number) {
  return {
    domain: { name: 'Textile Taker Control', version: '1', chainId },
    types: TAKER_CONTROL_TYPES,
    primaryType: 'TakerControl' as const,
    message: { taker, chainId: BigInt(chainId), nonce, issuedAt: BigInt(issuedAtMs) },
  };
}

/** True only if `signature` was produced by `taker` over exactly this typed data. */
export async function verifyTakerProof(a: { taker: Address; chainId: number; nonce: Hex; issuedAtMs: number; signature: Hex }): Promise<boolean> {
  try {
    const t = takerControlTypedData(a.taker, a.chainId, a.nonce, a.issuedAtMs);
    return await verifyTypedData({ address: a.taker, domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message, signature: a.signature });
  } catch {
    return false;
  }
}
