import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode} from 'react';
import {usePoll} from '../poll';
import {createAvatarCache, type AvatarCache} from './avatarCache';
import {NotConnected} from './NotConnected';
import {ChatError, FOLDER_LOCKED, type ChatAccess, type ChatAccount, type ChatChannel, type ChatConversation, type ChatFile, type ChatFolder, type ChatMessage, type ChatProvider, type BrowserLoginResult, type HistoryNotice, type MessengerCookies} from './provider';

export interface ChatAppProps {
  channel: ChatChannel;
  provider?: ChatProvider;
  folder: ChatFolder;
  onFolderChange?: (folder: ChatFolder) => void;
  onLinkQr?: () => void;
  onStartBrowserLogin?: () => void | Promise<BrowserLoginResult | void>;
  onCancelBrowserLogin?: () => void;
  onSubmitCookies?: (cookies: MessengerCookies) => void | Promise<void>;
  notConnectedExtra?: ReactNode;
  /** Chu kỳ làm mới (ms) khi tab hiển thị: tin của hội thoại đang mở và danh sách hội thoại; 0 để tắt. */
  pollMs?: {messages?: number; conversations?: number};
}

/** Tệp đi qua một khung JSON tới Gateway nên giữ nhỏ. */
const MAX_FILE_BYTES = 5_000_000;
const DEFAULT_POLL = {messages: 3000, conversations: 10_000};
const NEAR_BOTTOM = 48;

const CHANNEL_NAME = {zalo: 'Zalo', messenger: 'Messenger'} as const;
const FOLDERS: [ChatFolder, string][] = [['all', 'Tất cả'], ['unread', 'Chưa đọc'], ['group', 'Nhóm'], ['stranger', 'Người lạ'], ['blocked', 'Đã chặn'], ['spam', 'Spam']];
const FOLDER_LABEL: Record<ChatFolder, string> = {...Object.fromEntries(FOLDERS), stranger: 'Người lạ'} as Record<ChatFolder, string>;
const LOCK_TEXT: Record<string, string> = {
  stranger: 'Chấp nhận người này để trả lời và xem ảnh, liên kết.',
  spam: 'Cuộc trò chuyện bị đánh dấu spam. Chấp nhận hoặc bỏ spam để trả lời.',
  blocked: 'Bạn đã chặn người này. Bỏ chặn để nhắn tin.',
};

type ActionKey = 'acceptStranger' | 'block' | 'unblock' | 'markSpam' | 'notSpam' | 'deleteConversation';
interface Action {key: ActionKey; label: string; primary?: boolean}
const ACTIONS: Partial<Record<ChatFolder, Action[]>> = {
  stranger: [{key: 'acceptStranger', label: 'Chấp nhận', primary: true}, {key: 'block', label: 'Chặn'}, {key: 'markSpam', label: 'Báo spam'}],
  spam: [{key: 'notSpam', label: 'Không phải spam', primary: true}, {key: 'deleteConversation', label: 'Xóa vĩnh viễn'}, {key: 'block', label: 'Chặn'}],
  blocked: [{key: 'unblock', label: 'Bỏ chặn', primary: true}, {key: 'deleteConversation', label: 'Xóa'}],
};

const ACCESS_OPTIONS: [ChatAccess, string][] = [['write', 'Trợ lý AI: đọc và viết'], ['read', 'Trợ lý AI: chỉ đọc'], ['none', 'Trợ lý AI: không truy cập']];

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return 'Hôm nay';
  if (dayKey(d) === dayKey(yesterday)) return 'Hôm qua';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function listTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const label = dayLabel(iso, now);
  if (label === 'Hôm nay') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return label === 'Hôm qua' ? label : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const initials = (name: string) => name.trim().split(/\s+/).slice(-2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';

/** Ảnh tải theo yêu cầu, dùng blob URL (không nhúng data URI vào DOM); lỗi hoặc không có ảnh thì dùng chữ cái đầu. */
/** Nhóm không có ảnh (CLI Zalo không trả ảnh nhóm): biểu tượng nhóm thay cho chữ cái đầu. */
const GroupGlyph = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.2" /><path d="M3 19c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2" /><circle cx="17" cy="9" r="2.4" /><path d="M17 14c2.4 0 4.2 1.5 4.2 4" />
  </svg>
);

function Avatar({name, id, cache, group}: {name: string; id?: string; cache: AvatarCache; group?: boolean}) {
  const [src, setSrc] = useState<string | null>(id ? cache.peek(id) ?? null : null);
  useEffect(() => {
    if (!id) { setSrc(null); return; }
    if (cache.has(id)) { setSrc(cache.peek(id) ?? null); return; }
    let live = true;
    cache.load(id).then(v => { if (live) setSrc(v); });
    return () => { live = false; };
  }, [id, cache]);
  if (src) return <img className="op-chat__avatar op-chat__avatar--img" src={src} alt="" aria-hidden="true" />;
  if (group) return <span className="op-chat__avatar op-chat__avatar--group" aria-hidden="true"><GroupGlyph /></span>;
  return <span className="op-chat__avatar" aria-hidden="true">{initials(name)}</span>;
}

const sameMessages = (a: ChatMessage[], b: ChatMessage[]) => a.length === b.length && a.every((m, i) => m.id === b[i].id && m.text === b[i].text);
const sameConvs = (a: ChatConversation[], b: ChatConversation[]) => a.length === b.length && a.every((c, i) => {
  const d = b[i];
  return c.id === d.id && c.name === d.name && c.preview === d.preview && c.lastAt === d.lastAt && c.unread === d.unread && c.hasAvatar === d.hasAvatar && c.subtitle === d.subtitle;
});

export function ChatApp(props: ChatAppProps) {
  const {channel, provider, folder} = props;
  const name = CHANNEL_NAME[channel];
  const [accounts, setAccounts] = useState<ChatAccount[] | null>(null);
  const [convs, setConvs] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<ChatFile | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [access, setAccessValue] = useState<ChatAccess | null>(null);
  const anchor = useRef<string | null>(null);
  const avatars = useMemo(() => createAvatarCache(provider?.getAvatar), [provider]);
  useEffect(() => () => avatars.dispose(), [avatars]);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const poll = {...DEFAULT_POLL, ...props.pollMs};
  const reload = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    let live = true;
    setAccounts(null);
    if (!provider) { setAccounts([]); return; }
    provider.listAccounts().then(a => live && setAccounts(a), () => { if (live) { setAccounts([]); setError('Không đọc được danh sách tài khoản.'); } });
    return () => { live = false; };
  }, [provider]);

  const connected = !!accounts && accounts.length > 0;

  useEffect(() => {
    if (!provider || !connected) return;
    let live = true;
    setSelected([]);
    provider.listConversations({folder}).then(list => {
      if (!live) return;
      setError('');
      setConvs(list);
      setActiveId(cur => (cur && list.some(c => c.id === cur) ? cur : list[0]?.id ?? null));
    }, e => live && setError(e instanceof ChatError ? e.message : 'Không tải được danh sách hội thoại.'));
    return () => { live = false; };
  }, [provider, connected, folder, version]);

  useEffect(() => {
    if (!provider || !activeId) { setMessages([]); return; }
    let live = true;
    provider.getMessages(activeId).then(m => live && setMessages(m), e => live && setError(e instanceof ChatError ? e.message : 'Không tải được tin nhắn.'));
    return () => { live = false; };
  }, [provider, activeId, version]);

  // Sự kiện đẩy từ backend khi có tin mới: tải lại ngay, không đợi lượt polling.
  useEffect(() => provider?.onNewMessage?.(reload), [provider, reload]);

  const polling = !!provider && connected;
  usePoll(async isLive => {
    const id = activeRef.current;
    if (!provider || !id) return;
    const m = await provider.getMessages(id);
    if (isLive() && activeRef.current === id) setMessages(cur => (sameMessages(cur, m) ? cur : m));
  }, poll.messages, polling);
  usePoll(async isLive => {
    if (!provider) return;
    const list = await provider.listConversations({folder});
    if (isLive()) setConvs(cur => (sameConvs(cur, list) ? cur : list));
  }, poll.conversations, polling);

  useEffect(() => { atBottom.current = true; }, [activeId]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, activeId]);

  useEffect(() => {
    if (!provider?.getHistoryNotice || !activeId) { setNotice(null); return; }
    let live = true;
    provider.getHistoryNotice().then(n => live && setNotice(n), () => live && setNotice(null));
    return () => { live = false; };
  }, [provider, activeId, version]);

  // Quyền của trợ lý AI của hội thoại đang mở; lỗi tải thì ẩn ô chọn thay vì hiện giá trị đoán.
  const hasAccess = !!provider?.getAccess && !!provider.setAccess;
  useEffect(() => {
    setAccessValue(null);
    if (!provider?.getAccess || !provider.setAccess || !activeId) return;
    let live = true;
    provider.getAccess(activeId).then(v => live && setAccessValue(v), () => undefined);
    return () => { live = false; };
  }, [provider, activeId]);

  /** Lạc quan: đổi ngay, lưu lỗi thì hoàn tác và báo ngắn. */
  async function changeAccess(next: ChatAccess) {
    const id = activeRef.current;
    const prev = access;
    if (!provider?.setAccess || !id || !prev || next === prev) return;
    setAccessValue(next);
    try {
      await provider.setAccess(id, next);
      setError('');
    } catch {
      if (activeRef.current === id) { setAccessValue(prev); setError('Không đổi được quyền của trợ lý AI.'); }
    }
  }

  const active = convs.find(c => c.id === activeId) ?? null;
  const locked = FOLDER_LOCKED.includes(folder);
  const actions = ACTIONS[folder] ?? [];
  const targets = selected.length ? selected : active ? [active.id] : [];

  function onRow(e: MouseEvent, id: string, fromCheckbox = false) {
    if (e.shiftKey && anchor.current) {
      const ids = convs.map(c => c.id);
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((x, y) => x - y);
      setSelected(ids.slice(a, b + 1));
      return;
    }
    if (e.ctrlKey || e.metaKey || fromCheckbox) {
      anchor.current = id;
      setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
      return;
    }
    anchor.current = id;
    setSelected([]);
    setActiveId(id);
  }

  async function run(key: ActionKey) {
    if (!provider || !targets.length) return;
    try {
      await Promise.all(targets.map(id => provider[key](id)));
      setSelected([]);
      reload();
    } catch {
      setError('Thao tác không thành công. Thử lại sau.');
    }
  }

  async function send() {
    const text = draft.trim();
    if (!provider || !active || (!text && !file) || sending) return;
    setSending(true);
    try {
      if (file && provider.sendFile) await provider.sendFile(active.id, file, text);
      else await provider.send(active.id, text);
      setDraft(''); setFile(null); setError('');
      reload();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Không gửi được tin nhắn.');
    } finally {
      setSending(false);
    }
  }

  /** Đọc tệp thành base64 thuần; giới hạn kích thước vì tệp đi qua một khung JSON tới Gateway. */
  function pickFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { setError(`Tệp quá lớn (tối đa ${Math.round(MAX_FILE_BYTES / 1_000_000)} MB).`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const base64 = url.slice(url.indexOf(',') + 1);
      if (base64) { setFile({name: f.name, type: f.type, base64}); setError(''); }
    };
    reader.onerror = () => setError('Không đọc được tệp.');
    reader.readAsDataURL(f);
  }

  const grouped = useMemo(() => {
    const out: (ChatMessage | {sep: string; id: string})[] = [];
    let last = '';
    for (const m of messages) {
      const label = dayLabel(m.at);
      if (label !== last) { out.push({sep: label, id: `sep-${m.id}`}); last = label; }
      out.push(m);
    }
    return out;
  }, [messages]);

  if (accounts === null) return <section className="op-chat" lang="vi" aria-label={name}><p className="op-chat__muted op-chat__pad">Đang tải…</p></section>;
  if (!connected) {
    return (
      <section className="op-chat" lang="vi" aria-label={name}>
        <NotConnected channel={channel} onLinkQr={props.onLinkQr} onStartBrowserLogin={props.onStartBrowserLogin} onCancelBrowserLogin={props.onCancelBrowserLogin} onSubmitCookies={props.onSubmitCookies} extra={props.notConnectedExtra} />
      </section>
    );
  }

  const selecting = selected.length > 0;
  return (
    <section className="op-chat" lang="vi" aria-label={name}>
      <div className="op-chat__list">
        {error && <p className="op-chat__error" role="alert">{error}</p>}
        <ul className="op-chat__rows">
          {convs.length === 0 && <li className="op-chat__muted op-chat__pad">{provider?.folderEmptyText?.[folder] ?? `Không có hội thoại trong “${FOLDER_LABEL[folder] ?? 'mục này'}”.`}</li>}
          {convs.map(c => {
            const on = selected.includes(c.id);
            return (
              <li key={c.id} className="op-chat__row" data-active={!selecting && c.id === activeId} aria-selected={on} data-selected={on} onClick={e => onRow(e, c.id)}>
                <input type="checkbox" className="op-chat__check" aria-label={`Chọn ${c.name}`} checked={on} readOnly onClick={e => { e.stopPropagation(); onRow(e, c.id, true); }} />
                <Avatar name={c.name} id={c.hasAvatar ? c.id : undefined} cache={avatars} group={c.kind === 'group'} />
                <div className="op-chat__row-main">
                  <div className="op-chat__row-top">
                    <span className="op-chat__row-name" data-unread={c.unread > 0}>{c.name}</span>
                    <span className="op-chat__row-time">{listTime(c.lastAt)}</span>
                  </div>
                  <div className="op-chat__row-bottom">
                    <span className="op-chat__row-preview">{c.preview}</span>
                    {c.unread > 0 && <span className="op-chat__badge" aria-label={`${c.unread} tin chưa đọc`}>{c.unread}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="op-chat__pane">
        {selecting ? (
          <div className="op-chat__selection">
            <div className="op-chat__selection-bar">
              <strong>Đã chọn {selected.length}</strong>
              <button type="button" className="op-chat__btn" onClick={() => setSelected(convs.map(c => c.id))}>Chọn tất cả</button>
              <button type="button" className="op-chat__btn" onClick={() => setSelected([])}>Bỏ chọn</button>
              <span className="op-chat__spacer" />
              {actions.map(a => <button key={a.key} type="button" className={`op-chat__btn${a.primary ? ' op-chat__btn--primary' : ''}`} onClick={() => run(a.key)}>{a.label}</button>)}
            </div>
            <p className="op-chat__muted op-chat__pad">Giữ Shift để chọn một dãy, Ctrl/Cmd để thêm từng hội thoại.</p>
          </div>
        ) : active ? (
          <>
            <div className="op-chat__head">
              <Avatar name={active.name} id={active.hasAvatar ? active.id : undefined} cache={avatars} group={active.kind === 'group'} />
              <div>
                <div className="op-chat__title">{active.name}</div>
                <div className="op-chat__sub" data-folder={folder}>{active.subtitle ?? (active.kind === 'group' ? 'Nhóm' : `${name} cá nhân`)}</div>
              </div>
              <span className="op-chat__spacer" />
              {hasAccess && access && (
                <select className="op-chat__access" aria-label="Quyền của trợ lý AI" value={access} onChange={e => void changeAccess(e.target.value as ChatAccess)}>
                  {ACCESS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              )}
              {actions.map(a => <button key={a.key} type="button" className={`op-chat__btn${a.primary ? ' op-chat__btn--primary' : ''}`} onClick={() => run(a.key)}>{a.label}</button>)}
            </div>
            <div className="op-chat__messages" ref={box} onScroll={e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM; }}>
              {notice && (
                <div className="op-chat__notice" role="note">
                  <p>{notice.text}</p>
                  {provider?.enableHistory && (
                    <button type="button" className="op-chat__btn op-chat__btn--primary" disabled={enabling} onClick={() => {
                      setEnabling(true); setEnableError(null);
                      provider.enableHistory!().then(() => setVersion(v => v + 1), e => setEnableError(e instanceof Error ? e.message : 'Không bật được quyền.')).finally(() => setEnabling(false));
                    }}>{enabling ? 'Đang bật…' : 'Bật lưu tin nhắn'}</button>
                  )}
                  {enableError && <p className="op-chat__error" role="alert">{enableError}</p>}
                  {notice.command && <code>{notice.command}</code>}
                </div>
              )}
              {messages.length === 0 && provider?.emptyHistoryText && <p className="op-chat__muted op-chat__pad">{provider.emptyHistoryText}</p>}
              {grouped.map(m => 'sep' in m
                ? <div key={m.id} className="op-chat__sep"><span>{m.sep}</span></div>
                : (
                  <div key={m.id} className="op-chat__msg" data-me={m.fromMe}>
                    {!m.fromMe && <Avatar name={m.author ?? active.name} id={!m.author && active.hasAvatar ? active.id : undefined} cache={avatars} />}
                    <div>
                      <div className="op-chat__bubble">{m.author && !m.fromMe && <b className="op-chat__author">{m.author}: </b>}{m.text}</div>
                      <div className="op-chat__time">{clock(m.at)}</div>
                    </div>
                  </div>
                ))}
            </div>
            {locked ? (
              <div className="op-chat__locked" role="note">{LOCK_TEXT[folder]}</div>
            ) : (
              <form className="op-chat__composer" onSubmit={e => { e.preventDefault(); void send(); }}>
                {provider?.sendFile && (
                  <>
                    <input ref={fileInput} type="file" hidden aria-label="Chọn tệp đính kèm" onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                    <button type="button" className="op-chat__btn op-chat__attach" aria-label="Đính kèm tệp" title="Đính kèm tệp" onClick={() => fileInput.current?.click()}>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.9-8.9a3.3 3.3 0 0 1 4.7 4.7l-8.9 8.9a1.7 1.7 0 0 1-2.4-2.4l8.2-8.2" /></svg>
                    </button>
                  </>
                )}
                <div className="op-chat__compose-main">
                  {file && (
                    <span className="op-chat__file" data-testid="attached-file">
                      <span className="op-chat__file-name">{file.name}</span>
                      <button type="button" aria-label="Bỏ tệp" onClick={() => setFile(null)}>×</button>
                    </span>
                  )}
                  <textarea aria-label="Nhập tin nhắn" placeholder={file ? 'Thêm chú thích (tùy chọn)…' : 'Nhập tin nhắn…'} value={draft} onChange={e => setDraft(e.target.value)} />
                </div>
                <button type="submit" className="op-chat__btn op-chat__btn--primary" disabled={(!draft.trim() && !file) || sending}>{sending ? 'Đang gửi…' : 'Gửi'}</button>
              </form>
            )}
          </>
        ) : <p className="op-chat__muted op-chat__pad">Chọn một hội thoại để bắt đầu.</p>}
      </div>
    </section>
  );
}
