/**
 * OAuth 2.0 cho Google "Desktop app" client: PKCE S256 + loopback 127.0.0.1:<cổng ngẫu nhiên>.
 * Mọi phụ thuộc (fetch, đồng hồ, random, http server, mở trình duyệt, timer) đều tiêm được.
 * Token/mã/body phản hồi KHÔNG BAO GIỜ đi vào lỗi hay log: OAuthError chỉ mang mã cố định.
 * Lưu ý: app ở chế độ Testing trên Google Cloud thì refresh token hết hạn sau 7 ngày -> invalid_grant
 * -> 'reauth-required'; người dùng phải đăng nhập lại (hoặc chuyển app sang In production).
 */
export const GMAIL_SCOPES = [
 'https://www.googleapis.com/auth/gmail.readonly',
 'https://www.googleapis.com/auth/gmail.modify',
 'https://www.googleapis.com/auth/gmail.send',
] as const;
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000;

export type OAuthErrorCode =
 | 'reauth-required'
 | 'state-mismatch'
 | 'access-denied'
 | 'timeout'
 | 'cancelled'
 | 'bind-failed'
 | 'browser-failed'
 | 'invalid-response'
 | 'no-refresh-token'
 | 'exchange-failed'
 | 'network'
 | 'invalid-input';

export class OAuthError extends Error {
 constructor(readonly code: OAuthErrorCode) {
  super(code);
  this.name = 'OAuthError';
 }
}

export interface FetchResponseLike {
 ok: boolean;
 status: number;
 headers?: {get(name: string): string | null};
 json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: {method?: string; headers?: Record<string, string>; body?: string}) => Promise<FetchResponseLike>;
export type RandomBytes = (length: number) => Uint8Array;

export interface OAuthTokens {
 accessToken: string;
 refreshToken: string;
 /** epoch ms */
 expiresAt: number;
 scope: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const defaultRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function base64url(bytes: Uint8Array): string {
 let bin = '';
 for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
 return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** verifier 43 ký tự (32 byte), challenge = base64url(SHA-256(verifier)). */
export async function createPkce(random: RandomBytes = defaultRandom): Promise<{verifier: string; challenge: string}> {
 const verifier = base64url(random(32));
 const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
 return {verifier, challenge: base64url(digest)};
}

export function buildAuthUrl(p: {clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string}): string {
 const q = new URLSearchParams({
  client_id: p.clientId,
  redirect_uri: p.redirectUri,
  response_type: 'code',
  scope: GMAIL_SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  state: p.state,
  code_challenge: p.challenge,
  code_challenge_method: 'S256',
 });
 if (p.loginHint) q.set('login_hint', p.loginHint);
 return `${AUTH_ENDPOINT}?${q.toString()}`;
}

/* ---------- loopback listener ---------- */

export interface LoopbackRes {
 statusCode: number;
 setHeader(name: string, value: string): void;
 end(body?: string): void;
}
export interface LoopbackReq {
 url?: string;
 headers?: Record<string, string | string[] | undefined>;
}
export interface ServerLike {
 listen(port: number, host: string, cb: () => void): unknown;
 once(event: 'error', cb: (e: unknown) => void): unknown;
 address(): {port: number} | string | null;
 close(cb?: () => void): unknown;
}
export type ServerFactory = (handler: (req: LoopbackReq, res: LoopbackRes) => void) => ServerLike;
export interface TimerDeps {
 setTimer?: (fn: () => void, ms: number) => unknown;
 clearTimer?: (h: unknown) => void;
}
export const LOOPBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/callback';

/** Nạp node:http động (chỉ có trong Gateway/Node). Test dùng factory giả hoặc bọc http thật. */
export async function createNodeServerFactory(): Promise<ServerFactory> {
 const spec = 'node:http';
 const http = (await import(/* @vite-ignore */ spec)) as {createServer(h: (req: LoopbackReq, res: LoopbackRes) => void): ServerLike};
 return (h) => http.createServer(h);
}

const page = (msg: string) => `<!doctype html><meta charset="utf-8"><title>OpenClaw</title><p>${msg}</p>`;

export interface Loopback {
 redirectUri: string;
 /** Resolve mã xác thực; reject OAuthError (state-mismatch, access-denied, timeout, cancelled...). */
 code: Promise<string>;
 cancel(): void;
}

/** Chỉ bind 127.0.0.1, cổng ngẫu nhiên (0); đóng server ngay khi xong/hết hạn/hủy. */
export async function startLoopback(deps: {createServer: ServerFactory; expectedState: string; timeoutMs?: number} & TimerDeps): Promise<Loopback> {
 const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
 const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
 let settle!: (r: {code: string} | {error: OAuthErrorCode}) => void;
 let timer: unknown;
 let done = false;
 const code = new Promise<string>((resolve, reject) => {
  settle = (r) => {
   if (done) return;
   done = true;
   clearTimer(timer);
   try {
    server.close();
   } catch {
    /* đã đóng */
   }
   if ('code' in r) resolve(r.code);
   else reject(new OAuthError(r.error));
  };
 });
 code.catch(() => undefined);

 let port = 0;
 const server: ServerLike = deps.createServer((req, res) => {
  const host = req.headers?.host;
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  let url: URL;
  try {
   url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
  } catch {
   res.statusCode = 400;
   res.end(page('Bad request'));
   return;
  }
  // Chặn DNS rebinding: Host phải đúng 127.0.0.1:<port>.
  if (url.pathname !== CALLBACK_PATH || (typeof host === 'string' && host !== `${LOOPBACK_HOST}:${port}`)) {
   res.statusCode = 404;
   res.end(page('Not found'));
   return;
  }
  const q = url.searchParams;
  const state = q.get('state');
  if (state !== deps.expectedState) {
   res.statusCode = 400;
   res.end(page('Invalid state. You can close this tab.'));
   settle({error: 'state-mismatch'});
  } else if (q.get('error')) {
   res.statusCode = 400;
   res.end(page('Authorization was not granted. You can close this tab.'));
   settle({error: 'access-denied'});
  } else if (!q.get('code')) {
   res.statusCode = 400;
   res.end(page('Missing code. You can close this tab.'));
   settle({error: 'invalid-response'});
  } else {
   res.statusCode = 200;
   res.end(page('Signed in. You can close this tab.'));
   settle({code: q.get('code') as string});
  }
 });

 await new Promise<void>((resolve, reject) => {
  server.once('error', () => reject(new OAuthError('bind-failed')));
  server.listen(0, LOOPBACK_HOST, () => resolve());
 });
 const addr = server.address();
 if (!addr || typeof addr === 'string') {
  settle({error: 'bind-failed'});
  throw new OAuthError('bind-failed');
 }
 port = addr.port;
 timer = setTimer(() => settle({error: 'timeout'}), deps.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
 return {redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`, code, cancel: () => settle({error: 'cancelled'})};
}

/* ---------- token endpoint ---------- */

interface TokenCommon {
 fetch: FetchLike;
 now: () => number;
 clientId: string;
 clientSecret?: string;
}

async function tokenRequest(fetchFn: FetchLike, params: Record<string, string>): Promise<Record<string, unknown>> {
 let res: FetchResponseLike;
 try {
  res = await fetchFn(TOKEN_ENDPOINT, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(params).toString()});
 } catch {
  throw new OAuthError('network');
 }
 let body: unknown;
 try {
  body = await res.json();
 } catch {
  body = undefined;
 }
 if (!res.ok) {
  if (isRec(body) && body.error === 'invalid_grant') throw new OAuthError('reauth-required');
  throw new OAuthError(res.status >= 500 ? 'network' : 'exchange-failed');
 }
 if (!isRec(body) || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new OAuthError('invalid-response');
 return body;
}

const withSecret = (p: Record<string, string>, secret?: string) => (secret ? {...p, client_secret: secret} : p);

export async function exchangeCode(p: TokenCommon & {code: string; verifier: string; redirectUri: string}): Promise<OAuthTokens> {
 const body = await tokenRequest(p.fetch, withSecret({grant_type: 'authorization_code', client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri}, p.clientSecret));
 if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new OAuthError('no-refresh-token');
 return {accessToken: body.access_token as string, refreshToken: body.refresh_token, expiresAt: p.now() + (body.expires_in as number) * 1000, scope: typeof body.scope === 'string' ? body.scope : ''};
}

/** Google thường không trả refresh_token mới: giữ cái cũ. */
export async function refreshAccessToken(p: TokenCommon & {refreshToken: string}): Promise<OAuthTokens> {
 const body = await tokenRequest(p.fetch, withSecret({grant_type: 'refresh_token', client_id: p.clientId, refresh_token: p.refreshToken}, p.clientSecret));
 return {
  accessToken: body.access_token as string,
  refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : p.refreshToken,
  expiresAt: p.now() + (body.expires_in as number) * 1000,
  scope: typeof body.scope === 'string' ? body.scope : '',
 };
}

/* ---------- controller: start / status / cancel ---------- */

export type AuthState = 'idle' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export interface AuthStatus {
 state: AuthState;
 reason: OAuthErrorCode | null;
 accountId: string | null;
 address: string | null;
}
export interface AuthControllerDeps extends TimerDeps {
 fetch: FetchLike;
 now: () => number;
 random?: RandomBytes;
 createServer: ServerFactory;
 openBrowser: (url: string) => Promise<void>;
 timeoutMs?: number;
 /** Wiring lưu token (gọi getProfile để biết địa chỉ). Không được ném token ra ngoài. */
 onTokens: (tokens: OAuthTokens, ctx: {clientId: string; clientSecret?: string}) => Promise<{accountId: string; address: string}>;
}

export function createAuthController(deps: AuthControllerDeps) {
 const random = deps.random ?? defaultRandom;
 let status: AuthStatus = {state: 'idle', reason: null, accountId: null, address: null};
 let run: {cancelled: boolean; cancel: () => void} | undefined;
 let settled: Promise<void> = Promise.resolve();

 async function flow(me: NonNullable<typeof run>, clientId: string, clientSecret: string | undefined): Promise<void> {
  const fail = (e: unknown) => {
   if (run !== me) return;
   const reason: OAuthErrorCode = e instanceof OAuthError ? e.code : 'exchange-failed';
   status = {state: reason === 'cancelled' ? 'cancelled' : 'failed', reason: reason === 'cancelled' ? null : reason, accountId: null, address: null};
  };
  let loop: Loopback | undefined;
  try {
   const {verifier, challenge} = await createPkce(random);
   const state = base64url(random(16));
   loop = await startLoopback({createServer: deps.createServer, expectedState: state, timeoutMs: deps.timeoutMs, setTimer: deps.setTimer, clearTimer: deps.clearTimer});
   me.cancel = loop.cancel;
   if (me.cancelled) loop.cancel();
   try {
    await deps.openBrowser(buildAuthUrl({clientId, redirectUri: loop.redirectUri, state, challenge}));
   } catch {
    loop.cancel();
    throw new OAuthError('browser-failed');
   }
   const code = await loop.code;
   const tokens = await exchangeCode({fetch: deps.fetch, now: deps.now, clientId, clientSecret, code, verifier, redirectUri: loop.redirectUri});
   const saved = await deps.onTokens(tokens, {clientId, clientSecret});
   if (run === me) status = {state: 'succeeded', reason: null, accountId: saved.accountId, address: saved.address};
  } catch (e) {
   fail(e);
  }
 }

 return {
  start(input: {clientId: string; clientSecret?: string}): {state: 'waiting' | 'failed'} {
   if (status.state === 'waiting') return {state: 'waiting'};
   if (typeof input.clientId !== 'string' || input.clientId.length < 8 || input.clientId.length > 256) {
    status = {state: 'failed', reason: 'invalid-input', accountId: null, address: null};
    return {state: 'failed'};
   }
   const me = {cancelled: false, cancel: () => undefined as void};
   run = me;
   status = {state: 'waiting', reason: null, accountId: null, address: null};
   settled = flow(me, input.clientId, input.clientSecret || undefined);
   return {state: 'waiting'};
  },
  status: (): AuthStatus => ({...status}),
  cancel(): AuthStatus {
   if (status.state === 'waiting' && run) {
    run.cancelled = true;
    run.cancel();
    status = {state: 'cancelled', reason: null, accountId: null, address: null};
   }
   return {...status};
  },
  /** Cho test/wiring: chờ luồng hiện tại kết thúc. */
  whenSettled: () => settled,
 };
}
export type AuthController = ReturnType<typeof createAuthController>;
