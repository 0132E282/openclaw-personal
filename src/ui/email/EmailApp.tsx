import {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode} from 'react';
import {usePoll} from '../poll';
import {Compose, type ComposeInit} from './Compose';
import {MessageList} from './MessageList';
import {NotConnected} from './NotConnected';
import {Reading} from './Reading';
import {BULK_ACTIONS, EMPTY_SELECTION, applySelection, filterMessages, groupMessages, selectAll, textToHtml, type ActionDef, type Selection} from './helpers';
import type {Account, Draft, EmailProvider, Folder, Message} from './provider';

export interface EmailAppProps {
 provider?: EmailProvider;
 /** Thư mục do shell điều khiển; bỏ trống thì tự giữ trạng thái (và hiện thanh chọn thư mục gọn). */
 folder?: Folder;
 onFolderChange?: (folder: Folder) => void;
 onConnect?: () => void;
 onLearnMore?: () => void;
 notConnectedExtra?: ReactNode;
 /** Tăng giá trị để mở màn soạn thư từ bên ngoài (ví dụ mục Soạn thư ở sidebar). */
 composeRequest?: number;
 /** Id tài khoản cần xem riêng (từ sidebar); bỏ trống hoặc không khớp thì gộp tất cả tài khoản. */
 accountFilter?: string;
 now?: () => Date;
 /** Chu kỳ làm mới danh sách thư (ms) khi tab hiển thị; 0 để tắt. Không đóng thư đang đọc/soạn. */
 pollMs?: number;
}
const DEFAULT_POLL_MS = 60_000;
const sameList = (a: readonly Message[], b: readonly Message[]) => a.length === b.length && a.every((m, i) => m.id === b[i].id && m.unread === b[i].unread && m.subject === b[i].subject);
const FOLDER_TABS: ReadonlyArray<[Folder, string]> = [['all', 'Tất cả'], ['unread', 'Chưa đọc'], ['stranger', 'Người lạ'], ['blocked', 'Đã chặn'], ['spam', 'Spam'], ['trash', 'Thùng rác']];

/** Danh sách thư đã tải theo (provider, thư mục, tài khoản): đổi thư mục/mở lại hiện ngay, không chờ Gmail. */
const listCache = new WeakMap<object, Map<string, Message[]>>();

export function EmailApp({provider, folder: folderProp, onFolderChange, onConnect, onLearnMore, notConnectedExtra, composeRequest, accountFilter, now, pollMs = DEFAULT_POLL_MS}: EmailAppProps) {
 const [inner, setInner] = useState<Folder>('all');
 const folder = folderProp ?? inner;
 const [accounts, setAccounts] = useState<readonly Account[] | null>(null);
 const [active, setActive] = useState<readonly string[]>([]);
 const [messages, setMessages] = useState<readonly Message[]>([]);
 const [openId, setOpenId] = useState<string | null>(null);
 const [detail, setDetail] = useState<Message | null>(null);
 const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
 const [composing, setComposing] = useState<ComposeInit | null>(null);
 useEffect(() => { if (composeRequest) { setOpenId(null); setComposing({}); } }, [composeRequest]);
 const [menu, setMenu] = useState(false);
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const [tick, setTick] = useState(0);
 const [syncedAt, setSyncedAt] = useState<Date | null>(null);
 const clock = now ?? (() => new Date());

 useEffect(() => {
  if (!provider) { setAccounts([]); return; }
  let live = true;
  provider.listAccounts().then(a => { if (live) setAccounts(a); }, () => { if (live) setAccounts([]); });
  return () => { live = false; };
 }, [provider]);

 useEffect(() => {
  if (accounts) setActive(accountFilter && accounts.some(a => a.id === accountFilter) ? [accountFilter] : accounts.map(a => a.id));
 }, [accounts, accountFilter]);

 const activeKey = active.join('|');
 useEffect(() => {
  if (!provider || !active.length) { setMessages([]); return; }
  let live = true;
  // Hiện ngay danh sách đã tải lần trước (nếu có) rồi làm mới nền, thay vì để trống chờ mạng.
  const cacheKey = `${folder}|${activeKey}`;
  const cached = listCache.get(provider)?.get(cacheKey);
  if (cached) setMessages(cached);
  provider.listMessages({accountIds: active, folder}).then(m => {
   if (!live) return;
   const next = filterMessages(m, folder);
   if (!listCache.has(provider)) listCache.set(provider, new Map());
   listCache.get(provider)!.set(cacheKey, next);
   setMessages(cur => (cached && sameList(cur, next) ? cur : next)); setSyncedAt(clock()); setError('');
  }, () => { if (live) setError('Không tải được thư.'); });
  return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [provider, folder, activeKey, tick]);

 const view = useRef({active, folder});
 view.current = {active, folder};
 usePoll(async isLive => {
  if (!provider) return;
  const {active: ids, folder: f} = view.current;
  const m = await provider.listMessages({accountIds: ids, folder: f});
  if (!isLive() || view.current.folder !== f || view.current.active.join('|') !== ids.join('|')) return;
  const next = filterMessages(m, f);
  setMessages(cur => (sameList(cur, next) ? cur : next));
  setSyncedAt(clock());
 }, pollMs, !!provider && active.length > 0);

 useEffect(() => { setOpenId(null); setDetail(null); setSel(EMPTY_SELECTION); }, [folder]);
 useEffect(() => {
  if (!provider || !openId) { setDetail(null); return; }
  let live = true;
  provider.getMessage(openId).then(m => { if (live) { setDetail(m); setError(''); } }, (e: unknown) => { if (live) setError(`Không mở được thư (${e instanceof Error ? e.message : 'lỗi'}).`); });
  return () => { live = false; };
 }, [provider, openId]);

 const groups = useMemo(() => groupMessages(messages, folder, clock()), [messages, folder]);
 const order = useMemo(() => groups.flatMap(g => g.items.map(m => m.id)), [groups]);
 const changeFolder = (f: Folder) => { setInner(f); onFolderChange?.(f); };

 const run = useCallback(async (a: ActionDef, ids: readonly string[]) => {
  if (!provider || !ids.length) return;
  setBusy(true); setError('');
  try {
   if (a.act === 'read') await provider.markRead(ids, true); else await provider.moveToFolder(ids, a.act);
   setSel(EMPTY_SELECTION); setOpenId(null); setTick(t => t + 1);
  } catch { setError('Thao tác không thành công.'); } finally { setBusy(false); }
 }, [provider]);

 const onRow = (id: string, e: MouseEvent) => {
  if (e.shiftKey || e.ctrlKey || e.metaKey) { setSel(s => applySelection(order, s, id, {shift: e.shiftKey, meta: e.ctrlKey || e.metaKey})); return; }
  setSel(EMPTY_SELECTION); setComposing(null); setOpenId(id);
  const m = messages.find(x => x.id === id);
  if (m?.unread && provider) {
   setMessages(list => list.map(x => (x.id === id ? {...x, unread: false} : x)));
   provider.markRead([id], true).catch(() => setError('Không đánh dấu đã đọc được.'));
  }
 };
 const toggle = (id: string) => setSel(s => applySelection(order, s, id, {meta: true}));
 const sendDraft = async (d: Draft) => { await provider?.send(d); setComposing(null); setTick(t => t + 1); };
 const reply = async (text: string) => {
  if (!detail || !provider) return;
  try { await provider.send({accountId: detail.accountId, to: [detail.from.address], cc: [], bcc: [], subject: /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`, html: textToHtml(text), attachments: [], replyToId: detail.id}); } catch { setError('Không gửi được trả lời.'); throw new Error('send'); }
 };

 if (accounts === null) return <div className="op-email op-email--loading" role="status">Đang tải…</div>;
 if (!provider || !accounts.length) return <div className="op-email"><NotConnected onConnect={onConnect} onLearnMore={onLearnMore} extra={notConnectedExtra} /></div>;

 const chosen = [...sel.selected];
 const bulk = BULK_ACTIONS[folder];
 const sync = syncedAt ? ` · đồng bộ lúc ${syncedAt.getHours()}:${String(syncedAt.getMinutes()).padStart(2, '0')}` : '';
 const bulkButtons = bulk.map(a => <button key={a.label} type="button" disabled={busy} className={`op-email__btn${a.tone === 'primary' ? ' op-email__btn--primary' : a.tone === 'danger' ? ' op-email__btn--danger' : ''}`} onClick={() => run(a, chosen)}>{a.label}</button>);
 const toggleAccount = (id: string) => setActive(cur => (cur.includes(id) ? (cur.length > 1 ? cur.filter(x => x !== id) : cur) : [...cur, id]));
 const forward = () => detail && setComposing({subject: /^fwd:/i.test(detail.subject) ? detail.subject : `Fwd: ${detail.subject}`, html: `<p><br></p><blockquote>${detail.html ? '' : textToHtml(detail.text ?? detail.snippet)}</blockquote>`});

 let right;
 if (composing) right = <Compose key="compose" accounts={accounts} init={composing} onSend={sendDraft} onSaveDraft={provider.saveDraft?.bind(provider)} onClose={() => setComposing(null)} />;
 else if (sel.selected.size) right = <section className="op-email__reading op-email__bulk"><h2>Đã chọn {sel.selected.size} thư</h2><p>Thao tác áp dụng cho tất cả mục đã chọn.</p><div className="op-email__row">{bulkButtons}</div><small className="op-email__muted">Bỏ chọn để xem từng mục.</small></section>;
 else if (detail && openId === detail.id) right = <Reading key={detail.id} message={detail} folder={folder} busy={busy} onAction={a => run(a, [detail.id])} onForward={forward} onReply={reply} />;
 else right = <section className="op-email__reading op-email__bulk"><p className="op-email__muted">Chọn một thư để đọc.</p></section>;

 return (
  <div className="op-email">
   <div className="op-email__strip">
    <span>{accounts.filter(a => active.includes(a.id)).map(a => <span key={a.id} className="op-email__acct"><i className="op-email__dot" style={{background: a.color}} />{a.address}</span>)} · đang xem {active.length}/{accounts.length} tài khoản{sync}</span>
    <button type="button" className="op-email__link" onClick={() => setTick(t => t + 1)}>Làm mới</button>
   </div>
   {error && <p className="op-email__error" role="alert">{error}</p>}
   {folderProp === undefined && <nav className="op-email__tabs" aria-label="Thư mục">{FOLDER_TABS.map(([f, label]) => <button key={f} type="button" aria-current={f === folder} onClick={() => changeFolder(f)}>{label}</button>)}</nav>}
   <div className="op-email__main">
    <section className="op-email__list" aria-label="Danh sách thư">
     {sel.selected.size ? (
      <div className="op-email__bulkbar">
       <div className="op-email__line"><span className="op-email__check is-on" aria-hidden="true">−</span><strong>Đã chọn {sel.selected.size}</strong>
        <button type="button" className="op-email__link" onClick={() => setSel(selectAll(order))}>Chọn tất cả</button>
        <button type="button" className="op-email__icon" aria-label="Bỏ chọn" onClick={() => setSel(EMPTY_SELECTION)}>×</button></div>
       <div className="op-email__row">{bulkButtons}</div>
       <small className="op-email__muted">Shift + click: chọn cả dải · Ctrl/⌘ + click: chọn thêm từng hàng</small>
      </div>
     ) : (
      <div className="op-email__listhead">
       {folder === 'all' && <button type="button" className="op-email__btn op-email__btn--primary" onClick={() => { setOpenId(null); setComposing({}); }}>Soạn thư</button>}
       <span className="op-email__accounts">
        <button type="button" className="op-email__btn" aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu(m => !m)}>
         {accounts.filter(a => active.includes(a.id)).map(a => <i key={a.id} className="op-email__dot" style={{background: a.color}} />)} {active.length} tài khoản ▾
        </button>
        {menu && <div className="op-email__menu" role="group" aria-label="Tài khoản">{accounts.map(a => <label key={a.id}><input type="checkbox" checked={active.includes(a.id)} onChange={() => toggleAccount(a.id)} /><i className="op-email__dot" style={{background: a.color}} />{a.address}</label>)}</div>}
       </span>
      </div>
     )}
     <MessageList groups={groups} accounts={accounts} folder={folder} openId={openId} selected={sel.selected} now={clock()} onRow={onRow} onToggle={toggle} />
    </section>
    {right}
   </div>
  </div>
 );
}
