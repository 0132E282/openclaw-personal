import {createRoot} from 'react-dom/client';
import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react';
import {requestWithTimeout, type PluginHost} from '../host';
import {loadZaloAccounts, type ZaloAccountInfo} from '../connectors/zalo';
import {ConnectGmail, EmailApp, callOp, createHostEmailProvider, type AuthState, type Folder as EmailFolder} from './email';
import {GMAIL_ICON} from './email/gmailIcon';
import {ZALO_ICON} from './chat/zaloIcon';
import {MESSENGER_ICON} from './chat/messengerIcon';
import {ChatApp, ZaloQr, createHostZaloProvider, createHostMessengerProvider, type BrowserLoginResult, type MessengerCookies, type ChatChannel, type ChatFolder, type QrLoginStep} from './chat';
import {EmailLogoutDialog, MessengerLogoutDialog, ZaloLogoutDialog} from './LogoutDialogs';
import {SetupGuide, type SetupItem} from './setup';

type CheckResult = {browser: 'available' | 'missing'; desktopNotify: 'supported' | 'unsupported-platform'};

/** Mục kiểm tra thật từ backend (không có gì cần cài bằng lệnh: Chrome tự cài, thông báo dùng sẵn của hệ điều hành). */
function checkItems(r: CheckResult | null | undefined): SetupItem[] {
 const browser: SetupItem = r?.browser === 'available'
  ? {id: 'browser', title: 'Trình duyệt Chrome', description: 'Dùng để mở cửa sổ đăng nhập Facebook và lấy cookie phiên.', status: 'ok', statusLabel: 'Đã có'}
  : {id: 'browser', title: 'Trình duyệt Chrome', description: 'Chưa tìm thấy Google Chrome/Chromium. Cài Chrome rồi bấm Kiểm tra lại, hoặc dán cookie thủ công.', status: 'todo', statusLabel: r ? 'Chưa có Chrome' : 'Chưa kiểm tra', actionLabel: 'Kiểm tra lại', actionKind: 'check'};
 const notify: SetupItem = r?.desktopNotify === 'unsupported-platform'
  ? {id: 'notify', title: 'Thông báo desktop', description: 'Hệ điều hành này chưa được hỗ trợ bắn thông báo từ Hộp thư.', status: 'warn', statusLabel: 'Chưa hỗ trợ', actionLabel: 'Kiểm tra lại', actionKind: 'check'}
  : r
  ? {id: 'notify', title: 'Thông báo desktop', description: 'Dùng thông báo có sẵn của macOS, không cần cài thêm.', status: 'ok', statusLabel: 'Sẵn sàng'}
  : {id: 'notify', title: 'Thông báo desktop', description: 'Bắn thông báo hệ điều hành khi có tin mới.', status: 'todo', statusLabel: 'Chưa kiểm tra', actionLabel: 'Kiểm tra lại', actionKind: 'check'};
 return [browser, notify];
}

/** Hướng dẫn nằm ngay trong ô "chưa kết nối" của từng kênh, không có trang riêng; mọi nút đều làm được việc thật. */
function Setup({kind, host, onConnect}: {kind: 'email' | ChatChannel; host?: PluginHost; onConnect?: () => void}): ReactNode {
 const [res, setRes] = useState<CheckResult | null>(null);
 const [rev, setRev] = useState(0);
 useEffect(() => {
  if (!host) return;
  let live = true;
  callOp<CheckResult>(host, 'setup.check').then(r => { if (live) setRes(r); }, () => { if (live) setRes(null); });
  return () => { live = false; };
 }, [host, rev]);
 const [browser, notify] = checkItems(res);
 const items: SetupItem[] = kind === 'email'
  ? [{id: 'email', title: 'Gmail API', description: 'Cần tạo OAuth client (Desktop app) trên Google Cloud để đọc, gửi, sắp xếp thư.', status: 'todo', statusLabel: 'Chưa kết nối', actionLabel: 'Kết nối', actionKind: 'connect'}, notify]
  : kind === 'zalo'
  ? [{id: 'zalo', title: 'Zalo — zalouser', description: 'Kênh Zalo cá nhân (không chính thức, có rủi ro khóa tài khoản).', status: 'todo', statusLabel: 'Chưa liên kết', actionLabel: 'Liên kết', actionKind: 'connect'}, notify]
  : [browser, notify];
 return <SetupGuide inline items={items} onAction={(id, k) => { if (k === 'connect') onConnect?.(); else setRev(r => r + 1); }} onConfirmInstall={() => {}} />;
}

function mount(container: HTMLElement, node: ReactNode) {
 const root = createRoot(container);
 root.render(node);
 return {dispose() { root.unmount(); }};
}

type Kind = 'email' | ChatChannel;
const NAV: ReadonlyArray<{id: Kind; label: string; logo: ReactNode}> = [
 {id:'email',label:'Email',logo:<img src={GMAIL_ICON} width="24" height="24" alt="" />},
 {id:'zalo',label:'Zalo',logo:<img src={ZALO_ICON} width="24" height="24" alt="" />},
 {id:'messenger',label:'Messenger',logo:<img src={MESSENGER_ICON} width="24" height="24" alt="" />},
];

type AnyFolder = 'all' | 'unread' | 'group' | 'stranger' | 'blocked' | 'spam' | 'trash';
const CATS: Record<Kind, ReadonlyArray<[AnyFolder, string]>> = {
 email:[['all','Tất cả'],['unread','Chưa đọc'],['stranger','Người lạ'],['blocked','Đã chặn'],['spam','Spam'],['trash','Thùng rác']],
 zalo:[['all','Tất cả tin nhắn'],['unread','Tin nhắn chưa đọc'],['group','Tin nhắn nhóm'],['stranger','Tin người lạ'],['blocked','Tin nhắn đã chặn'],['spam','Tin nhắn spam']],
 messenger:[['all','Tất cả tin nhắn'],['unread','Tin nhắn chưa đọc'],['group','Tin nhắn nhóm'],['stranger','Tin nhắn chờ (người lạ)'],['blocked','Tin nhắn đã chặn'],['spam','Tin nhắn spam']],
};


const P = {
 all: <path d="M3 13l2-7h14l2 7v6H3zM3 13h5l1 3h6l1-3h5" />,
 unread: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
 group: <><circle cx="9" cy="9" r="3" /><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 6a3 3 0 0 1 0 6M18 14c2 .6 3 2.200 3 5" /></>,
 stranger: <><circle cx="12" cy="8" r="3.500" /><path d="M5 20c0-4 3-6 7-6s7 2 7 6M12 3v.5" /></>,
 blocked: <><circle cx="12" cy="12" r="9" /><path d="m5.700 5.700 12.600 12.600" /></>,
 spam: <><path d="M12 3 2.500 20h19z" /><path d="M12 10v4M12 17v.5" /></>,
 trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
 compose: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
 plus: <path d="M12 5v14M5 12h14" />,
 logout: <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />,
} as const;
type IconKey = keyof typeof P;
const Icon = ({k}: {k: IconKey}) => <svg className="op-shell__ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.700" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[k]}</svg>;

/** Một mục sidebar duy nhất; Email, Zalo, Messenger chuyển qua lại trong trang, mỗi kênh xổ danh mục (mở được nhiều kênh cùng lúc). */
const CLIENT_KEY = 'openclaw-personal.gmailClientId';

type MessengerStatus = {state: 'connected' | 'expired' | 'no-cookies'; reason?: string | null};
/** Làm mới nhẹ: mỗi lượt đọc đi qua trình duyệt ẩn nên thưa hơn Zalo (backend còn cache và giãn cách). */
const MESSENGER_POLL = {messages: 15_000, conversations: 30_000};

type LoginStatusResult = {phase: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'; reason?: string | null};

/** Mở Chrome để người dùng tự đăng nhập, rồi hỏi trạng thái đến khi xong (tối đa ~6 phút). */
async function runMessengerLogin(host: PluginHost): Promise<BrowserLoginResult> {
 let s = await callOp<LoginStatusResult>(host, 'messenger.login.start');
 for (let i = 0; i < 180 && s.phase === 'running'; i++) {
  await new Promise(r => setTimeout(r, 2000));
  s = await callOp<LoginStatusResult>(host, 'messenger.login.status');
 }
 if (s.phase === 'succeeded' || s.phase === 'cancelled') return {phase: s.phase};
 return {phase: 'failed', reason: s.phase === 'running' ? 'timeout' : s.reason};
}

/** Chuyển cookie người dùng nhập (c_user + xs, JSON hoặc header) thành danh sách cho `messenger.cookies.set`. */
function parseMessengerCookies(c: MessengerCookies): Array<{name: string; value: string}> {
 if (c.cUser && c.xs) return [{name: 'c_user', value: c.cUser}, {name: 'xs', value: c.xs}];
 try {
  const j = JSON.parse(c.raw) as unknown;
  if (Array.isArray(j)) return j.filter((x): x is {name: string; value: string} => typeof x?.name === 'string' && typeof x?.value === 'string' && !!x.value).map(x => ({name: x.name, value: x.value}));
 } catch { /* không phải JSON: thử dạng header */ }
 return c.raw.split(';').map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return {name: p.slice(0, i).trim(), value: p.slice(i + 1).trim()}; }).filter(x => x.name && x.value);
}

async function saveMessengerCookies(host: PluginHost, c: MessengerCookies): Promise<void> {
 const r = await callOp<{ok: boolean}>(host, 'messenger.cookies.set', {cookies: parseMessengerCookies(c)});
 if (!r.ok) throw new Error('cookies-rejected');
}
const savedClientId = () => { try { return localStorage.getItem(CLIENT_KEY) ?? ''; } catch { return ''; } };
const saveClientId = (id: string) => { try { localStorage.setItem(CLIENT_KEY, id); } catch { /* bỏ qua */ } };

/** Ảnh đại diện tài khoản Zalo: ảnh CDN (đã lọc https) nếu tải được, không thì chữ cái đầu. */
function AccountAvatar({account}: {account: ZaloAccountInfo}) {
 const [failed, setFailed] = useState(false);
 if (account.avatar && !failed) return <img className="op-shell__acc-ava" src={account.avatar} alt="" width="18" height="18" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
 return <span className="op-shell__acc-ava" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span>;
}

/** `connected`: kênh đã có tài khoản; chỉ khi đó mới hiện dropdown danh mục. Chưa có provider thật nên mặc định chưa kênh nào kết nối. */
function Personal({host}: {host?: PluginHost}) {
 const provider = useMemo(() => (host ? createHostEmailProvider(host) : undefined), [host]);
 const [emailAccounts, setEmailAccounts] = useState(0);
 const [connecting, setConnecting] = useState(false);
 const [rev, setRev] = useState(0);
 const [composeReq, setComposeReq] = useState(0);
 const [zaloQr, setZaloQr] = useState<string | null>(null);
 const [zaloAccounts, setZaloAccounts] = useState<readonly ZaloAccountInfo[]>([]);
 const [zaloPick, setZaloPick] = useState('');
 const [zaloAdding, setZaloAdding] = useState(false);
 const [zaloAddError, setZaloAddError] = useState('');
 const [zaloRev, setZaloRev] = useState(0);
 const [logout, setLogout] = useState<'email' | 'zalo' | 'messenger' | null>(null);
 const [messengerState, setMessengerState] = useState<MessengerStatus['state'] | null>(null);
 const [messengerRev, setMessengerRev] = useState(0);
 useEffect(() => {
  if (!host) return;
  let live = true;
  loadZaloAccounts(host).then(a => { if (live) setZaloAccounts(a); }, () => { if (live) setZaloAccounts([]); });
  return () => { live = false; };
 }, [host, zaloRev]);
 const zaloLinked = zaloAccounts.length > 0;
 useEffect(() => {
  if (!host) return;
  let live = true;
  callOp<MessengerStatus>(host, 'messenger.status').then(r => { if (live) setMessengerState(r.state); }, () => { if (live) setMessengerState(null); });
  return () => { live = false; };
 }, [host, messengerRev]);
 const recheckMessenger = useCallback(() => setMessengerRev(r => r + 1), []);
 const messengerLogin = useMemo(() => (host ? {
  start: () => runMessengerLogin(host).then(r => { recheckMessenger(); return r; }),
  cancel: () => { void callOp(host, 'messenger.login.cancel').catch(() => undefined); },
  submit: (c: MessengerCookies) => saveMessengerCookies(host, c).then(recheckMessenger),
 } : undefined), [host, recheckMessenger]);
 const messengerProvider = useMemo(() => (host ? createHostMessengerProvider(host, {onAuthLost: recheckMessenger}) : undefined), [host, recheckMessenger]);
 /** Tài khoản đang xem: lựa chọn của người dùng nếu còn liên kết, không thì tài khoản đầu tiên (default đứng đầu). */
 const zaloAccount = zaloAccounts.find(a => a.accountId === zaloPick)?.accountId ?? zaloAccounts[0]?.accountId ?? 'default';
 const zaloProvider = useMemo(() => (host ? createHostZaloProvider(host, zaloAccount) : undefined), [host, zaloAccount]);
 const addZaloAccount = async () => {
  if (!host || zaloAdding) return;
  setZaloAdding(true); setZaloAddError('');
  try {
   const r = await callOp<{ok: boolean; accountId?: string}>(host, 'zalo.accounts.add');
   if (r.ok && r.accountId) setZaloQr(r.accountId); else setZaloAddError('Không tạo được tài khoản Zalo mới. Thử lại sau.');
  } catch {
   setZaloAddError('Không tạo được tài khoản Zalo mới. Thử lại sau.');
  } finally {
   setZaloAdding(false);
  }
 };
 useEffect(() => {
  let live = true;
  provider?.listAccounts().then(a => { if (live) setEmailAccounts(a.length); }, () => { if (live) setEmailAccounts(0); });
  return () => { live = false; };
 }, [provider, rev]);
 const messengerLinked = messengerState === 'connected';
 const connected: Partial<Record<Kind, boolean>> = {email: emailAccounts > 0, zalo: zaloLinked, messenger: messengerLinked};
 const catsOf = (k: Kind): ReadonlyArray<[AnyFolder, string]> => CATS[k];
 const [active, setActive] = useState<Kind>('email');
 const [folder, setFolder] = useState<AnyFolder>('all');
 const [open, setOpen] = useState<ReadonlySet<Kind>>(new Set<Kind>(['email']));
 const toggle = (k: Kind) => setOpen(prev => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });
 const pick = (k: Kind, f: AnyFolder) => { setActive(k); setFolder(f); setOpen(prev => new Set(prev).add(k)); if (k === 'messenger') recheckMessenger(); };
 return (
  <div className="op-shell" lang="vi">
   <nav className="op-shell__nav" aria-label="Kênh tin nhắn">
    {NAV.map(n => {
     const isOn = connected[n.id] === true;
     const expanded = isOn && open.has(n.id);
     return (
      <div key={n.id}>
       <div className="op-shell__row">
        <button type="button" className="op-shell__item" data-active={!expanded && n.id === active && folder === 'all' ? 'true' : undefined} onClick={() => pick(n.id, 'all')}>
         <span className="op-shell__logo">{n.logo}</span><span className="op-shell__label">{n.label}</span><span className="op-shell__dot" data-on={isOn ? 'true' : undefined} aria-label={isOn ? 'Đã kết nối' : 'Chưa kết nối'} />
        </button>
        {isOn && <button type="button" className="op-shell__chev" aria-expanded={expanded} aria-label={`${expanded ? 'Thu gọn' : 'Mở'} danh mục ${n.label}`} onClick={() => toggle(n.id)}>{expanded ? '⌃' : '⌄'}</button>}
       </div>
       {expanded && (
        <ul className="op-shell__cats">
         {n.id === 'email' && <li><button type="button" className="op-shell__cat op-shell__cat--action" onClick={() => { pick('email', 'all'); setComposeReq(c => c + 1); }}><Icon k="compose" />Soạn thư</button></li>}
         {catsOf(n.id).map(([f, label]) => (
          <li key={f}><button type="button" className="op-shell__cat" data-danger={f === 'spam' ? 'true' : undefined} data-active={n.id === active && folder === f ? 'true' : undefined} onClick={() => pick(n.id, f)}><Icon k={f as IconKey} />{label}</button></li>
         ))}
         {n.id === 'zalo' && zaloAccounts.length > 1 && (
          <li className="op-shell__accounts" role="group" aria-label="Tài khoản Zalo">
           {zaloAccounts.map(a => <button key={a.accountId} type="button" className="op-shell__cat op-shell__acc" aria-pressed={a.accountId === zaloAccount} data-active={a.accountId === zaloAccount ? 'true' : undefined} onClick={() => { setZaloPick(a.accountId); pick('zalo', active === 'zalo' ? folder : 'all'); }}><AccountAvatar account={a} />{a.name}</button>)}
          </li>
         )}
         {n.id === 'email' && <li><button type="button" className="op-shell__cat op-shell__cat--action" onClick={() => setConnecting(true)}><Icon k="plus" />Thêm tài khoản</button></li>}
         {n.id === 'zalo' && <li><button type="button" className="op-shell__cat op-shell__cat--action" disabled={zaloAdding} onClick={() => void addZaloAccount()}><Icon k="plus" />Thêm tài khoản</button></li>}
         {n.id === 'zalo' && zaloAddError && <li><p className="op-shell__acc-error" role="alert">{zaloAddError}</p></li>}
         {<li><button type="button" className="op-shell__cat op-shell__cat--action" data-danger="true" onClick={() => setLogout(n.id)}><Icon k="logout" />Đăng xuất</button></li>}
        </ul>
       )}
      </div>
     );
    })}
   </nav>
   <div className="op-shell__body" key={active === 'zalo' ? `zalo:${zaloAccount}` : active}>
    {active === 'email'
     ? <EmailApp key={rev} composeRequest={composeReq} provider={provider} folder={folder as EmailFolder} onFolderChange={setFolder} onConnect={host ? () => setConnecting(true) : undefined} notConnectedExtra={<Setup kind="email" host={host} onConnect={() => setConnecting(true)} />} />
     : <ChatApp channel={active} provider={active === 'zalo' && zaloLinked ? zaloProvider : active === 'messenger' && messengerLinked ? messengerProvider : undefined} pollMs={active === 'messenger' ? MESSENGER_POLL : undefined} folder={folder as ChatFolder} onFolderChange={setFolder} onLinkQr={host ? () => setZaloQr('default') : undefined} onStartBrowserLogin={messengerLogin?.start} onCancelBrowserLogin={messengerLogin?.cancel} onSubmitCookies={messengerLogin?.submit} notConnectedExtra={<Setup kind={active} host={host} onConnect={() => setZaloQr('default')} />} />}
   </div>
   {zaloQr && host && (
    <ZaloQr
     start={() => host.request('web.login.start', {channel: 'zalouser', ...(zaloQr !== 'default' ? {accountId: zaloQr} : {}), timeoutMs: 30_000}) as Promise<QrLoginStep>}
     wait={cur => host.request('web.login.wait', {channel: 'zalouser', ...(zaloQr !== 'default' ? {accountId: zaloQr} : {}), timeoutMs: 120_000, ...(cur.qrDataUrl ? {currentQrDataUrl: cur.qrDataUrl} : {}), ...(cur.sessionKey ? {sessionKey: cur.sessionKey} : {})}) as Promise<QrLoginStep>}
     check={async () => (await loadZaloAccounts(host)).some(a => a.accountId === zaloQr)}
     onLinked={() => { setZaloPick(zaloQr); setZaloRev(r => r + 1); setZaloQr(null); }}
     onClose={() => setZaloQr(null)}
    />
   )}
   {logout === 'email' && host && (
    <EmailLogoutDialog
     load={() => callOp<{accounts: {id: string; address: string}[]}>(host, 'gmail.accounts.list').then(r => r.accounts)}
     remove={async id => { const r = await callOp<{ok: boolean}>(host, 'gmail.accounts.remove', {accountId: id}); if (!r.ok) throw new Error('remove-failed'); }}
     onChanged={() => setRev(r => r + 1)}
     onClose={() => setLogout(null)}
    />
   )}
   {logout === 'zalo' && host && (
    <ZaloLogoutDialog
     accounts={zaloAccounts}
     logout={id => requestWithTimeout(host, 'channels.logout', {channel: 'zalouser', ...(id && (id !== 'default' || zaloAccounts.length > 1) ? {accountId: id} : {})}, 30_000)}
     onDone={() => setZaloRev(r => r + 1)}
     onClose={() => setLogout(null)}
    />
   )}
   {logout === 'messenger' && host && (
    <MessengerLogoutDialog
     logout={async () => { const r = await callOp<{ok: boolean}>(host, 'messenger.cookies.clear'); if (!r.ok) throw new Error('clear-failed'); }}
     onDone={recheckMessenger}
     onClose={() => setLogout(null)}
    />
   )}
   {connecting && host && (
    <ConnectGmail
     initialClientId={savedClientId()}
     auto={emailAccounts > 0}
     start={async (clientId, clientSecret) => { if (clientId) saveClientId(clientId); return callOp<AuthState>(host, 'gmail.auth.start', clientId ? (clientSecret ? {clientId, clientSecret} : {clientId}) : {}).then(r => ({...r, reason: null})); }}
     status={() => callOp<AuthState>(host, 'gmail.auth.status')}
     cancel={() => callOp(host, 'gmail.auth.cancel')}
     onDone={() => { setConnecting(false); setRev(r => r + 1); }}
     onClose={() => setConnecting(false)}
    />
   )}
  </div>
 );
}

/** Khoảng đệm host đặt quanh trang (đo lúc chạy, tối đa 48px; không đo được thì dùng 24px theo ảnh chụp app) để Hộp thư sát mép, không bị hở. */
const FALLBACK_INSET = 24;
function hostInset(container: HTMLElement) {
 let el: HTMLElement | null = container.parentElement;
 while (el && el !== document.body) {
  const o = getComputedStyle(el).overflowY;
  if (o === 'auto' || o === 'scroll') break;
  el = el.parentElement;
 }
 if (!el || el === document.body) return {x: FALLBACK_INSET, y: FALLBACK_INSET};
 const a = el.getBoundingClientRect(), c = container.getBoundingClientRect();
 const clamp = (n: number) => Math.max(0, Math.min(48, Math.round(n))) || FALLBACK_INSET;
 return {x: clamp(c.left - a.left), y: clamp(c.top - a.top)};
}

export function mountPersonal(container: HTMLElement, host?: PluginHost) {
 const view = mount(container, <Personal host={host} />);
 const {x, y} = hostInset(container);
 container.style.setProperty('--op-shell-x', `${x}px`);
 container.style.setProperty('--op-shell-y', `${y}px`);
 return view;
}
