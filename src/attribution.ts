// ERC-8021 attribution gate. Every transaction Payrail sends itself must pass assertTagged()
// immediately before signing. Uses Celo's official @celo/attribution-tags library.
import { ERC_8021_MARKER, fromDataSuffix, toDataSuffix } from '@celo/attribution-tags';
import { concat } from 'viem';
import type { Hex } from 'viem';

export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributionError';
  }
}

const MARKER = ERC_8021_MARKER.slice(2).toLowerCase();

/**
 * Throws unless `data` ends with exactly one Schema 0 ERC-8021 suffix containing exactly
 * [expectedTag], in its canonical encoding, with nothing else stacked behind it.
 */
export function assertTagged(data: string, expectedTag: string): void {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new AttributionError('calldata is not valid hex');
  }
  const lower = data.toLowerCase();

  if (!lower.endsWith(MARKER)) {
    throw new AttributionError('no ERC-8021 suffix at the end of the calldata (missing, or not at the end)');
  }
  const decoded = fromDataSuffix(data as Hex);
  if (decoded === null) {
    throw new AttributionError('malformed ERC-8021 suffix (marker present but it does not decode)');
  }
  if (decoded.schemaId !== 0) {
    throw new AttributionError(`unexpected ERC-8021 schema ${decoded.schemaId}; Payrail sends Schema 0`);
  }
  if (decoded.codes.length !== 1) {
    throw new AttributionError(
      `expected exactly one attribution code, found ${decoded.codes.length}: ${JSON.stringify(decoded.codes)}`,
    );
  }
  if (decoded.codes[0] !== expectedTag) {
    throw new AttributionError(`incorrect tag ${JSON.stringify(decoded.codes[0])}; expected ${expectedTag}`);
  }

  const canonical = toDataSuffix(expectedTag).slice(2).toLowerCase();
  if (!lower.endsWith(canonical)) {
    throw new AttributionError('suffix is not the canonical encoding of the expected tag');
  }
  const rest = lower.slice(0, lower.length - canonical.length);
  if (rest.endsWith(MARKER)) {
    throw new AttributionError('multiple ERC-8021 suffixes are stacked; exactly one is allowed');
  }
}

/** Append the suffix for `tag` to `data` and verify the result with assertTagged(). */
export function withTag(data: Hex, tag: string): Hex {
  const tagged = concat([data, toDataSuffix(tag)]);
  assertTagged(tagged, tag);
  return tagged;
}
