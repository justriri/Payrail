// Create an encrypted keystore from the key in your key file, so the web app can be unlocked with a passphrase.
//
//   node --env-file=C:\Users\<you>\.payrail\rehearsal.env scripts/keystore.ts
//
// The key is read from PAYRAIL_PRIVATE_KEY inside this process, encrypted with a passphrase you type (not echoed), and
// written to ~/.payrail/keystore.json (or PAYRAIL_KEYSTORE). The key is never printed. Only the address is shown.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encryptKey } from '../src/keystore.ts';

const line = (s = '') => console.log(s);
const target = process.env.PAYRAIL_KEYSTORE ?? join(homedir(), '.payrail', 'keystore.json');
const key = process.env.PAYRAIL_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  line('[STOP] PAYRAIL_PRIVATE_KEY is not loaded. Run with --env-file=<your key file>.');
  process.exit(1);
}
if (existsSync(target) && !process.argv.includes('--force')) {
  line(`[STOP] ${target} already exists. Re-run with --force to replace it.`);
  process.exit(1);
}
const wanted = process.env.PAYRAIL_WALLET_ADDRESS;
const address = privateKeyToAccount(key as `0x${string}`).address;
if (wanted && wanted.toLowerCase() !== address.toLowerCase()) {
  line('[STOP] PAYRAIL_WALLET_ADDRESS does not match the key. Refusing.');
  process.exit(1);
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(s);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on('data', onData);
  });
}

const p1 = await ask('Choose a passphrase (10+ characters, not shown): ');
const p2 = await ask('Repeat the passphrase: ');
if (p1 !== p2) {
  line('[STOP] the passphrases differ.');
  process.exit(1);
}
const file = encryptKey(key, p1);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(file, null, 2), { mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  /* best effort on Windows */
}
line(`Keystore written: ${target}`);
line(`Wallet: ${address}`);
line('You can now start the app WITHOUT the key file and unlock it with this passphrase in the browser.');
line('Keep your key backup: this file is not a replacement for it.');
