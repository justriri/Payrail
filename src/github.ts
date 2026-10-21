// GitHub access for seller verification: OAuth sign-in and read-only repository queries. Nothing here writes to GitHub.
//
// Security notes
//  - The OAuth App is asked for NO scopes: that is enough to read the signed-in user and to read PUBLIC repositories (including the
//    `permissions` GitHub reports for that user). Private repositories are not supported and nothing broader is ever requested.
//  - The access token is used only on the server, sealed with the vault master key before it is stored, and never returned or logged.
//  - Only api.github.com and github.com/login/oauth are ever contacted, with fixed paths: seller input is parsed into owner/name that match
//    GitHub's own naming rules and is never used as a URL.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKey } from './vault.ts';

export class GitHubError extends Error {
  readonly code: 'NOT_CONFIGURED' | 'BAD_CODE' | 'UNAVAILABLE' | 'RATE_LIMITED' | 'TOKEN_REJECTED' | 'BAD_RESPONSE';
  constructor(code: GitHubError['code'], message: string) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
  }
}

export interface GhRepo {
  /** GitHub's immutable numeric id: the renamed or transferred repository keeps it */
  id: number;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  archived: boolean;
  fork: boolean;
  /** what GitHub says THIS token's user may do (absent permissions are false) */
  permissions: { admin: boolean; maintain: boolean; push: boolean; pull: boolean };
}
export interface GhFile {
  content: string;
  /** git blob sha of the file */
  sha: string;
}
export interface GitHubApi {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
  user(token: string): Promise<{ id: number; login: string }>;
  /** null = not found or not visible to this user */
  repo(token: string, owner: string, name: string): Promise<GhRepo | null>;
  /** null = no such file on that ref */
  file(token: string, owner: string, name: string, path: string, ref: string): Promise<GhFile | null>;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `https://github.com/owner/repo` (optionally `.git`, trailing slash). Anything else is refused: a name in a README or a different host proves nothing. */
export function parseRepoUrl(raw: string): { owner: string; name: string } | undefined {
  const m = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/.exec(String(raw).trim());
  if (!m) return undefined;
  const [, owner, name] = m;
  if (!OWNER.test(owner!) || !NAME.test(name!) || name === '.' || name === '..') return undefined;
  return { owner: owner!, name: name! };
}

/** the exact callback address Payrail asks GitHub to return to, built from PAYRAIL_PUBLIC_URL */
export const GITHUB_CALLBACK_PATH = '/api/market/github/callback';

/**
 * PAYRAIL_PUBLIC_URL is the address a seller's browser uses to reach THIS server. The callback is that origin plus a fixed path.
 *  - production: https only;
 *  - local development: plain http is accepted ONLY for a loopback host (127.0.0.1, [::1], localhost), which GitHub allows for OAuth Apps;
 *  - no credentials, path, query or fragment: nothing but an origin, so the callback cannot be steered anywhere else.
 * Throws a plain Error with the reason (marketsetup turns it into a startup refusal).
 */
export function githubRedirectUri(publicUrl: string): { redirectUri: string; local: boolean; warning?: string } {
  let u: URL;
  try {
    u = new URL(publicUrl.trim());
  } catch {
    throw new Error('PAYRAIL_PUBLIC_URL must be a full address such as https://payrail.example.com or, for local development, http://127.0.0.1:4402');
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new Error('PAYRAIL_PUBLIC_URL must be https (plain http is accepted only for a loopback address such as http://127.0.0.1:4402)');
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error('PAYRAIL_PUBLIC_URL must be only the address (scheme, host and optional port): no path, query, fragment or credentials');
  }
  return {
    redirectUri: `${u.origin}${GITHUB_CALLBACK_PATH}`,
    local: loopback,
    ...(u.hostname === 'localhost' ? { warning: 'GitHub advises against "localhost" for OAuth; use http://127.0.0.1:<port> and open Payrail at that same address' } : {}),
  };
}

interface Cfg {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export function createGitHubApi(c: Cfg): GitHubApi {
  const f = c.fetchImpl ?? fetch;
  const headers = (token?: string): Record<string, string> => ({
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Payrail-Verification/1',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const call = async (path: string, token: string): Promise<Response> => {
    let r: Response;
    try {
      r = await f(`https://api.github.com${path}`, { headers: headers(token), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    } catch {
      throw new GitHubError('UNAVAILABLE', 'GitHub could not be reached');
    }
    if (r.status === 401) throw new GitHubError('TOKEN_REJECTED', 'GitHub no longer accepts the saved authorization: connect GitHub again');
    if (r.status === 403 || r.status === 429) throw new GitHubError('RATE_LIMITED', 'GitHub is limiting requests right now: try again shortly');
    if (r.status >= 500) throw new GitHubError('UNAVAILABLE', `GitHub answered ${r.status}`);
    return r;
  };
  return {
    authorizeUrl(state) {
      const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, state, allow_signup: 'false' }); // no scope parameter: no scopes
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async exchangeCode(code) {
      let r: Response;
      try {
        r = await f('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Payrail-Verification/1' },
          body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: c.redirectUri }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
      } catch {
        throw new GitHubError('UNAVAILABLE', 'GitHub could not be reached');
      }
      const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
      if (typeof j.access_token !== 'string' || !/^[\w-]{10,255}$/.test(j.access_token)) throw new GitHubError('BAD_CODE', 'GitHub did not accept the authorization code');
      return j.access_token;
    },
    async user(token) {
      const r = await call('/user', token);
      const j = (await r.json().catch(() => undefined)) as { id?: unknown; login?: unknown } | undefined;
      if (!j || typeof j.id !== 'number' || typeof j.login !== 'string') throw new GitHubError('BAD_RESPONSE', 'unexpected answer from GitHub');
      return { id: j.id, login: j.login };
    },
    async repo(token, owner, name) {
      const r = await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
      if (r.status === 404 || r.status === 410) return null;
      const j = (await r.json().catch(() => undefined)) as Record<string, any> | undefined;
      if (!r.ok || !j || typeof j.id !== 'number' || typeof j.full_name !== 'string' || typeof j.default_branch !== 'string') throw new GitHubError('BAD_RESPONSE', 'unexpected answer from GitHub');
      const p = (j.permissions ?? {}) as Record<string, unknown>;
      return {
        id: j.id, fullName: j.full_name, defaultBranch: j.default_branch, isPrivate: j.private === true, archived: j.archived === true, fork: j.fork === true,
        permissions: { admin: p.admin === true, maintain: p.maintain === true, push: p.push === true, pull: p.pull === true },
      };
    },
    async file(token, owner, name, path, ref) {
      const enc = path.split('/').map(encodeURIComponent).join('/');
      const r = await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${enc}?ref=${encodeURIComponent(ref)}`, token);
      if (r.status === 404) return null;
      const j = (await r.json().catch(() => undefined)) as Record<string, any> | undefined;
      if (!r.ok || !j || j.type !== 'file' || typeof j.sha !== 'string' || j.encoding !== 'base64' || typeof j.content !== 'string') return null;
      return { content: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
    },
  };
}

// ------------------------------------------------------------------ sealing the access token

const AAD = (accountId: string) => Buffer.from(`payrail:github-token:${accountId}`);
export function sealToken(mk: MasterKey, accountId: string, token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', mk.key, iv);
  c.setAAD(AAD(accountId));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return ['v1', mk.id, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function openToken(keys: readonly MasterKey[], accountId: string, sealed: string): string | undefined {
  const [v, kid, iv, tag, ct] = sealed.split('.');
  const mk = keys.find((k) => k.id === kid);
  if (v !== 'v1' || !mk || !iv || !tag || !ct) return undefined;
  try {
    const d = createDecipheriv('aes-256-gcm', mk.key, Buffer.from(iv, 'base64url'));
    d.setAAD(AAD(accountId));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
