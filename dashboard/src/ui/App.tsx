import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHosts, fetchMetrics, type Host, type Metric } from './api';
import { Charts } from './Charts';

type LoadState = 'loading' | 'ready' | 'error';
const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
const formatUptime = (seconds: number) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days}日 ${String(hours).padStart(2, '0')}時間` : `${hours}時間 ${String(minutes).padStart(2, '0')}分`;
};
const formatSeen = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function App() {
  const [token, setToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const generation = useRef(0);
  const selectedHost = hosts.find((host) => host.id === selectedId);

  const refresh = useCallback(async (signal: AbortSignal, run: number) => {
    if (run !== generation.current) return;
    if (!token) {
      setHosts([]);
      setMetrics([]);
      setState('ready');
      setError('');
      setUpdatedAt(null);
      return;
    }
    setState((current) => current === 'ready' ? current : 'loading');
    try {
      const response = await fetchHosts(token, signal);
      if (signal.aborted || run !== generation.current) return;
      setHosts(response.hosts);
      const preferred = response.hosts.find((host) => host.id === selectedId) ?? response.hosts[0];
      if (preferred?.id !== selectedId) setMetrics([]);
      setSelectedId(preferred?.id ?? '');
      if (!preferred) {
        setMetrics([]);
        setState('ready');
        setError('');
        setUpdatedAt(new Date());
        return;
      }
      const detail = await fetchMetrics(preferred.id, token, signal);
      if (signal.aborted || run !== generation.current) return;
      setMetrics(detail.metrics);
      setState('ready');
      setError('');
      setUpdatedAt(new Date());
    } catch (cause) {
      if (signal.aborted || run !== generation.current) return;
      setError(cause instanceof Error ? cause.message : 'データを取得できませんでした');
      setState('error');
    }
  }, [selectedId, token]);

  useEffect(() => {
    const controller = new AbortController();
    const run = ++generation.current;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await refresh(controller.signal, run); } finally { inFlight = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh, refreshKey]);

  const current = metrics.at(-1);
  const cards = current ? [
    { label: 'CPU', value: formatPercent(current.cpu), tone: 'mint' },
    { label: 'メモリ', value: formatPercent(current.memory), tone: 'blue' },
    { label: 'ディスク', value: formatPercent(current.disk), tone: 'amber' },
    { label: 'Load 1m', value: current.load1.toFixed(2), tone: 'violet' },
    { label: '稼働時間', value: formatUptime(current.uptime), tone: 'neutral' },
  ] : [];

  function applyToken(event: React.FormEvent) {
    event.preventDefault();
    setToken(tokenDraft.trim());
    setState('loading');
    setRefreshKey((value) => value + 1);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#"><span className="brand-mark">c</span><span>cfmon<small>HOST MONITOR</small></span></a>
      <div className="side-label">インベントリ <span>{hosts.length}</span></div>
      <nav aria-label="ホスト一覧">
        {hosts.map((host) => <button key={host.id} className={`host-link ${selectedId === host.id ? 'active' : ''}`} onClick={() => { if (host.id === selectedId) return; setMetrics([]); setState('loading'); setSelectedId(host.id); }}>
          <span className="host-dot" /><span className="host-link-copy"><strong>{host.hostname}</strong><small>{host.os || 'OS 不明'}</small></span>
        </button>)}
      </nav>
      <form className="token-form" onSubmit={applyToken}>
        <label htmlFor="api-token">API トークン</label>
        <input id="api-token" type="password" autoComplete="off" placeholder="Bearer token" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} />
        <button type="submit">適用</button>
        <p>このブラウザーのメモリ内でのみ使用します。</p>
      </form>
      <div className="sidebar-foot"><span className="live-dot" />自動更新 30 秒</div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb">システム <span>/</span> ホスト</div><div className="top-actions">
        <span className="updated">{updatedAt ? `更新 ${updatedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '接続中'}</span>
        <button className="refresh-button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="今すぐ更新"><span>↻</span> 更新</button>
      </div></header>

      <section className="page-heading"><div><span className="eyebrow">OVERVIEW / HOSTS</span><h1>{selectedHost?.hostname ?? 'ホスト監視'}</h1>
        <p>{selectedHost ? `${selectedHost.os || 'OS 不明'} · 最終受信 ${formatSeen(selectedHost.last_seen)}` : 'ホストの状態をリアルタイムで確認できます。'}</p></div>
        {selectedHost && <span className={`status-pill ${Date.now() - new Date(selectedHost.last_seen).getTime() < 120_000 ? '' : 'stale'}`}><i />{Date.now() - new Date(selectedHost.last_seen).getTime() < 120_000 ? '最近受信' : '受信停止'}</span>}
      </section>

      {state === 'loading' && <div className="notice"><span className="spinner" />メトリクスを読み込んでいます…</div>}
      {state === 'error' && <div className="notice error-notice"><strong>データを取得できませんでした</strong><p>{error}</p><button onClick={() => setRefreshKey((value) => value + 1)}>再試行</button></div>}
      {state === 'ready' && !!token && hosts.length === 0 && <div className="empty-state"><div className="empty-icon">⌁</div><h2>ホストがまだありません</h2><p>エージェントから最初のメトリクスが届くと、ここに表示されます。</p></div>}
      {state === 'ready' && !token && <div className="empty-state"><div className="empty-icon">⌁</div><h2>API トークンを入力してください</h2><p>左側の欄に Bearer トークンを入力して適用すると、ホストを読み込みます。</p></div>}
      {state === 'ready' && hosts.length > 0 && !current && <div className="notice">このホストのメトリクスはまだありません。</div>}
      {state === 'ready' && current && <>
        <section className="metric-grid" aria-label="最新メトリクス">{cards.map((card) => <article className="metric-card" key={card.label}>
          <div className="metric-top"><span>{card.label}</span><i className={`metric-dot ${card.tone}`} /></div><strong>{card.value}</strong>
          <small>最新の 1 分平均</small>
        </article>)}</section>
        <div className="section-title"><div><span className="eyebrow">HISTORY</span><h2>メトリクスの推移</h2></div><span>1 分間隔 · 1 時間</span></div>
        <Charts metrics={metrics} />
      </>}
      <footer>cfmon <span>·</span> ホストの状態をシンプルに可視化</footer>
    </main>
  </div>;
}

export default App;
