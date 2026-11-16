import {requestWithTimeout, type PluginHost} from '../../host';
import type {Account, Draft, EmailProvider, Folder, Message, MoveAction} from './provider';

const PLUGIN_ID = 'openclaw-personal';
const COLORS = ['#e11d48', '#0284c7', '#16a34a', '#d97706', '#7c3aed'];

/** Gọi một operation của plugin qua host; ném lỗi nếu host báo thất bại. */
export async function callOp<T>(host: PluginHost, actionId: string, payload: unknown = {}, timeoutMs = 30_000): Promise<T> {
 const res = (await requestWithTimeout(host, 'plugins.sessionAction', {pluginId: PLUGIN_ID, actionId, payload}, timeoutMs)) as {ok?: boolean; result?: unknown; error?: {code?: unknown; message?: unknown}} | null;
 if (!res || res.ok !== true) throw new Error(String(res?.error?.code ?? res?.error?.message ?? 'operation-failed').slice(0, 80));
 return res.result as T;
}

interface RemoteAccount {id: string; address: string; needsReauth: boolean}

/** Provider email thật: đi qua các operation `gmail.*` của backend plugin. */
export function createHostEmailProvider(host: PluginHost): EmailProvider {
 const owner = new Map<string, string>();
 let onlyAccount: string | undefined;
 const accountOf = (id: string) => {
  const a = owner.get(id) ?? onlyAccount;
  if (!a) throw new Error('unknown-message');
  return a;
 };
 const byAccount = (ids: readonly string[]) => {
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(accountOf(id), [...(groups.get(accountOf(id)) ?? []), id]);
  return groups;
 };
 return {
  async listAccounts(): Promise<readonly Account[]> {
   const r = await callOp<{accounts: RemoteAccount[]}>(host, 'gmail.accounts.list');
   onlyAccount = r.accounts.length === 1 ? r.accounts[0].id : undefined;
   return r.accounts.map((a, i) => ({id: a.id, address: a.address, color: COLORS[i % COLORS.length]}));
  },
  async listMessages({accountIds, folder}: {accountIds: readonly string[]; folder: Folder}) {
   const lists = await Promise.all(accountIds.map(accountId => callOp<{messages: Message[]}>(host, 'gmail.messages.list', {accountId, folder, limit: 30})));
   const all = lists.flatMap(l => l.messages);
   for (const m of all) owner.set(m.id, m.accountId);
   return all.sort((a, b) => b.date.localeCompare(a.date));
  },
  async getMessage(id: string) {
   const m = await callOp<Message>(host, 'gmail.messages.get', {accountId: accountOf(id), id});
   owner.set(m.id, m.accountId);
   return m;
  },
  async send(draft: Draft) {
   const r = await callOp<{ok: boolean}>(host, 'gmail.messages.send', {accountId: draft.accountId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, html: draft.html, replyToId: draft.replyToId});
   if (!r.ok) throw new Error('send-failed');
  },
  async moveToFolder(ids: readonly string[], action: MoveAction) {
   for (const [accountId, group] of byAccount(ids)) {
    const r = await callOp<{ok: boolean}>(host, 'gmail.messages.move', {accountId, ids: group, action});
    if (!r.ok) throw new Error('move-failed');
   }
  },
  async markRead(ids: readonly string[], read: boolean) {
   for (const [accountId, group] of byAccount(ids)) {
    const r = await callOp<{ok: boolean}>(host, 'gmail.messages.move', {accountId, ids: group, action: read ? 'markRead' : 'markUnread'});
    if (!r.ok) throw new Error('mark-failed');
   }
  },
 };
}
