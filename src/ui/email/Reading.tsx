import {useRef, useState} from 'react';
import {BANNERS, FOLDER_ACTIONS, MAIL_ACTIONS, avatarColor, initials, type ActionDef} from './helpers';
import type {Folder, Message} from './provider';
import {sanitizeHtml} from './sanitize';

interface Props {
 message: Message;
 folder: Folder;
 busy: boolean;
 onAction(a: ActionDef): void;
 onForward(): void;
 onReply(text: string): Promise<void>;
}

function Body({message, folder}: {message: Message; folder: Folder}) {
 if (folder === 'blocked') return <p className="op-email__muted">Nội dung bị ẩn vì người gửi đã bị chặn.</p>;
 const links = folder === 'all' || folder === 'unread';
 if (message.html) return <div className="op-email__html" dangerouslySetInnerHTML={{__html: sanitizeHtml(message.html, {links})}} />;
 return <div className="op-email__html">{(message.text ?? message.snippet).split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>;
}

export function Reading({message, folder, busy, onAction, onForward, onReply}: Props) {
 const [text, setText] = useState('');
 const box = useRef<HTMLTextAreaElement>(null);
 const banner = BANNERS[folder];
 const actions = FOLDER_ACTIONS[folder];
 const canReply = folder === 'all' || folder === 'unread';
 const send = async () => { if (text.trim()) { await onReply(text); setText(''); } };
 return (
  <section className="op-email__reading" aria-label="Đọc thư">
   <div className="op-email__toolbar">
    {actions ? actions.map(a => <button key={a.label} type="button" disabled={busy} className={`op-email__btn${a.tone === 'primary' ? ' op-email__btn--primary' : ''}`} onClick={() => onAction(a)}>{a.label}</button>) : (
     <>
      <button type="button" className="op-email__btn op-email__btn--primary" onClick={() => box.current?.focus()}>Trả lời</button>
      <button type="button" className="op-email__btn" onClick={onForward}>Chuyển tiếp</button>
      {MAIL_ACTIONS.map(a => <button key={a.label} type="button" disabled={busy} className="op-email__btn" onClick={() => onAction(a)}>{a.label}</button>)}
     </>
    )}
   </div>
   {banner && <div className={`op-email__banner op-email__banner--${banner.tone}`}><strong>{banner.title}</strong><span>{banner.text}</span></div>}
   <div className="op-email__content">
    <h1>{message.subject}</h1>
    <div className="op-email__sender">
     <span className="op-email__avatar" style={{background: avatarColor(message.from.name)}}>{initials(message.from.name)}</span>
     <div><div className="op-email__from">{message.from.name}</div><div className="op-email__muted">Đến: {message.to.join(', ')}</div></div>
    </div>
    <Body message={message} folder={folder} />
   </div>
   {canReply && (
    <div className="op-email__reply">
     <textarea ref={box} value={text} placeholder="Viết trả lời…" aria-label="Viết trả lời" onChange={e => setText(e.target.value)} />
     <button type="button" className="op-email__btn op-email__btn--primary" disabled={busy || !text.trim()} onClick={send}>Gửi</button>
    </div>
   )}
  </section>
 );
}
