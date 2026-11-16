/**
 * Đăng nhập Messenger cá nhân bằng trình duyệt thật (Playwright, nạp động; KHÔNG là dependency).
 * Người dùng tự đăng nhập; module chỉ chờ cookie c_user + xs. Không log/trả giá trị ra ngoài status.
 */
import type {StoredCookie} from './cookieStore';

export type LoginFailure = 'playwright-missing' | 'launch-failed' | 'timeout' | 'cancelled';
export type LoginResult = {ok: true; cookies: StoredCookie[]} | {ok: false; reason: LoginFailure};

/** Phần tối thiểu của Playwright mà module dùng (để test không cần Playwright thật). */
export interface PwPage {
 goto(url: string, o?: {waitUntil?: string}): Promise<unknown>;
}
export interface PwContext {
 newPage(): Promise<PwPage>;
 cookies(urls?: string[]): Promise<Array<Record<string, unknown>>>;
}
export interface PwBrowser {
 newContext(): Promise<PwContext>;
 close(): Promise<void>;
}
export interface PwModule {
 chromium: {launch(o: {headless: boolean}): Promise<PwBrowser>};
}

export const FACEBOOK_URL = 'https://www.facebook.com/';
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
export const LOGIN_POLL_MS = 1000;

export interface LoginDeps {
 /** Mặc định: import('playwright'). Phải ném nếu không có. */
 importPlaywright?: () => Promise<unknown>;
 sleep?: (ms: number) => Promise<void>;
 now?: () => number;
 timeoutMs?: number;
 pollMs?: number;
}

const defaultImport = async (): Promise<unknown> => {
 const spec = 'playwright';
 return import(/* @vite-ignore */ spec);
};
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isPwModule(m: unknown): m is PwModule {
 const c = (m as {chromium?: {launch?: unknown}} | null)?.chromium;
 return typeof c?.launch === 'function';
}

function pickSessionCookies(all: Array<Record<string, unknown>>): StoredCookie[] | undefined {
 const fb = all.filter((c) => typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && /(^|\.)facebook\.com$/i.test(c.domain as string));
 const has = (n: string) => fb.some((c) => c.name === n && (c.value as string).length > 0);
 return has('c_user') && has('xs') ? (fb as unknown as StoredCookie[]) : undefined;
}

export async function runMessengerLogin(deps: LoginDeps = {}, signal?: AbortSignal): Promise<LoginResult> {
 const sleep = deps.sleep ?? defaultSleep;
 const now = deps.now ?? Date.now;
 let pw: unknown;
 try {
  pw = await (deps.importPlaywright ?? defaultImport)();
 } catch {
  return {ok: false, reason: 'playwright-missing'};
 }
 const mod = isPwModule(pw) ? pw : isPwModule((pw as {default?: unknown} | null)?.default) ? (pw as {default: PwModule}).default : undefined;
 if (!mod) return {ok: false, reason: 'playwright-missing'};

 let browser: PwBrowser;
 let context: PwContext;
 try {
  browser = await mod.chromium.launch({headless: false});
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(FACEBOOK_URL, {waitUntil: 'domcontentloaded'});
 } catch {
  return {ok: false, reason: 'launch-failed'};
 }
 try {
  const deadline = now() + (deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  while (!signal?.aborted && now() < deadline) {
   const cookies = pickSessionCookies(await context.cookies([FACEBOOK_URL]));
   if (cookies) return {ok: true, cookies};
   await sleep(deps.pollMs ?? LOGIN_POLL_MS);
  }
  return {ok: false, reason: signal?.aborted ? 'cancelled' : 'timeout'};
 } catch {
  return {ok: false, reason: 'launch-failed'};
 } finally {
  await browser.close().catch(() => undefined);
 }
}

export type LoginPhase = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface LoginStatus {
 phase: LoginPhase;
 reason: LoginFailure | null;
}

/** Bộ điều khiển một phiên đăng nhập tại một thời điểm; cookie đi thẳng vào onCookies, không nằm trong status. */
export function createLoginController(deps: LoginDeps & {onCookies: (cookies: StoredCookie[]) => Promise<boolean>}) {
 let status: LoginStatus = {phase: 'idle', reason: null};
 let abort: AbortController | undefined;

 function start(): LoginStatus {
  if (status.phase === 'running') return status;
  abort = new AbortController();
  status = {phase: 'running', reason: null};
  const mine = abort;
  void runMessengerLogin(deps, mine.signal)
   .then(async (r) => {
    if (abort !== mine) return;
    if (r.ok) status = (await deps.onCookies(r.cookies).catch(() => false)) ? {phase: 'succeeded', reason: null} : {phase: 'failed', reason: 'launch-failed'};
    else status = r.reason === 'cancelled' ? {phase: 'cancelled', reason: null} : {phase: 'failed', reason: r.reason};
   })
   .catch(() => {
    if (abort === mine) status = {phase: 'failed', reason: 'launch-failed'};
   });
  return status;
 }
 const get = (): LoginStatus => status;
 function cancel(): LoginStatus {
  if (status.phase === 'running') {
   abort?.abort();
   status = {phase: 'cancelled', reason: null};
  }
  return status;
 }
 return {start, status: get, cancel};
}
