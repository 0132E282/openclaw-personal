import type {MouseEvent} from 'react';
import {avatarColor, formatTime, initials, type Group} from './helpers';
import type {Account, Folder} from './provider';

interface Props {
 groups: readonly Group[];
 accounts: readonly Account[];
 folder: Folder;
 openId: string | null;
 selected: ReadonlySet<string>;
 now: Date;
 onRow(id: string, e: MouseEvent): void;
 onToggle(id: string): void;
}
const TAG: Partial<Record<Folder, string>> = {spam: 'Spam', stranger: 'Mới'};

export function MessageList({groups, accounts, folder, openId, selected, now, onRow, onToggle}: Props) {
 const color = (id: string) => accounts.find(a => a.id === id)?.color ?? '#a8a29e';
 if (!groups.length) return <p className="op-email__muted op-email__pad">Không có thư nào.</p>;
 return (
  <div role="listbox" aria-multiselectable="true" aria-label="Danh sách thư">
   {groups.map(g => (
    <div key={g.key}>
     <div className="op-email__section">{g.title}</div>
     {g.items.map(m => {
      const on = selected.has(m.id);
      return (
       <div key={m.id} role="option" aria-selected={on || m.id === openId} className={`op-email__row-item${m.id === openId ? ' is-open' : ''}${on ? ' is-selected' : ''}${m.unread ? ' is-unread' : ''}`} onClick={e => onRow(m.id, e)}>
        <button type="button" className={selected.size ? 'op-email__check' : 'op-email__avatar'} style={selected.size ? undefined : {background: avatarColor(m.from.name)}} aria-label={on ? 'Bỏ chọn thư' : 'Chọn thư'} aria-pressed={on} onClick={e => { e.stopPropagation(); onToggle(m.id); }}>
         {selected.size ? (on ? '✓' : '') : initials(m.from.name)}
        </button>
        <div className="op-email__body">
         <div className="op-email__line">
          <i className="op-email__dot" style={{background: color(m.accountId)}} />
          <span className="op-email__from">{m.from.name}</span>
          {TAG[folder] && <span className="op-email__tag">{TAG[folder]}</span>}
          <time className="op-email__time">{formatTime(m.date, now)}{m.pinned ? ' 📌' : ''}</time>
         </div>
         <div className="op-email__subject">{m.subject}</div>
         <div className="op-email__snippet">{m.snippet}</div>
        </div>
       </div>
      );
     })}
    </div>
   ))}
  </div>
 );
}
