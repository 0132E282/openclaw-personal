import {useCallback, useEffect, useState} from 'react';
import type {PluginHost} from '../host';
import {MESSENGER_DISCLAIMER, MESSENGER_STATE_LABEL, readMessengerStatus, type MessengerStatus as Status} from './messenger';

export function MessengerStatus({host}: {host?: PluginHost}) {
 const [status, setStatus] = useState<Status | 'loading'>('loading');
 const [round, setRound] = useState(0);
 const retry = useCallback(() => { setStatus('loading'); setRound(r => r + 1); }, []);
 useEffect(() => {
  const controller = new AbortController();
  readMessengerStatus(host, {signal: controller.signal}).then(setStatus, () => {});
  return () => controller.abort();
 }, [host, round]);
 const loading = status === 'loading';
 const unknown = !loading && status.state === 'unknown';
 const detail = loading ? null : status.accountCount > 0 ? `${status.accountCount} tài khoản, ${status.runningCount} đang chạy.` : status.reason;
 return (
  <div className="openclaw-personal__messenger">
   <div role="status" aria-live="polite">
    <span className="openclaw-personal__status openclaw-personal__messenger-chip" data-state={loading ? 'loading' : status.state}>{loading ? 'Đang kiểm tra…' : MESSENGER_STATE_LABEL[status.state]}</span>
    {detail && <p className="openclaw-personal__messenger-hint">{detail}</p>}
   </div>
   {unknown && <button type="button" className="openclaw-personal__link openclaw-personal__messenger-retry" onClick={retry} aria-label="Thử lại đọc trạng thái Messenger">Thử lại</button>}
   <p className="openclaw-personal__messenger-hint">{MESSENGER_DISCLAIMER}</p>
  </div>
 );
}
