// DEVELOPMENT marketplace server. NOT the product. Test credits, demo APIs, sandbox sellers, a simulated Buy gateway: no real money.
//
//   npm run dev:market            ->  http://127.0.0.1:4403/market.html   (database: data/dev/marketplace-dev.db)
//
// It is completely separate from scripts/serve.ts (production, real USDT on Celo mainnet):
//   * it listens on a different port by default (4403, production is 4402);
//   * it only ever opens a database inside data/dev/ and refuses anything that is, or looks like, a production database;
//   * it does not read the production settings (PAYRAIL_DEPOSIT_ADDRESS, PAYRAIL_VAULT_KEY, wallet keys) and refuses to run if
//     PAYRAIL_MARKET_LIVE is set, so a development process can never be mistaken for, or silently become, production.
import { EnvironmentError } from '../src/envguard.ts';
import { createDevMarket } from '../src/dev/devmarket.ts';
import { createWebServer } from '../src/webapi.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const line = (s = '') => console.log(s);
const stop = (s: string): never => {
  line(`[STOP] ${s}`);
  process.exit(1);
};

if (process.env.PAYRAIL_MARKET_LIVE) stop('PAYRAIL_MARKET_LIVE is set. The development server never runs with production settings. Unset it (or use scripts/serve.ts for production).');
const port = Number(opt('port') ?? 4403);
if (!Number.isInteger(port) || port < 1024 || port > 65535) stop('--port must be a number between 1024 and 65535.');
if (port === 4402) line('Warning: 4402 is the usual PRODUCTION port; make sure no production server is running there.');

let built;
try {
  built = createDevMarket({ dbPath: opt('db'), log: line });
} catch (e) {
  if (e instanceof EnvironmentError) stop(e.message);
  throw e;
}
const { server } = createWebServer(built.runtime, { market: built.market, environment: 'development' });
server.listen(port, '127.0.0.1', () => {
  line('');
  line('=====================================================================');
  line(' DEVELOPMENT ENVIRONMENT. Test credits and simulated services only.');
  line(' Nothing here is real money, a real transaction or a real payment.');
  line('=====================================================================');
  line(`Open: http://127.0.0.1:${port}/market.html   (Ctrl+C to stop)`);
});
