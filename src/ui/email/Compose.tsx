import {useRef, useState, type DragEvent, type KeyboardEvent} from 'react';
import {isEmail} from './helpers';
import type {Account, Draft} from './provider';
import {sanitizeHtml} from './sanitize';

export interface ComposeInit {
 to?: readonly string[];
 subject?: string;
 html?: string;
 replyToId?: string;
}
interface Props {
 accounts: readonly Account[];
 init: ComposeInit;
 onSend(d: Draft): Promise<void>;
 onSaveDraft?(d: Draft): Promise<void>;
 onClose(): void;
}
const FORMATS: ReadonlyArray<[string, string, string]> = [['B', 'bold', 'In đậm'], ['I', 'italic', 'In nghiêng'], ['U', 'underline', 'Gạch chân'], ['•', 'insertUnorderedList', 'Danh sách'], ['1.', 'insertOrderedList', 'Danh sách số']];
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Chips({label, values, onChange}: {label: string; values: readonly string[]; onChange(v: string[]): void}) {
 const [draft, setDraft] = useState('');
 const commit = () => { const v = draft.trim().replace(/[,;]$/, ''); if (v && isEmail(v) && !values.includes(v)) onChange([...values, v]); if (!v || isEmail(v)) setDraft(''); };
 const key = (e: KeyboardEvent<HTMLInputElement>) => {
  if (['Enter', ',', ';', ' '].includes(e.key)) { e.preventDefault(); commit(); }
  else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
 };
 return (
  <>
   {values.map(v => <span key={v} className="op-email__chip">{v}<button type="button" aria-label={`Bỏ ${v}`} onClick={() => onChange(values.filter(x => x !== v))}>×</button></span>)}
   <input className="op-email__input" aria-label={label} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={key} onBlur={commit} />
  </>
 );
}

export function Compose({accounts, init, onSend, onSaveDraft, onClose}: Props) {
 const [from, setFrom] = useState(accounts[0]?.id ?? '');
 const [to, setTo] = useState<string[]>([...(init.to ?? [])]);
 const [cc, setCc] = useState<string[]>([]);
 const [bcc, setBcc] = useState<string[]>([]);
 const [showCc, setShowCc] = useState(false);
 const [subject, setSubject] = useState(init.subject ?? '');
 const [files, setFiles] = useState<File[]>([]);
 const [menu, setMenu] = useState(false);
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const [saved, setSaved] = useState('');
 const editor = useRef<HTMLDivElement>(null);
 const pick = useRef<HTMLInputElement>(null);
 const sig = accounts.find(a => a.id === from)?.signature;
 const initialHtml = useRef(`${init.html ?? '<p><br></p>'}${sig ? `<p>--<br>${sig.replace(/[<>&]/g, '')}</p>` : ''}`);

 const build = (scheduleAt?: string): Draft => ({accountId: from, to, cc, bcc, subject, html: sanitizeHtml(editor.current?.innerHTML ?? ''), attachments: files, replyToId: init.replyToId, scheduleAt});
 const send = async (scheduleAt?: string) => {
  setMenu(false);
  if (!to.length) { setError('Cần ít nhất một người nhận.'); return; }
  setBusy(true); setError('');
  try { await onSend(build(scheduleAt)); } catch { setError('Không gửi được thư. Thử lại sau.'); setBusy(false); }
 };
 const save = async () => {
  if (!onSaveDraft) return;
  try { await onSaveDraft(build()); const d = new Date(); setSaved(`Đã lưu nháp lúc ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`); } catch { setError('Không lưu được bản nháp.'); }
 };
 const addFiles = (list: FileList | null) => { if (list?.length) setFiles(f => [...f, ...Array.from(list)]); };
 const drop = (e: DragEvent) => { e.preventDefault(); addFiles(e.dataTransfer.files); };
 const format = (cmd: string) => { editor.current?.focus(); document.execCommand(cmd); };
 const link = () => { const url = window.prompt('Địa chỉ liên kết (https://…)'); if (url && /^(https?:|mailto:)/i.test(url)) { editor.current?.focus(); document.execCommand('createLink', false, url); } };
 const later = (ms: number) => new Date(Date.now() + ms).toISOString();
 const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString(); };

 return (
  <section className="op-email__reading op-email__compose" aria-label="Thư mới" onDragOver={e => e.preventDefault()} onDrop={drop}>
   <div className="op-email__toolbar">
    <h2>Thư mới</h2><span className="op-email__muted">{saved}</span>
    <button type="button" className="op-email__icon" aria-label="Đóng" onClick={onClose}>×</button>
   </div>
   <div className="op-email__fields">
    <label className="op-email__field"><span>Từ</span>
     <select value={from} onChange={e => setFrom(e.target.value)} aria-label="Từ">{accounts.map(a => <option key={a.id} value={a.id}>{a.address}</option>)}</select>
     <small className="op-email__muted">chọn trong {accounts.length} tài khoản</small>
    </label>
    <div className="op-email__field"><span>Đến</span><Chips label="Đến" values={to} onChange={setTo} />
     <span className="op-email__ccs"><button type="button" onClick={() => setShowCc(true)}>Cc</button><button type="button" onClick={() => setShowCc(true)}>Bcc</button></span></div>
    {showCc && <div className="op-email__field"><span>Cc</span><Chips label="Cc" values={cc} onChange={setCc} /></div>}
    {showCc && <div className="op-email__field"><span>Bcc</span><Chips label="Bcc" values={bcc} onChange={setBcc} /></div>}
    <label className="op-email__field"><span>Chủ đề</span><input className="op-email__input" aria-label="Chủ đề" value={subject} onChange={e => setSubject(e.target.value)} /></label>
   </div>
   <div className="op-email__format" role="toolbar" aria-label="Định dạng">
    {FORMATS.map(([t, cmd, label]) => <button key={cmd} type="button" aria-label={label} onMouseDown={e => e.preventDefault()} onClick={() => format(cmd)}>{t}</button>)}
    <button type="button" aria-label="Chèn liên kết" onMouseDown={e => e.preventDefault()} onClick={link}>🔗</button>
    <span className="op-email__muted">Soạn văn bản có định dạng</span>
   </div>
   <div ref={editor} className="op-email__editor op-email__html" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Nội dung thư" dangerouslySetInnerHTML={{__html: sanitizeHtml(initialHtml.current)}} />
   <div className="op-email__files">
    {files.map((f, i) => <span key={i} className="op-email__file"><b>{(f.name.split('.').pop() ?? '').toUpperCase()}</b>{f.name}<small>{size(f.size)}</small><button type="button" aria-label={`Bỏ ${f.name}`} onClick={() => setFiles(x => x.filter((_, j) => j !== i))}>×</button></span>)}
    <button type="button" className="op-email__btn" onClick={() => pick.current?.click()}>Đính kèm tệp · kéo thả vào đây</button>
    <input ref={pick} type="file" multiple hidden aria-label="Chọn tệp đính kèm" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
   </div>
   {error && <p className="op-email__error" role="alert">{error}</p>}
   <div className="op-email__footer">
    <span className="op-email__split">
     <button type="button" className="op-email__btn op-email__btn--primary" disabled={busy} onClick={() => send()}>Gửi</button>
     <button type="button" className="op-email__btn op-email__btn--primary" aria-label="Lịch gửi" aria-expanded={menu} disabled={busy} onClick={() => setMenu(m => !m)}>▾</button>
     {menu && <div className="op-email__menu" role="menu">
      <button type="button" role="menuitem" onClick={() => send(later(3600000))}>Gửi sau 1 giờ</button>
      <button type="button" role="menuitem" onClick={() => send(tomorrow())}>Sáng mai 8:00</button>
     </div>}
    </span>
    <button type="button" className="op-email__link" disabled={busy} onClick={() => setMenu(m => !m)}>Lên lịch gửi</button>
    <button type="button" className="op-email__link" disabled={!onSaveDraft} onClick={save}>Lưu nháp</button>
    <button type="button" className="op-email__link op-email__discard" onClick={onClose}>Bỏ thư</button>
   </div>
  </section>
 );
}
