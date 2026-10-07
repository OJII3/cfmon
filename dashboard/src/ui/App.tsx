import { useCallback, useEffect, useRef, useState } from 'react';
import { approveAgent, fetchAgents, fetchHosts, fetchMetrics, revokeAgent, type Agent, type Host, type Metric } from './api';
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
const formatAge = (value: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '時刻不明';
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
};
const formatFingerprint = (fingerprint: string) => fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint;
const accessLoginUrl = () => `/cdn-cgi/access/login?redirect_url=${encodeURIComponent(window.location.href)}`;

function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [agentError, setAgentError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busyAgent, setBusyAgent] = useState('');
  const [mutationError, setMutationError] = useState('');
  const generation = useRef(0);
  const selectedHost = hosts.find((host) => host.id === selectedId);

  const refresh = useCallback(async (signal: AbortSignal, run: number) => {
    if (run !== generation.current) return;
    setState((current) => current === 'ready' ? current : 'loading');
    const agentRequest = fetchAgents(signal).then((response) => {
      if (!signal.aborted && run === generation.current) {
        setAgents(response.agents);
        setAgentError('');
      }
    }).catch((cause) => {
      if (!signal.aborted && run === generation.current) {
        setAgentError(cause instanceof Error ? cause.message : 'Agent 一覧を取得できませんでした');
      }
    });
    try {
      const response = await fetchHosts(signal);
      if (signal.aborted || run !== generation.current) return;
      setHosts(response.hosts);
      const preferred = response.hosts.find((host) => host.id === selectedId) ?? response.hosts[0];
      if (preferred?.id !== selectedId) setMetrics([]);
      setSelectedId(preferred?.id ?? '');
      if (!preferred) {
        setMetrics([]);
      } else {
        const detail = await fetchMetrics(preferred.id, signal);
        if (signal.aborted || run !== generation.current) return;
        setMetrics(detail.metrics);
      }
      setState('ready');
      setError('');
      setUpdatedAt(new Date());
    } catch (cause) {
      if (signal.aborted || run !== generation.current) return;
      setError(cause instanceof Error ? cause.message : 'データを取得できませんでした');
      setState('error');
    }
    await agentRequest;
  }, [selectedId]);

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
  const pendingAgents = agents.filter((agent) => agent.status === 'pending');
  const approvedAgents = agents.filter((agent) => agent.status === 'approved');

  async function mutateAgent(agent: Agent, action: 'approve' | 'revoke') {
    setBusyAgent(agent.public_key);
    setMutationError('');
    try {
      if (action === 'approve') await approveAgent(agent);
      else await revokeAgent(agent);
      setChecked((current) => ({ ...current, [agent.public_key]: false }));
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setMutationError(message.includes('expired') || message.includes('pending_agent_not_found')
        ? '申請の期限が切れています。Agent を再起動して新しい申請を送ってください。'
        : message.includes('conflict') || message.includes('host_already_approved')
          ? 'このホストはすでに登録されています。登録済み Agent を確認してください。'
          : message || '操作に失敗しました。最新状態を再読み込みしてください。');
      setRefreshKey((value) => value + 1);
    } finally {
      setBusyAgent('');
    }
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

      <section className="section-title agent-section-title"><div><span className="eyebrow">AGENT ACCESS</span><h2>Agent の登録</h2></div><span>承認前の Agent はデータを送信できません</span></section>
      {agentError && <div className="notice error-notice"><strong>Agent 一覧を取得できませんでした</strong><p>{agentError}</p><a className="access-login-link" href={accessLoginUrl()}>Cloudflare Access にログイン</a><button onClick={() => setRefreshKey((value) => value + 1)}>再試行</button></div>}
      {mutationError && <div className="notice error-notice mutation-error"><strong>操作を完了できませんでした</strong><p>{mutationError}</p><a className="access-login-link" href={accessLoginUrl()}>Cloudflare Access にログイン</a></div>}
      {!agentError && pendingAgents.length === 0 && <div className="agent-empty">承認待ちの Agent はありません。</div>}
      {pendingAgents.map((agent) => <article className="agent-card pending-agent" key={agent.public_key}>
        <div className="agent-card-heading"><div><span className="agent-status pending">承認待ち</span><h3>{agent.host}</h3><p>{agent.os || 'OS 不明'} · 登録申請 {formatAge(agent.last_requested_at)}</p></div></div>
        <div className="fingerprint-label">公開鍵の指紋 <span>SHA-256</span></div>
        <code className="fingerprint">{formatFingerprint(agent.fingerprint)}</code>
        <label className="fingerprint-check"><input type="checkbox" checked={!!checked[agent.public_key]} onChange={(event) => setChecked((current) => ({ ...current, [agent.public_key]: event.target.checked }))} />Agent 画面の指紋と一致することを確認しました</label>
        <div className="agent-actions"><button className="approve-button" disabled={!checked[agent.public_key] || !!busyAgent} onClick={() => void mutateAgent(agent, 'approve')}>{busyAgent === agent.public_key ? '処理中…' : 'この Agent を承認'}</button></div>
      </article>)}

      <section className="section-title registered-title"><div><span className="eyebrow">REGISTERED AGENTS</span><h2>登録済み Agent</h2></div><span>{approvedAgents.length} 台</span></section>
      {approvedAgents.length > 0 && <div className="registered-agents">{approvedAgents.map((agent) => <article className="registered-agent" key={agent.public_key}>
        <div><span className="agent-status approved">承認済み</span><strong>{agent.host}</strong><small>{agent.os || 'OS 不明'}</small></div>
        <button className="revoke-button" disabled={!!busyAgent} onClick={() => void mutateAgent(agent, 'revoke')}>{busyAgent === agent.public_key ? '処理中…' : '登録解除'}</button>
      </article>)}</div>}

      {state === 'loading' && <div className="notice"><span className="spinner" />メトリクスを読み込んでいます…</div>}
      {state === 'error' && <div className="notice error-notice"><strong>データを取得できませんでした</strong><p>{error}</p><a className="access-login-link" href={accessLoginUrl()}>Cloudflare Access にログイン</a><button onClick={() => setRefreshKey((value) => value + 1)}>再試行</button></div>}
      {state === 'ready' && hosts.length === 0 && <div className="empty-state"><div className="empty-icon">⌁</div><h2>ホストがまだありません</h2><p>Agent の申請を承認すると、メトリクスが届き始めます。</p></div>}
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
