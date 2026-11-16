/// <reference types="node" />
/**
 * Quản lý tiến trình `openclaw-personal-core` (Rust) và gọi RPC cục bộ. Mọi phụ thuộc (spawn, fetch, token)
 * được tiêm vào để test không cần tiến trình thật. Token chỉ đi qua biến môi trường của tiến trình con và
 * header HTTP; không bao giờ nằm trong argv, log hay thông điệp lỗi.
 */
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export type CoreErrorCode = 'core-missing' | 'core-start-failed' | 'core-start-timeout' | 'core-unhealthy' | 'core-died' | 'core-unreachable' | 'core-timeout' | 'core-bad-response' | string;

export class CoreError extends Error {
 constructor(readonly code: CoreErrorCode, message: string) {
  super(message);
  this.name = 'CoreError';
 }
}

/** Phần tối thiểu của ChildProcess mà client dùng. */
export interface CoreChild {
 stdout: {on(event: 'data', cb: (chunk: unknown) => void): unknown} | null;
 on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): unknown;
 kill(signal?: string): unknown;
}
export type SpawnLike = (file: string, args: string[], options: {env: Record<string, string | undefined>; stdio: ['pipe', 'pipe', 'ignore']}) => CoreChild;
export type FetchLike = (url: string, init: {method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal}) => Promise<{json(): Promise<unknown>}>;

export interface CoreProcessOptions {
 /** Đường dẫn binary; undefined nghĩa là không có -> mọi lệnh gọi lỗi 'core-missing'. */
 binaryPath: string | undefined;
 stateDir: string;
 spawn: SpawnLike;
 fetch: FetchLike;
 randomToken?: () => string;
 env?: Record<string, string | undefined>;
 startTimeoutMs?: number;
 callTimeoutMs?: number;
}

export interface CoreProcess {
 call(op: string, input: unknown): Promise<unknown>;
 stop(): void;
}

interface Running {
 port: number;
 token: string;
 child: CoreChild;
 alive: boolean;
}

const TOKEN_HEADER = 'x-opcore-token';

/** Tìm binary theo thứ tự: env, release, debug. */
export function resolveCoreBinary(opts: {env: Record<string, string | undefined>; pluginRoot: string; exists?: (p: string) => boolean}): string | undefined {
 const exists = opts.exists ?? existsSync;
 const name = 'openclaw-personal-core';
 const candidates = [opts.env.OPENCLAW_PERSONAL_CORE_BIN, join(opts.pluginRoot, 'core', 'target', 'release', name), join(opts.pluginRoot, 'core', 'target', 'debug', name)];
 return candidates.find((p): p is string => !!p && exists(p));
}

export function createCoreProcess(opts: CoreProcessOptions): CoreProcess {
 const startTimeout = opts.startTimeoutMs ?? 10_000;
 const callTimeout = opts.callTimeoutMs ?? 30_000;
 const makeToken = opts.randomToken ?? (() => randomBytes(32).toString('hex'));
 let running: Running | undefined;
 let starting: Promise<Running> | undefined;
 let restarts = 0;
 let everStarted = false;
 let stopped = false;

 const redact = (s: string, token?: string) => (token ? s.split(token).join('[redacted]') : s);

 const kill = (r: Running) => {
  r.alive = false;
  try {
   r.child.kill('SIGTERM');
  } catch {
   /* đã thoát */
  }
 };

 async function post(r: Running, path: string, method: string, body?: string, ms = callTimeout): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
   const res = await opts.fetch(`http://127.0.0.1:${r.port}${path}`, {method, headers: {[TOKEN_HEADER]: r.token, 'content-type': 'application/json'}, body, signal: ctl.signal});
   return await res.json();
  } catch {
   throw new CoreError(ctl.signal.aborted ? 'core-timeout' : 'core-unreachable', ctl.signal.aborted ? 'core: quá thời gian chờ' : 'core: không kết nối được');
  } finally {
   clearTimeout(timer);
  }
 }

 function launch(): Promise<Running> {
  if (!opts.binaryPath) return Promise.reject(new CoreError('core-missing', 'core: không tìm thấy binary openclaw-personal-core'));
  const token = makeToken();
  const binary = opts.binaryPath;
  return new Promise<Running>((resolve, reject) => {
   let child: CoreChild;
   try {
    child = opts.spawn(binary, [], {env: {...(opts.env ?? process.env), OPCORE_TOKEN: token, OPCORE_STATE_DIR: opts.stateDir, OPCORE_EXIT_ON_STDIN_CLOSE: '1'}, stdio: ['pipe', 'pipe', 'ignore']});
   } catch {
    reject(new CoreError('core-start-failed', 'core: không khởi động được'));
    return;
   }
   const r: Running = {port: 0, token, child, alive: true};
   let settled = false;
   let buf = '';
   const fail = (code: CoreErrorCode, msg: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    kill(r);
    reject(new CoreError(code, msg));
   };
   const timer = setTimeout(() => fail('core-start-timeout', 'core: quá thời gian chờ khởi động'), startTimeout);
   child.on('exit', () => {
    r.alive = false;
    if (running === r) running = undefined;
    fail('core-start-failed', 'core: tiến trình thoát trước khi sẵn sàng');
   });
   child.on('error', () => fail('core-start-failed', 'core: không khởi động được'));
   child.stdout?.on('data', (chunk) => {
    if (settled) return;
    buf += String(chunk);
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    let port: unknown;
    try {
     const line = JSON.parse(buf.slice(0, nl)) as {ready?: unknown; port?: unknown};
     port = line.ready === true ? line.port : undefined;
    } catch {
     port = undefined;
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
     fail('core-start-failed', 'core: dòng ready không hợp lệ');
     return;
    }
    r.port = port;
    settled = true;
    clearTimeout(timer);
    resolve(r);
   });
  }).then(async (r) => {
   const h = (await post(r, '/health', 'GET', undefined, startTimeout).catch(() => undefined)) as {ok?: unknown} | undefined;
   if (h?.ok !== true) {
    kill(r);
    throw new CoreError('core-unhealthy', 'core: health check thất bại');
   }
   return r;
  });
 }

 async function ensure(): Promise<Running> {
  if (stopped) throw new CoreError('core-died', 'core: đã dừng');
  if (running?.alive) return running;
  if (starting) return starting;
  if (everStarted) {
   if (restarts >= 1) throw new CoreError('core-died', 'core: tiến trình đã chết và đã khởi động lại một lần');
   restarts++;
  }
  const p = (starting = launch().then(
   (r) => {
    everStarted = true;
    running = r;
    starting = undefined;
    return r;
   },
   (e) => {
    starting = undefined;
    throw e;
   },
  ));
  return p;
 }

 async function call(op: string, input: unknown): Promise<unknown> {
  let r = await ensure();
  let body: unknown;
  try {
   body = await post(r, '/rpc', 'POST', JSON.stringify({op, input}));
  } catch (e) {
   if (!(e instanceof CoreError) || e.code !== 'core-unreachable') throw e;
   // Tiến trình có thể đã chết mà chưa có sự kiện exit: coi như chết, thử khởi động lại (tối đa một lần).
   kill(r);
   r = await ensure();
   body = await post(r, '/rpc', 'POST', JSON.stringify({op, input}));
  }
  const res = body as {ok?: unknown; result?: unknown; error?: {code?: unknown; message?: unknown}} | null;
  if (res?.ok === true) return res.result;
  if (res?.ok === false && res.error && typeof res.error.code === 'string') {
   throw new CoreError(res.error.code, redact(typeof res.error.message === 'string' ? res.error.message : 'core error', r.token).slice(0, 300));
  }
  throw new CoreError('core-bad-response', 'core: phản hồi không hợp lệ');
 }

 return {
  call,
  stop() {
   stopped = true;
   if (running) kill(running);
   running = undefined;
  },
 };
}

/** Spawn thật (chỉ dùng ở runtime, không dùng trong test). */
export const nodeSpawn: SpawnLike = (file, args, options) => spawn(file, args, options) as unknown as CoreChild;
