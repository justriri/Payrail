// Verify a wallet-key file (or a BACKUP of it) WITHOUT displaying the key.
//
//   node --env-file=<path to the key file or backup> scripts/check-key-file.ts [--expect 0xYourPublicAddress]
//
// It loads the file the same way the app does (PAYRAIL_PRIVATE_KEY), derives the PUBLIC address and compares it
// with --expect (or PAYRAIL_WALLET_ADDRESS if that is also set). It prints the address and the file's path.
// It never prints, logs or writes the key. It sends nothing and contacts no network.
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const args = process.argv.slice(2);
const line = (s = '') => console.log(s);
const expectIdx = args.indexOf('--expect');
const expected = expectIdx >= 0 ? args[expectIdx + 1] : process.env.PAYRAIL_WALLET_ADDRESS;

// Where did the key come from? (node records --env-file in execArgv; only the PATH is shown.)
const envFiles = process.execArgv.filter((a) => a.startsWith('--env-file')).map((a) => a.split('=').slice(1).join('='));
const key = process.env.PAYRAIL_PRIVATE_KEY;

line('=== Payrail key-file check (the key is never shown) ===');
for (const f of envFiles) {
  line(`loaded from : ${f}`);
  if (/onedrive|dropbox|google drive|icloud/i.test(f)) {
    line('[WARN] this path looks like a cloud-synced folder. Keep key files OUTSIDE synced folders.');
  }
}
if (!key) {
  line('[FAIL] PAYRAIL_PRIVATE_KEY was not found in the loaded file.');
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  line('[FAIL] the value is not a 0x-prefixed 32-byte hex string (value not shown).');
  process.exit(1);
}

let derived: string;
try {
  derived = privateKeyToAccount(key as `0x${string}`).address;
} catch {
  line('[FAIL] the value is not a valid private key (value not shown).');
  process.exit(1);
}
line(`address     : ${derived}`);

if (!expected) {
  line('[INFO] no expected address given. Pass --expect 0x... to compare.');
  process.exit(0);
}
if (!isAddress(expected)) {
  line('[FAIL] --expect is not a valid address.');
  process.exit(1);
}
if (expected.toLowerCase() === derived.toLowerCase()) {
  line(`[PASS] this key belongs to the expected wallet ${expected}`);
  process.exit(0);
}
line(`[MISMATCH] this key derives ${derived}, but the expected wallet is ${expected}. Do NOT use this file.`);
process.exit(2);
