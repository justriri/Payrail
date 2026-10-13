// Register Payrail's agent identity on the ERC-8004 Identity Registry (Celo mainnet). DRY RUN BY DEFAULT.
//
//   node --env-file=.env scripts/register-agent.ts
//       Builds the exact transaction, simulates it tagged and untagged, estimates gas. Signs and sends NOTHING.
//
//   node --env-file=C:\Users\HP\.payrail\rehearsal.env scripts/register-agent.ts --send
//       Sends ONE registration transaction from the Payrail wallet (the key file is read only by the signer).
//
// Safety: registry address and function are pinned (verified on-chain and on Blockscout); calldata passes
// assertTagged() immediately before signing; tagged and untagged simulations must agree; a local record is
// written BEFORE broadcast and a second registration is refused; the key is never printed.
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTx } from '@celo/attribution-tags';
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEventLogs } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { assertTagged, withTag } from '../src/attribution.ts';
import { ConfigError, loadConfig } from '../src/config.ts';

const REGISTRY = getAddress('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'); // ERC-8004 Identity Registry, Celo mainnet
const abi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function name() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const MAX_GAS_COST_WEI = 150_000_000_000_000_000n; // refuse if the fee could exceed 0.05 CELO
const RECORD_DIR = fileURLToPath(new URL('../receipts/registrations/', import.meta.url));

const SEND = process.argv.includes('--send');
const line = (s = '') => console.log(s);
function stop(m: string, code = 2): never {
  line(`\n[STOP] ${m}`);
  process.exit(code);
}

line('=== Payrail ERC-8004 agent registration ===');
line(SEND ? 'MODE: SEND (one transaction will be signed and broadcast)' : 'MODE: DRY RUN (nothing is signed or sent)');

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    for (const p of e.problems) line(`[FAIL] ${p}`);
    stop('configuration invalid.', 1);
  }
  throw e;
}
const wallet = cfg.walletAddress;
if (!wallet) stop('no wallet address configured.', 1);
if (SEND && !cfg.privateKey) stop('--send needs the key file loaded with --env-file.', 1);
if (existsSync(join(RECORD_DIR, 'agent-registration.json'))) {
  stop(`a registration record already exists (${join(RECORD_DIR, 'agent-registration.json')}); refusing to register a second identity.`);
}

// ---- the registration file (agentURI), embedded on-chain as a data: URI so nothing needs hosting
const registration = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Payrail',
  description:
    'Payrail pays for services in the currency you hold: x402 payments to the Buy gateway, with conversion through Textile FX and Mento when needed. ' +
    `Agent wallet: ${wallet}`,
  services: [],
  active: true,
};
const agentURI = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;

const client = createPublicClient({ chain: celo, transport: http(cfg.rpcUrl) });

// ---- preconditions (read-only)
const [chainId, code, regName, owned, nativeBal, gasPrice] = await Promise.all([
  client.getChainId(),
  client.getCode({ address: REGISTRY }),
  client.readContract({ address: REGISTRY, abi, functionName: 'name' }),
  client.readContract({ address: REGISTRY, abi, functionName: 'balanceOf', args: [wallet] }),
  client.getBalance({ address: wallet }),
  client.getGasPrice(),
]);
if (chainId !== 42220) stop(`wrong chain ${chainId}`);
if (!code || code === '0x') stop('no contract code at the pinned registry address.');
if (regName !== 'AgentIdentity') stop(`unexpected registry name ${JSON.stringify(regName)}.`);
if (owned > 0n) stop(`this wallet already owns ${owned} agent identity token(s) on this registry; refusing to register another.`);
line(`registry : ${REGISTRY} (${regName})`);
line(`owner    : ${wallet}`);
line(`agentURI : data URI, ${agentURI.length} chars; name "${registration.name}"`);
line(`CELO     : ${Number(nativeBal) / 1e18}`);

// ---- calldata: register(string) + the official attribution tag, verified before anything is signed
const plain = encodeFunctionData({ abi, functionName: 'register', args: [agentURI] });
const tagged = withTag(plain, cfg.attributionTag);
assertTagged(tagged, cfg.attributionTag);
line(`calldata : ${plain.length / 2 - 1} bytes + ERC-8021 tag ${cfg.attributionTag} (assertTagged: OK)`);

// ---- simulation: tagged and untagged must behave identically
const sim = async (data: Hex) => {
  try {
    const r = await client.call({ account: wallet, to: REGISTRY, data });
    return { ok: true as const, ret: r.data ?? '0x' };
  } catch (e) {
    return { ok: false as const, error: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200) };
  }
};
const [simPlain, simTagged] = await Promise.all([sim(plain), sim(tagged)]);
if (!simPlain.ok || !simTagged.ok) stop(`simulation failed: ${!simPlain.ok ? simPlain.error : !simTagged.ok ? simTagged.error : ''}`);
if (simPlain.ok && simTagged.ok && simPlain.ret !== simTagged.ret) stop('the tagged and untagged simulations differ; refusing.');
const gas = await client.estimateGas({ account: wallet, to: REGISTRY, data: tagged });
const gasLimit = (gas * 120n) / 100n;
const costWei = gasLimit * gasPrice;
line(`simulated: tagged == untagged (return ${simTagged.ok ? simTagged.ret.slice(0, 20) : ''}...)`);
line(`gas      : ~${gas} units (limit ${gasLimit}), price ${gasPrice} wei -> at most ${Number(costWei) / 1e18} CELO`);
if (costWei > MAX_GAS_COST_WEI) stop('the fee estimate is above the safety ceiling of 0.05 CELO.');
if (nativeBal < costWei) stop('the wallet does not hold enough CELO for gas.');

if (!SEND) {
  line('\nDRY RUN complete. Nothing was signed or sent. Re-run with --send (and the key file) to register.');
  process.exit(0);
}

// ---- sign locally, journal BEFORE broadcast, then send
const account = privateKeyToAccount(cfg.privateKey!);
if (account.address.toLowerCase() !== wallet.toLowerCase()) stop('the key does not match the configured wallet.');
const [nonce, fees] = await Promise.all([client.getTransactionCount({ address: wallet, blockTag: 'pending' }), client.estimateFeesPerGas()]);
assertTagged(tagged, cfg.attributionTag); // the last check before signing
const serialized = await account.signTransaction({
  type: 'eip1559',
  chainId: 42220,
  to: REGISTRY,
  data: tagged,
  value: 0n,
  nonce,
  gas: gasLimit,
  maxFeePerGas: fees.maxFeePerGas!,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
});
const hash = keccak256(serialized);
mkdirSync(RECORD_DIR, { recursive: true });
const recordFile = join(RECORD_DIR, 'agent-registration.json');
const record: Record<string, unknown> = {
  schemaVersion: 1,
  state: 'SUBMITTING',
  createdAt: new Date().toISOString(),
  registry: REGISTRY,
  owner: wallet,
  txHash: hash,
  nonce,
  attributionTag: cfg.attributionTag,
  registration,
};
writeFileSync(recordFile, JSON.stringify(record, null, 2), { flag: 'wx' }); // refuses if one exists
line(`\nsigned locally; tx hash ${hash}; journal written. Broadcasting...`);
try {
  await client.sendRawTransaction({ serializedTransaction: serialized });
} catch (e) {
  record.state = 'UNCERTAIN';
  record.note = `broadcast threw: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}; check the hash on a block explorer before doing anything else`;
  writeFileSync(recordFile, JSON.stringify(record, null, 2));
  stop(`broadcast reported an error; the transaction may still have been accepted. Hash: ${hash}`, 3);
}

// ---- wait and verify independently
let receipt;
for (let i = 0; i < 60 && !receipt; i++) {
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (!receipt) {
  record.state = 'UNCERTAIN';
  record.note = 'no receipt within 2 minutes; check the hash on a block explorer';
  writeFileSync(recordFile, JSON.stringify(record, null, 2));
  stop(`no receipt yet for ${hash}. It may still confirm. Nothing was retried.`, 3);
}
const r = receipt!;
if (r.status !== 'success') {
  record.state = 'FAILED';
  record.blockNumber = r.blockNumber.toString();
  writeFileSync(recordFile, JSON.stringify(record, null, 2));
  stop(`the transaction reverted on-chain (block ${r.blockNumber}). No identity was created. Hash: ${hash}`, 3);
}
const mint = parseEventLogs({ abi, eventName: 'Transfer', logs: r.logs }).find(
  (l) => getAddress(l.address) === REGISTRY && l.args.from === '0x0000000000000000000000000000000000000000' && getAddress(l.args.to) === wallet,
);
const agentId = mint?.args.tokenId;
let tagCodes: string[] | null = null;
try {
  const v = await verifyTx({ client, hash });
  tagCodes = v ? [...v.codes] : null;
} catch {
  tagCodes = null;
}
let ownerNow: string | undefined;
let uriNow: string | undefined;
if (agentId !== undefined) {
  ownerNow = await client.readContract({ address: REGISTRY, abi, functionName: 'ownerOf', args: [agentId], blockNumber: r.blockNumber });
  uriNow = await client.readContract({ address: REGISTRY, abi, functionName: 'tokenURI', args: [agentId], blockNumber: r.blockNumber });
}
record.state = agentId !== undefined && ownerNow && getAddress(ownerNow) === wallet && uriNow === agentURI ? 'CONFIRMED' : 'UNCERTAIN';
record.blockNumber = r.blockNumber.toString();
record.agentId = agentId?.toString() ?? null;
record.verifiedOwner = ownerNow ?? null;
record.tokenUriMatches = uriNow === agentURI;
record.attributionCodes = tagCodes;
record.gasUsed = r.gasUsed.toString();
writeFileSync(recordFile, JSON.stringify(record, null, 2));

line('\n=== RESULT ===');
line(`state     : ${record.state}`);
line(`tx        : ${hash}  (block ${r.blockNumber})`);
line(`agentId   : ${agentId?.toString() ?? 'not found in logs'}`);
line(`owner     : ${ownerNow ?? 'n/a'}`);
line(`tokenURI matches what was sent: ${uriNow === agentURI}`);
line(`tag found by verifyTx: ${tagCodes ? tagCodes.join(', ') : 'none'}`);
line(`record    : ${recordFile}`);
void readFileSync;
process.exit(record.state === 'CONFIRMED' ? 0 : 3);
