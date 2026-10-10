import type { Metric } from './api';
import { Center, Grid, Group, Paper, Text, ThemeIcon } from '@mantine/core';
import { memo } from 'react';

type Props = { metrics: Metric[] };
const rxColor = 'var(--mantine-color-teal-6)';
const txColor = 'var(--mantine-color-blue-6)';
const sampleTime = (metric?: Metric) => metric
  ? new Date(metric.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  : '—';

function LineChart({ metrics, field, color, label, unit = '%' }: Props & {
  field: 'cpu' | 'memory' | 'gpu_utilization' | 'gpu_memory'; color: string; label: string; unit?: string;
}) {
  const values = metrics.map((metric) => {
    const value = metric[field];
    return value === null ? null : value * (unit === '%' ? 100 : 1);
  });
  const first = metrics.length ? new Date(metrics[0].timestamp).getTime() : 0;
  const last = metrics.length ? new Date(metrics.at(-1)!.timestamp).getTime() : 0;
  const points = values.flatMap((value, index) => {
    if (value === null) return [];
    const timestamp = new Date(metrics[index].timestamp).getTime();
    const x = last === first ? 50 : ((timestamp - first) / (last - first)) * 100;
    const y = 100 - Math.max(0, Math.min(100, value));
    return [`${x},${y}`];
  }).join(' ');
  const latest = values.at(-1);
  const available = values.filter((value): value is number => value !== null);
  return <Grid.Col span={{ base: 12, md: 6 }}><Paper withBorder p="md">
    <Group justify="space-between" align="start"><Text fw={600} size="sm">{label}</Text>
      <Text fw={600} ff="monospace">{latest == null ? '—' : `${latest.toFixed(1)}${unit}`}</Text></Group>
    {available.length ? <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${label}の推移`} style={{ display: 'block', width: '100%', height: 140, overflow: 'visible', marginTop: 10 }}>
      {[25, 50, 75].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--mantine-color-default-border)" strokeWidth=".7" vectorEffect="non-scaling-stroke" />)}
      {available.length === 1 ? <circle cx="50" cy={100 - Math.max(0, Math.min(100, available[0]))} r="2.2" fill={color} /> : <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
    </svg> : <Center h={140}><Text c="dimmed" size="sm">データがありません</Text></Center>}
    <Group mt="xs" justify="space-between"><Text size="xs" c="dimmed" ff="monospace">{sampleTime(metrics[0])}</Text><Text size="xs" c="dimmed" ff="monospace">{sampleTime(metrics.at(-1))}</Text></Group>
  </Paper></Grid.Col>;
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
  return <Grid.Col span={12}><Paper withBorder p="md">
    <Group justify="space-between" align="start"><Text fw={600} size="sm">ネットワーク</Text>
      <Group gap="sm" wrap="wrap"><Text component="span" c="dimmed" ff="monospace"><ThemeIcon component="span" size={8} radius="xl" color="teal" mr={6} />受信 {format(latest?.rx_bps)}</Text><Text component="span" c="dimmed" ff="monospace"><ThemeIcon component="span" size={8} radius="xl" color="blue" mr={6} />送信 {format(latest?.tx_bps)}</Text></Group></Group>
    {metrics.length ? <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="ネットワーク通信量の推移" style={{ display: 'block', width: '100%', height: 155, overflow: 'visible', marginTop: 10 }}>
      {[25, 50, 75].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--mantine-color-default-border)" strokeWidth=".7" vectorEffect="non-scaling-stroke" />)}
      {metrics.length === 1 ? <><circle cx="50" cy={100 - metrics[0].rx_bps / max * 92} r="2.2" fill={rxColor} /><circle cx="50" cy={100 - metrics[0].tx_bps / max * 92} r="2.2" fill={txColor} /></> : <>
        <polyline points={path('rx_bps')} fill="none" stroke={rxColor} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={path('tx_bps')} fill="none" stroke={txColor} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </>}
    </svg> : <Center h={140}><Text c="dimmed" size="sm">データがありません</Text></Center>}
    <Group mt="xs" justify="space-between"><Text size="xs" c="dimmed" ff="monospace">{sampleTime(metrics[0])}</Text><Text size="xs" c="dimmed" ff="monospace">{sampleTime(metrics.at(-1))}</Text></Group>
  </Paper></Grid.Col>;
}

export const Charts = memo(function Charts({ metrics }: Props) {
  const hasGpu = metrics.some((metric) => metric.gpu_utilization !== null || metric.gpu_memory !== null);
  return <Grid gap="sm">
    <LineChart metrics={metrics} field="cpu" color={rxColor} label="CPU 使用率" />
    <LineChart metrics={metrics} field="memory" color={txColor} label="メモリ使用率" />
    {hasGpu && <LineChart metrics={metrics} field="gpu_utilization" color="grape" label="GPU 使用率" />}
    {hasGpu && <LineChart metrics={metrics} field="gpu_memory" color="violet" label="GPU メモリ使用率" />}
    <NetworkChart metrics={metrics} />
  </Grid>;
});
