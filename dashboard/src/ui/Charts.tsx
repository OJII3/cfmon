import type { Metric } from './api';

type Props = { metrics: Metric[] };
const sampleTime = (metric?: Metric) => metric
  ? new Date(metric.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  : '—';

function LineChart({ metrics, field, color, label, unit = '%' }: Props & {
  field: 'cpu' | 'memory'; color: string; label: string; unit?: string;
}) {
  const values = metrics.map((metric) => metric[field] * (unit === '%' ? 100 : 1));
  const first = metrics.length ? new Date(metrics[0].timestamp).getTime() : 0;
  const last = metrics.length ? new Date(metrics.at(-1)!.timestamp).getTime() : 0;
  const points = values.map((value, index) => {
    const timestamp = new Date(metrics[index].timestamp).getTime();
    const x = last === first ? 50 : ((timestamp - first) / (last - first)) * 100;
    const y = 100 - Math.max(0, Math.min(100, value));
    return `${x},${y}`;
  }).join(' ');
  const latest = values.at(-1);
  return <section className="chart-card">
    <div className="chart-heading"><div><span className="eyebrow">直近 1 時間</span><h3>{label}</h3></div>
      <strong>{latest === undefined ? '—' : `${latest.toFixed(1)}${unit}`}</strong></div>
    {values.length ? <svg className="line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${label}の推移`}>
      {[25, 50, 75].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} className="grid-line" />)}
      {values.length === 1 ? <circle cx="50" cy={100 - Math.max(0, Math.min(100, values[0]))} r="2.2" fill={color} /> : <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
    </svg> : <div className="chart-empty">データがありません</div>}
    <div className="chart-axis"><span>{sampleTime(metrics[0])}</span><span>{sampleTime(metrics.at(-1))}</span></div>
  </section>;
}

function NetworkChart({ metrics }: Props) {
  const max = Math.max(1, ...metrics.flatMap((metric) => [metric.rx_bps, metric.tx_bps]));
  const first = metrics.length ? new Date(metrics[0].timestamp).getTime() : 0;
  const last = metrics.length ? new Date(metrics.at(-1)!.timestamp).getTime() : 0;
  const path = (field: 'rx_bps' | 'tx_bps') => metrics.map((metric) => {
    const timestamp = new Date(metric.timestamp).getTime();
    const x = last === first ? 50 : (timestamp - first) / (last - first) * 100;
    const y = 100 - metric[field] / max * 92;
    return `${x},${y}`;
  }).join(' ');
  const latest = metrics.at(-1);
  const format = (value = 0) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB/s` : value >= 1_000 ? `${(value / 1_000).toFixed(1)} KB/s` : `${Math.round(value)} B/s`;
  return <section className="chart-card network-card">
    <div className="chart-heading"><div><span className="eyebrow">直近 1 時間</span><h3>ネットワーク</h3></div>
      <div className="network-current"><span><i className="legend rx" />受信 {format(latest?.rx_bps)}</span><span><i className="legend tx" />送信 {format(latest?.tx_bps)}</span></div></div>
    {metrics.length ? <svg className="line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="ネットワーク通信量の推移">
      {[25, 50, 75].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} className="grid-line" />)}
      {metrics.length === 1 ? <><circle cx="50" cy={100 - metrics[0].rx_bps / max * 92} r="2.2" fill="#65d8b0" /><circle cx="50" cy={100 - metrics[0].tx_bps / max * 92} r="2.2" fill="#8aa8ff" /></> : <>
        <polyline points={path('rx_bps')} fill="none" stroke="#65d8b0" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={path('tx_bps')} fill="none" stroke="#8aa8ff" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </>}
    </svg> : <div className="chart-empty">データがありません</div>}
    <div className="chart-axis"><span>{sampleTime(metrics[0])}</span><span>{sampleTime(metrics.at(-1))}</span></div>
  </section>;
}

export function Charts({ metrics }: Props) {
  return <div className="charts-grid">
    <LineChart metrics={metrics} field="cpu" color="#65d8b0" label="CPU 使用率" />
    <LineChart metrics={metrics} field="memory" color="#8aa8ff" label="メモリ使用率" />
    <NetworkChart metrics={metrics} />
  </div>;
}
