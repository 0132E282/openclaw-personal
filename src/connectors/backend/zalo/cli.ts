/**
 * Gọi CLI `openclaw` (mảng đối số, không shell, có timeout). Runner được tiêm để test không chạm CLI thật.
 * Nội dung tin nhắn không bao giờ vào log hay thông báo lỗi.
 */
import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {isZaloImageUrl} from './avatars';
import {ZALO_CHANNEL, ZALO_ACCOUNT_ID_PATTERN, ZALO_NEW_ACCOUNT_PATTERN} from './contract';

export interface RunResult {
 code: number | null;
 stdout: string;
 stderr: string;
 timedOut?: boolean;
 /** Không tìm thấy file thực thi. */
 missing?: boolean;
}
export type Runner = (file: string, args: string[], opts: {timeoutMs: number}) => Promise<RunResult>;

export type CliErrorCode = 'cli-missing' | 'timeout' | 'failed';
export class ZaloCliError extends Error {
 constructor(readonly code: CliErrorCode) {
  super(code);
 }
}

export interface DirectoryEntry {
 id: string;
 name: string;
 kind: 'direct' | 'group';
 memberCount?: number;
 /** URL ảnh đại diện (đã kiểm tra là https tới CDN Zalo). */
 avatarUrl?: string;
}

const ID_RE = /^(group:)?[0-9A-Za-z_-]{1,64}$/;
const ACCOUNT_RE = new RegExp(ZALO_ACCOUNT_ID_PATTERN);
const NEW_ACCOUNT_RE = new RegExp(ZALO_NEW_ACCOUNT_PATTERN);
/** Tài khoản mặc định: CLI tự chọn khi không có `--account`. */
const DEFAULT_ACCOUNT = 'default';
const accountArgs = (accountId?: string): string[] => (accountId && accountId !== DEFAULT_ACCOUNT ? ['--account', accountId] : []);
/** CLI directory chậm (peers ~100s, groups ~50s trên máy thật). */
const LIST_TIMEOUT_MS = 300_000;
const SEND_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 120_000;

/** CLI in dòng '[plugins] ...' và cảnh báo trước JSON: thử parse từ từng dòng bắt đầu bằng '[' hoặc '{'. */
export function extractJson(text: string): unknown {
 const lines = text.split('\n');
 let offset = 0;
 for (const line of lines) {
  const start = offset;
  offset += line.length + 1;
  if (!/^[[{]/.test(line)) continue;
  const tail = text.slice(start);
  try {
   return JSON.parse(tail);
  } catch {
   // dòng cảnh báo bắt đầu bằng '[' hoặc JSON còn rác phía sau: thử cắt tới ký tự đóng cuối.
   const end = Math.max(tail.lastIndexOf(']'), tail.lastIndexOf('}'));
   if (end > 0) {
    try {
     return JSON.parse(tail.slice(0, end + 1));
    } catch {
     // thử dòng kế tiếp
    }
   }
  }
 }
 throw new ZaloCliError('failed');
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Chuẩn hóa mảng directory; bỏ phần tử sai dạng thay vì ném. */
export function parseDirectory(json: unknown, kind: 'direct' | 'group'): DirectoryEntry[] {
 if (!Array.isArray(json)) throw new ZaloCliError('failed');
 const out: DirectoryEntry[] = [];
 for (const raw of json) {
  if (!isRec(raw) || typeof raw.id !== 'string') continue;
  const id = kind === 'group' && !raw.id.startsWith('group:') ? `group:${raw.id}` : raw.id;
  if (!ID_RE.test(id)) continue;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : id;
  const entry: DirectoryEntry = {id, name, kind};
  if (typeof raw.avatarUrl === 'string' && raw.avatarUrl.length <= 600 && isZaloImageUrl(raw.avatarUrl)) entry.avatarUrl = raw.avatarUrl;
  const count = isRec(raw.raw) ? raw.raw.memberCount : undefined;
  if (kind === 'group' && typeof count === 'number' && Number.isFinite(count) && count >= 0) entry.memberCount = Math.floor(count);
  out.push(entry);
 }
 return out;
}

export interface CliDeps {
 run: Runner;
 /** Danh sách file thực thi thử lần lượt khi báo thiếu. */
 bins?: readonly string[];
}

export function defaultBins(env: Record<string, string | undefined>): string[] {
 return [...(env.OPENCLAW_BIN ? [env.OPENCLAW_BIN] : []), 'openclaw', join(homedir(), '.openclaw', 'bin', 'openclaw')];
}

export function createZaloCli(deps: CliDeps) {
 const bins = deps.bins?.length ? deps.bins : ['openclaw'];
 async function exec(args: string[], timeoutMs: number): Promise<RunResult> {
  let last: RunResult | undefined;
  for (const bin of bins) {
   last = await deps.run(bin, args, {timeoutMs});
   if (!last.missing) break;
  }
  if (!last || last.missing) throw new ZaloCliError('cli-missing');
  if (last.timedOut) throw new ZaloCliError('timeout');
  if (last.code !== 0) throw new ZaloCliError('failed');
  return last;
 }
 async function list(kind: 'direct' | 'group', accountId?: string): Promise<DirectoryEntry[]> {
  if (accountId && !ACCOUNT_RE.test(accountId)) throw new ZaloCliError('failed');
  const sub = kind === 'group' ? 'groups' : 'peers';
  const r = await exec(['directory', sub, 'list', '--channel', ZALO_CHANNEL, ...accountArgs(accountId), '--json'], LIST_TIMEOUT_MS);
  return parseDirectory(extractJson(r.stdout), kind);
 }
 /** Dùng dạng `--opt=value` để nội dung bắt đầu bằng '-' không bị hiểu thành tùy chọn. */
 async function send(conversationId: string, text: string, accountId?: string): Promise<void> {
  if (!ID_RE.test(conversationId) || !text.trim() || (accountId && !ACCOUNT_RE.test(accountId))) throw new ZaloCliError('failed');
  await exec(['message', 'send', '--channel', ZALO_CHANNEL, ...accountArgs(accountId), `--target=${conversationId}`, `--message=${text}`, '--json'], SEND_TIMEOUT_MS);
 }
 /** Chỉ gọi khi người dùng bấm Bật: ghi cờ cho phép plugin đọc hội thoại. */
 async function enableHistory(): Promise<void> {
  await exec(['config', 'set', 'plugins.entries.openclaw-personal.hooks.allowConversationAccess', 'true', '--strict-json'], CONFIG_TIMEOUT_MS);
 }
 /** Chỉ gọi khi người dùng bấm Thêm tài khoản: tạo cấu hình tài khoản zalouser (profile = id, DM mở theo lựa chọn của người dùng). */
 async function addAccount(id: string): Promise<void> {
  if (!NEW_ACCOUNT_RE.test(id) || id === DEFAULT_ACCOUNT) throw new ZaloCliError('failed');
  const value = JSON.stringify({enabled: true, profile: id, dmPolicy: 'open', allowFrom: ['*']});
  await exec(['config', 'set', `channels.${ZALO_CHANNEL}.accounts.${id}`, value, '--strict-json'], CONFIG_TIMEOUT_MS);
 }
 /** Chỉ gọi khi người dùng xác nhận; không bao giờ gỡ 'default'. */
 async function removeAccount(id: string): Promise<void> {
  if (!ACCOUNT_RE.test(id) || id === DEFAULT_ACCOUNT) throw new ZaloCliError('failed');
  await exec(['config', 'unset', `channels.${ZALO_CHANNEL}.accounts.${id}`], CONFIG_TIMEOUT_MS);
 }
 return {list, send, enableHistory, addAccount, removeAccount};
}
export type ZaloCli = ReturnType<typeof createZaloCli>;

/** Runner thật dựa trên execFile: không shell, giới hạn bộ đệm, không chặn khi lỗi. */
export const nodeRunner: Runner = (file, args, opts) =>
 new Promise((resolve) => {
  execFile(file, args, {timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env, windowsHide: true}, (err, stdout, stderr) => {
   if (!err) return resolve({code: 0, stdout: String(stdout), stderr: String(stderr)});
   const e = err as NodeJS.ErrnoException & {killed?: boolean; code?: number | string};
   if (e.code === 'ENOENT') return resolve({code: null, stdout: '', stderr: '', missing: true});
   const timedOut = e.killed === true;
   resolve({code: typeof e.code === 'number' ? e.code : 1, stdout: String(stdout ?? ''), stderr: '', timedOut});
  });
 });
