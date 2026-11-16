/**
 * Nối các module Gmail thành handler cho operation `gmail.*`. Khởi tạo lười để không chạm
 * kho bí mật/mạng khi plugin chỉ được nạp. Token không bao giờ nằm trong giá trị trả về.
 */
import {createSdkSecretFileIO} from '../cookieStore';
import {API_BASE, GmailError, createGmailClient, type GmailClient} from './gmailClient';
import {createAuthController, createNodeServerFactory, type AuthController, type FetchLike} from './oauth';
import {createTokenStore, type TokenStore} from './tokenStore';
import {GMAIL_OPERATION_IDS as ID} from './contract';

export interface GmailServiceDeps {
 /** Thư mục gốc kho bí mật của plugin (tạo nếu chưa có). */
 rootDir: string;
}

const reasonOf = (e: unknown): string => (e instanceof GmailError ? e.code : 'network');

async function openBrowser(url: string): Promise<void> {
 const cp = 'node:child_process';
 const {execFile} = (await import(/* @vite-ignore */ cp)) as {execFile(f: string, a: string[], cb: (e: Error | null) => void): void};
 const platform = (globalThis as {process?: {platform?: string}}).process?.platform;
 const [file, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
 await new Promise<void>((resolve, reject) => execFile(file as string, args as string[], (e) => (e ? reject(e) : resolve())));
}

export function createGmailHandlers(deps: GmailServiceDeps) {
 let ready: Promise<{store: TokenStore; client: GmailClient; auth: AuthController}> | undefined;
 const init = () => (ready ??= (async () => {
  const fsp = await import(/* @vite-ignore */ 'node:fs/promises' as string) as {mkdir(p: string, o: object): Promise<unknown>; unlink(p: string): Promise<void>};
  await fsp.mkdir(deps.rootDir, {recursive: true, mode: 0o700});
  const io = await createSdkSecretFileIO(deps.rootDir, fsp);
  const store = createTokenStore({io, dir: deps.rootDir});
  const fetchLike = fetch as unknown as FetchLike;
  const client = createGmailClient({fetch: fetchLike, store});
  const auth = createAuthController({
   fetch: fetchLike,
   now: Date.now,
   createServer: await createNodeServerFactory(),
   openBrowser,
   async onTokens(tokens, ctx) {
    const res = await fetchLike(`${API_BASE}/profile`, {headers: {authorization: `Bearer ${tokens.accessToken}`}});
    const body = (await res.json()) as {emailAddress?: unknown};
    if (!res.ok || typeof body.emailAddress !== 'string') throw new GmailError('auth-failed');
    const saved = await store.save({address: body.emailAddress, clientId: ctx.clientId, clientSecret: ctx.clientSecret, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, scope: tokens.scope});
    if (!saved.ok) throw new GmailError('auth-failed');
    return {accountId: saved.id, address: body.emailAddress};
   },
  });
  return {store, client, auth};
 })());

 return {
  [ID.authStart]: async (input: {clientId?: string; clientSecret?: string}) => {
   const {store, auth} = await init();
   if (input.clientId) return auth.start({clientId: input.clientId, clientSecret: input.clientSecret});
   // Không nhập lại Client ID: dùng lại cái đã lưu cùng tài khoản đầu tiên.
   for (const acc of await store.list()) {
    const rec = await store.load(acc.id);
    if (rec?.clientId) return auth.start({clientId: rec.clientId, clientSecret: rec.clientSecret});
   }
   return auth.start({clientId: ''});
  },
  [ID.authStatus]: async () => (await init()).auth.status(),
  [ID.authCancel]: async () => (await init()).auth.cancel(),
  [ID.accountsList]: async () => ({accounts: (await (await init()).store.list()).map(a => ({id: a.id, address: a.address, savedAt: a.savedAt, needsReauth: a.needsReauth}))}),
  [ID.accountsRemove]: async (input: {accountId: string}) => {
   const r = await (await init()).store.remove(input.accountId);
   return r.ok ? {ok: true} : {ok: false, reason: r.reason === 'invalid-account' ? 'invalid-account' : 'io-error'};
  },
  [ID.messagesList]: async (input: {accountId: string; folder: 'all' | 'unread' | 'stranger' | 'blocked' | 'spam' | 'trash'; limit?: number; pageToken?: string}) => {
   const {accountId, ...rest} = input;
   return (await init()).client.listMessages(accountId, rest);
  },
  [ID.messagesGet]: async (input: {accountId: string; id: string}) => (await init()).client.getMessage(input.accountId, input.id),
  [ID.messagesMove]: async (input: {accountId: string; ids: string[]; action: string}) => {
   const {client} = await init();
   try {
    if (input.action === 'markRead' || input.action === 'markUnread') await client.markRead(input.accountId, input.ids, input.action === 'markRead');
    else await client.moveToFolder(input.accountId, input.ids, input.action as Parameters<GmailClient['moveToFolder']>[2]);
    return {ok: true};
   } catch (e) {
    return {ok: false, reason: reasonOf(e)};
   }
  },
  [ID.messagesSend]: async (input: {accountId: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text?: string; html?: string; replyToId?: string}) => {
   const {accountId, ...mail} = input;
   try {
    const r = await (await init()).client.send(accountId, {...mail, cc: mail.cc ?? [], bcc: mail.bcc ?? []} as Parameters<GmailClient['send']>[1]);
    return {ok: true, id: r.id};
   } catch (e) {
    return {ok: false, reason: reasonOf(e)};
   }
  },
 };
}
