// Pure helpers for the one-click "Pay" flow. No network, no wallet, no DOM: these are unit-tested in Node and used by api.js.
// A top-up is exactly the SHORTFALL (price minus available balance), sent from the buyer's own wallet as one USDT transfer.
(function (root) {
  'use strict';
  const DEC = 6;

  /** "0.5" -> 500000n. Returns null for anything that is not a plain decimal with at most 6 places. */
  function parseUnits6(text) {
    const s = String(text).trim();
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return null;
    const [w, f = ''] = s.split('.');
    return BigInt(w) * 10n ** BigInt(DEC) + BigInt(f.padEnd(DEC, '0'));
  }

  function formatUnits6(atomic) {
    const v = BigInt(atomic);
    const w = v / 10n ** BigInt(DEC);
    const f = (v % 10n ** BigInt(DEC)).toString().padStart(DEC, '0').replace(/0+$/, '');
    return f ? `${w}.${f}` : `${w}`;
  }

  /**
   * Decide whether a top-up is needed and for how much.
   * Returns { needed:false } when the balance already covers the price, { needed:true, amountAtomic } otherwise,
   * or { error } when the price cannot be covered within the per-deposit limit.
   */
  function planTopUp({ priceAtomic, availableAtomic, maxDepositAtomic }) {
    const price = BigInt(priceAtomic);
    const avail = BigInt(availableAtomic);
    const cap = BigInt(maxDepositAtomic);
    if (price <= 0n) return { error: 'The price is not valid.' };
    if (avail >= price) return { needed: false, amountAtomic: 0n };
    const shortfall = price - avail;
    if (shortfall > cap) {
      return { error: `This API needs a top-up of ${formatUnits6(shortfall)} USDT, above the per-deposit limit of ${formatUnits6(cap)} USDT. Nothing was sent.` };
    }
    return { needed: true, amountAtomic: shortfall };
  }

  /** ERC-20 transfer(address,uint256) calldata. The recipient must be a 20-byte hex address. */
  function transferCalldata(to, amountAtomic) {
    const addr = String(to).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('invalid recipient address');
    const amt = BigInt(amountAtomic);
    if (amt <= 0n || amt >= 2n ** 256n) throw new Error('invalid amount');
    return `0xa9059cbb${addr.slice(2).padStart(64, '0')}${amt.toString(16).padStart(64, '0')}`;
  }

  /** Errors that mean "not there yet, keep waiting" rather than "this failed". */
  const PENDING_CODES = ['NOT_ENOUGH_CONFIRMATIONS', 'TX_NOT_FOUND'];
  const isPendingCode = (code) => PENDING_CODES.includes(code);

  const api = { parseUnits6, formatUnits6, planTopUp, transferCalldata, isPendingCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PayrailTopUp = api;
})(typeof window !== 'undefined' ? window : globalThis);
