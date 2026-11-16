import {useCallback, useEffect, useState} from 'react';
import type {PluginHost} from '../host';
import {OFFICIAL_ACCOUNT_NOTICE, RISK_NOTICE, ZALO_STATE_COPY, loadZaloStatus, type ZaloStatus as Status, type ZaloViewState} from './zalo';

export function ZaloStatus({host}: {host: PluginHost}) {
 const [view, setView] = useState<{state: ZaloViewState; other: number}>({state: 'loading', other: 0});
 const [round, setRound] = useState(0);
 const refresh = useCallback(() => {
  setView({state: 'loading', other: 0});
  setRound(r => r + 1);
 }, []);
 useEffect(() => {
  let current = true;
  loadZaloStatus(host).then(
   (s: Status) => { if (current) setView({state: s.state, other: s.otherAccountCount}); },
   () => { if (current) setView({state: 'load-failed', other: 0}); },
  );
  return () => { current = false; };
 }, [host, round]);
 const copy = ZALO_STATE_COPY[view.state];
 const failed = view.state === 'load-failed';
 const busy = view.state === 'loading';
 return (
  <div className="openclaw-personal__zalo">
   <div role="status" aria-live="polite">
    <span className="openclaw-personal__status openclaw-personal__zalo-chip" data-state={view.state}>{copy.label}</span>
    <p className="openclaw-personal__zalo-hint">{copy.hint}</p>
    {view.other > 0 && <p className="openclaw-personal__zalo-hint">{`Có ${view.other} tài khoản khác chưa được hiển thị.`}</p>}
   </div>
   <button type="button" className="openclaw-personal__link openclaw-personal__zalo-refresh" disabled={busy} onClick={refresh} aria-label={failed ? 'Thử lại đọc trạng thái Zalo' : 'Làm mới trạng thái Zalo'}>{failed ? 'Thử lại' : 'Làm mới'}</button>
   <p className="openclaw-personal__zalo-risk">{RISK_NOTICE}</p>
   <p className="openclaw-personal__zalo-hint">{OFFICIAL_ACCOUNT_NOTICE}</p>
  </div>
 );
}
