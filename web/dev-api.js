// DEVELOPMENT ENVIRONMENT ONLY (served only by the development server). Lets the API details page run a listing with TEST CREDITS:
// no wallet, no transfer, no blockchain. The production server cannot serve this file.
'use strict';

window.PayrailDev = {
  api: {
    badge: 'DEVELOPMENT · TEST CREDITS (not money)',
    networkLine: 'Development environment: no wallet, no blockchain, no real transaction.',
    note: 'DEVELOPMENT: this request is paid with test credits on the development server. Nothing here is on-chain.',
    balanceText(me) {
      return `Test-credit balance: ${me.available} ${me.asset} (held ${me.held}). Not money.`;
    },
  },
};
