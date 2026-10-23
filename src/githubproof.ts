// GitHub verification for seller listings: an alternative to the DNS TXT record and to pasting a token into the host's settings.
//
// WHAT GITHUB CAN AND CANNOT PROVE. GitHub authorization proves the seller controls a GitHub account with write access to a repository. It says
// nothing about who runs a given web address, so a repository (public or not) never counts on its own, and neither does a repository name, a
// README or a typed username. To tie the repository to the DEPLOYED endpoint, the listing's one-time proof value (payrail-verify=<token>) must
// be present in BOTH places:
//   1. in the repository, at .well-known/payrail-verification.txt on the default branch, read through the seller's own GitHub authorization
//      (the seller needs push access to the repository, so the commit is evidence that they control its content), and
//   2. served by the deployed host at https://<host>/.well-known/payrail-verification.txt (only whoever runs that host can make it say that).
// A deployment that is built from the repository serves the committed file by itself, so the seller commits ONE file (one click on GitHub) and the
// host redeploys: no DNS records and no token copied into Render. Because step 2 is the same proof the well-known file method requires, GitHub
// verification is never weaker than that method; step 1 adds evidence of repository control and an auditable link (repository id, GitHub user).
// A third party's endpoint cannot pass: it would have to serve this listing's token, which only its operator can do.
import { createHash, randomBytes } from 'node:crypto';
import { audit, query, queryOne } from './db.ts';
import type { Db } from './db.ts';
import { EgressError, safeFetch } from './egress.ts';
import type { FetchOptions } from './egress.ts';
import { GitHubError, openToken, parseRepoUrl, sealToken } from './github.ts';
import type { GitHubApi, GhRepo } from './github.ts';
import { SellerError, challengeFor, getListing, proofValue, recordDomainProof, WELL_KNOWN_PATH } from './seller.ts';
import type { MasterKey } from './vault.ts';

export const PROOF_FILE_PATH = '.well-known/payrail-verification.txt';
const STATE_TTL_MS = 10 * 60_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (n: number) => new Date(n).toISOString();

export interface Check {
  id: 'github_connected' | 'repo_access' | 'repo_file' | 'deployed_file' | 'endpoint_reachable';
  label: string;
  ok: boolean;
  detail: string;
}
export interface GitHubVerifyDeps {
  db: Db;
  keys: readonly MasterKey[];
  api: GitHubApi;
  now?: () => number;
  /** options for the outbound checks of the deployed host (tests inject a resolver and transport; production leaves this empty) */
  fetchOptions?: FetchOptions;
  /**
   * Per-attempt timeouts (ms) when the deployed host does not answer. Free hosting sleeps when idle and needs about a minute to wake, and the first
   * request is what wakes it, so a timeout is retried with longer waits instead of being reported at once. Only timeouts and network failures are
   * retried: a definite answer (wrong content, 404, a blocked address) is judged immediately. Default 10 s, 30 s, 30 s.
   */
  wake?: readonly number[];
}

export function createGitHubVerification(d: GitHubVerifyDeps) {
  const now = d.now ?? Date.now;
  const activeKey = d.keys[0]!;
  const attempts = d.wake ?? [10_000, 30_000, 30_000];
  const WAKEABLE = new Set(['TIMEOUT', 'NETWORK', 'DNS_TEMPORARY']);
  /** one outbound read of the seller's host, retried (with longer waits) only while it is not answering at all */
  async function probe(url: string, o: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; maxBytes: number }) {
    let last: unknown;
    let waited = 0;
    for (let i = 0; i < attempts.length; i++) {
      try {
        return await safeFetch(url, { method: o.method, maxBytes: o.maxBytes, maxRedirects: 0, timeoutMs: attempts[i]!, ...(d.fetchOptions ?? {}) });
      } catch (e) {
        last = e;
        waited += attempts[i]!;
        if (!(e instanceof EgressError && WAKEABLE.has(e.code))) throw e;
      }
    }
    if (last instanceof EgressError) throw Object.assign(new EgressError(last.code, `${last.message}; tried ${attempts.length} times over ${Math.round(waited / 1000)} seconds`), { waitedMs: waited });
    throw last;
  }

  const connection = (accountId: string) => queryOne(d.db, 'SELECT * FROM github_connections WHERE account_id = ?', accountId);
  const tokenOf = (accountId: string): string | undefined => {
    const c = connection(accountId);
    return c ? openToken(d.keys, accountId, String(c.token_sealed)) : undefined;
  };

  return {
    /** public facts for the page; never the token */
    status(accountId: string) {
      const c = connection(accountId);
      return { configured: true, connected: Boolean(c), login: c ? String(c.login) : null, connectedAt: c ? String(c.created_at) : null };
    },

    /** step 1: a one-time, account-bound state, and the GitHub address the seller is sent to */
    startConnect(accountId: string): { url: string } {
      const state = randomBytes(32).toString('base64url');
      d.db.prepare('INSERT INTO github_oauth_states (state_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(state), accountId, iso(now()), iso(now() + STATE_TTL_MS));
      return { url: d.api.authorizeUrl(state) };
    },

    /** step 2 (the browser comes back from GitHub with ?code&state): the state decides WHICH seller this is; nothing else is trusted */
    async completeConnect(code: string, state: string): Promise<{ accountId: string; login: string }> {
      const row = queryOne(d.db, 'SELECT * FROM github_oauth_states WHERE state_hash = ?', sha(String(state)));
      if (!row || row.used_at !== null || Date.parse(String(row.expires_at)) < now()) throw new GitHubError('BAD_CODE', 'this GitHub sign-in link is unknown, used or expired: start again from the listing page');
      const used = d.db.prepare('UPDATE github_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL').run(iso(now()), sha(String(state)));
      if (Number(used.changes) !== 1) throw new GitHubError('BAD_CODE', 'this GitHub sign-in link was already used');
      const accountId = String(row.account_id);
      const token = await d.api.exchangeCode(String(code));
      const u = await d.api.user(token);
      d.db.prepare(
        `INSERT INTO github_connections (account_id, github_user_id, login, token_sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET github_user_id = excluded.github_user_id, login = excluded.login, token_sealed = excluded.token_sealed, updated_at = excluded.updated_at`,
      ).run(accountId, u.id, u.login, sealToken(activeKey, accountId, token), iso(now()), iso(now()));
      audit(d.db, accountId, 'github.connected', accountId, { login: u.login, githubUserId: u.id }, new Date(now()));
      return { accountId, login: u.login };
    },

    disconnect(accountId: string): void {
      d.db.prepare('DELETE FROM github_connections WHERE account_id = ?').run(accountId);
      audit(d.db, accountId, 'github.disconnected', accountId, undefined, new Date(now()));
    },

    /** step 3: the seller names a repository. It must exist, be visible, and the connected user must be able to push to it. */
    async start(accountId: string, listingId: string, repoUrl: string) {
      const l = getListing(d.db, listingId);
      if (!l || l.sellerId !== accountId) throw new SellerError('NOT_FOUND', 'no such listing');
      if (!['draft', 'verified'].includes(l.status)) throw new SellerError('WRONG_STATE', `listing is ${l.status}`);
      const parsed = parseRepoUrl(repoUrl);
      if (!parsed) throw new SellerError('BAD_INPUT', 'the repository must be a GitHub address like https://github.com/owner/repository');
      const token = tokenOf(accountId);
      const c = connection(accountId);
      if (!token || !c) throw new SellerError('PROOF_MISSING', 'connect your GitHub account first');
      const repo = await d.api.repo(token, parsed.owner, parsed.name);
      if (!repo) throw new SellerError('NOT_FOUND', 'GitHub does not show that repository to your account (it does not exist, or it is private: private repositories are not supported)');
      const why = accessProblem(repo);
      if (why) throw new SellerError('NOT_OWNER', why);
      d.db.prepare(
        `INSERT INTO listing_github_proofs (listing_id, repo_id, repo_full_name, default_branch, github_user_id, github_login, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET repo_id = excluded.repo_id, repo_full_name = excluded.repo_full_name, default_branch = excluded.default_branch,
           github_user_id = excluded.github_user_id, github_login = excluded.github_login, started_at = excluded.started_at, verified_at = NULL, file_sha = NULL, endpoint_status = NULL, last_checks_json = NULL`,
      ).run(listingId, repo.id, repo.fullName, repo.defaultBranch, Number(c.github_user_id), String(c.login), iso(now()));
      const ch = challengeFor(d.db, listingId)!;
      const value = proofValue(ch.token);
      return {
        repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
        proofFile: {
          path: PROOF_FILE_PATH,
          content: value,
          // GitHub's own "create new file" page, prefilled: the seller only presses Commit
          createUrl: `https://github.com/${repo.fullName}/new/${encodeURIComponent(repo.defaultBranch)}?filename=${encodeURIComponent(PROOF_FILE_PATH)}&value=${encodeURIComponent(value)}`,
          servedAt: `https://${l.host}${WELL_KNOWN_PATH}`,
        },
        steps: [
          `Commit the file ${PROOF_FILE_PATH} containing exactly ${value} to ${repo.fullName} (default branch ${repo.defaultBranch}).`,
          'Your deployment must serve that file at the address above. A deployment built from this repository does, once it has redeployed (the Payrail test API template serves it by itself).',
          'Press Check: Payrail reads the file from GitHub and from your live endpoint and calls your endpoint.',
        ],
      };
    },

    /** step 4: every check is run and reported; only if ALL pass is the proof recorded */
    async check(accountId: string, listingId: string): Promise<{ ok: boolean; checks: Check[]; repo: { fullName: string } | null }> {
      const l = getListing(d.db, listingId);
      if (!l || l.sellerId !== accountId) throw new SellerError('NOT_FOUND', 'no such listing');
      if (!['draft', 'verified'].includes(l.status)) throw new SellerError('WRONG_STATE', `listing is ${l.status}`);
      const p = queryOne(d.db, 'SELECT * FROM listing_github_proofs WHERE listing_id = ?', listingId);
      if (!p) throw new SellerError('PROOF_MISSING', 'enter your repository first');
      const ch = challengeFor(d.db, listingId)!;
      const expected = proofValue(ch.token);
      const checks: Check[] = [];
      const add = (id: Check['id'], label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });
      const [owner, name] = String(p.repo_full_name).split('/') as [string, string];

      // 1 + 2 + 3: GitHub side, with the seller's own authorization
      const token = tokenOf(accountId);
      const conn = connection(accountId);
      let fileSha: string | null = null;
      if (!token || !conn) {
        add('github_connected', 'GitHub account connected', false, 'Connect your GitHub account again.');
        add('repo_access', 'You have write access to the repository', false, 'Skipped: GitHub is not connected.');
        add('repo_file', 'The proof file is in the repository', false, 'Skipped: GitHub is not connected.');
      } else {
        const sameUser = Number(conn.github_user_id) === Number(p.github_user_id);
        add('github_connected', 'GitHub account connected', sameUser, sameUser ? `Connected as ${String(conn.login)}.` : 'The connected GitHub account changed since you chose the repository: choose it again.');
        try {
          const repo = sameUser ? await d.api.repo(token, owner, name) : null;
          const problem = !sameUser ? 'Skipped.' : !repo ? 'GitHub does not show that repository to your account.' : repo.id !== Number(p.repo_id) ? 'The repository was replaced by a different one under the same name: choose it again.' : accessProblem(repo);
          add('repo_access', 'You have write access to the repository', !problem, problem ?? `GitHub confirms your account can push to ${String(p.repo_full_name)}.`);
          if (!problem && repo) {
            const f = await d.api.file(token, owner, name, PROOF_FILE_PATH, repo.defaultBranch);
            if (!f) add('repo_file', 'The proof file is in the repository', false, `${PROOF_FILE_PATH} was not found on ${repo.defaultBranch}. Commit it, then check again.`);
            else if (f.content.trim() !== expected) add('repo_file', 'The proof file is in the repository', false, `${PROOF_FILE_PATH} exists but does not contain exactly this listing's value (${expected}).`);
            else { fileSha = f.sha; add('repo_file', 'The proof file is in the repository', true, `${PROOF_FILE_PATH} on ${repo.defaultBranch} contains this listing's value.`); }
          } else add('repo_file', 'The proof file is in the repository', false, 'Skipped: no repository access.');
        } catch (e) {
          const msg = e instanceof GitHubError ? e.message : 'GitHub could not be checked just now';
          if (!checks.some((c) => c.id === 'repo_access')) add('repo_access', 'You have write access to the repository', false, `${msg} (temporary or authorization problem: this is not a failed proof).`);
          add('repo_file', 'The proof file is in the repository', false, 'Skipped.');
        }
      }

      // 4: the DEPLOYED host serves the same proof (this is what ties the repository to the endpoint)
      const url = `https://${l.host}${WELL_KNOWN_PATH}`;
      try {
        const res = await probe(url, { method: 'GET', maxBytes: 512 });
        if (res.status !== 200) add('deployed_file', 'Your deployed API serves the proof file', false, `${url} answered HTTP ${res.status}. The deployment must serve the committed file (redeploy after committing it).`);
        else if (res.body.toString('utf8').trim() !== expected) add('deployed_file', 'Your deployed API serves the proof file', false, `${url} does not contain this listing's value: the deployment is not built from the repository with the proof file yet, or it belongs to someone else.`);
        else add('deployed_file', 'Your deployed API serves the proof file', true, `${l.host} serves this listing's value.`);
      } catch (e) {
        add('deployed_file', 'Your deployed API serves the proof file', false, describeEgress(e, l.host));
      }

      // 5: the listed endpoint answers with valid JSON
      let endpointStatus: number | null = null;
      try {
        const res = await probe(l.endpointUrl, { method: l.method, maxBytes: 262_144 });
        endpointStatus = res.status;
        let json = true;
        try { JSON.parse(res.body.toString('utf8')); } catch { json = false; }
        const jsonOk = json && /json/i.test(res.headers['content-type'] ?? '');
        const needsAuth = (res.status === 401 || res.status === 403) && jsonOk;
        if (!needsAuth && (res.status < 200 || res.status >= 300)) add('endpoint_reachable', 'Your API endpoint answers', false, `${l.endpointUrl} answered HTTP ${res.status}.`);
        else if (!jsonOk) add('endpoint_reachable', 'Your API endpoint answers', false, `${l.endpointUrl} answered HTTP ${res.status} but not with a JSON body and a JSON content type.`);
        else if (needsAuth) add('endpoint_reachable', 'Your API endpoint answers', true, `${l.endpointUrl} answered HTTP ${res.status} with JSON: it is up and asks for credentials (you add yours after verification).`);
        else add('endpoint_reachable', 'Your API endpoint answers', true, `${l.endpointUrl} answered HTTP ${res.status} with valid JSON.`);
      } catch (e) {
        add('endpoint_reachable', 'Your API endpoint answers', false, describeEgress(e, l.host));
      }

      const ok = checks.length === 5 && checks.every((c) => c.ok);
      d.db.prepare('UPDATE listing_github_proofs SET last_checks_json = ?, endpoint_status = ?, file_sha = ? WHERE listing_id = ?').run(JSON.stringify(checks), endpointStatus, fileSha, listingId);
      if (ok) {
        d.db.prepare('UPDATE listing_github_proofs SET verified_at = ? WHERE listing_id = ?').run(iso(now()), listingId);
        recordDomainProof(d.db, accountId, listingId, 'github', now, { repo: String(p.repo_full_name), repoId: Number(p.repo_id), githubUser: String(p.github_login), fileSha });
      }
      return { ok, checks, repo: { fullName: String(p.repo_full_name) } };
    },

    /** for the listing view */
    proofOf(listingId: string) {
      const p = queryOne(d.db, 'SELECT * FROM listing_github_proofs WHERE listing_id = ?', listingId);
      if (!p) return null;
      return {
        repo: String(p.repo_full_name), defaultBranch: String(p.default_branch), githubLogin: String(p.github_login), startedAt: String(p.started_at),
        verifiedAt: p.verified_at === null ? null : String(p.verified_at), checks: p.last_checks_json ? (JSON.parse(String(p.last_checks_json)) as Check[]) : [],
      };
    },
    allProofs: () => query(d.db, 'SELECT listing_id, repo_full_name FROM listing_github_proofs'),
  };
}
export type GitHubVerification = ReturnType<typeof createGitHubVerification>;

function accessProblem(repo: GhRepo): string | undefined {
  if (repo.isPrivate) return 'Private repositories are not supported: use a public repository, or verify with DNS or the well-known file.';
  if (repo.archived) return 'That repository is archived (read-only), so you cannot commit the proof file.';
  if (!(repo.permissions.push || repo.permissions.maintain || repo.permissions.admin)) {
    return 'Your GitHub account does not have write access to that repository. A public repository belonging to someone else does not prove anything about you.';
  }
  return undefined;
}

function describeEgress(e: unknown, host: string): string {
  if (e instanceof EgressError) {
    if (e.code === 'DNS_TEMPORARY' || e.code === 'TIMEOUT' || e.code === 'NETWORK') return `${host} did not answer in time (${e.message}). Free hosting sleeps when idle and can take a minute or more to wake: open its /health address in a browser until it answers, then check again. This is a hosting timeout, NOT a failed proof.`;
    if (e.code === 'DNS_FAILED') return `${host} does not exist in DNS. Check the endpoint address.`;
    return `${host} cannot be used: ${e.message}`;
  }
  return `${host} could not be checked just now.`;
}
