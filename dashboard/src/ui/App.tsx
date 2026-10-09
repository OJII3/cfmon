import { useState } from 'react';
import {
  Anchor,
  Alert,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Checkbox,
  Code,
  Group,
  NavLink,
  Paper,
  SegmentedControl,
  ScrollArea,
  Skeleton,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useSwipeable } from 'react-swipeable';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCESS_LOGIN_REQUIRED_MESSAGE, AccessLoginRequiredError, approveAgent, fetchAgents, fetchHosts, fetchMetrics, revokeAgent, type Agent, type HistoryRange } from './api';
import { Charts } from './Charts';

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
const accessLoginUrl = () => `/api/v1/auth/login?redirect_url=${encodeURIComponent(window.location.href)}`;

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <Group justify="space-between" align="end">
    <Box><Text size="xs" c="dimmed" ff="monospace">{eyebrow}</Text><Title order={2}>{title}</Title></Box>
    {detail && <Text size="xs" c="dimmed">{detail}</Text>}
  </Group>;
}

function MetricGauge({ label, value, ratio, color }: { label: string; value: string; ratio?: number; color?: string }) {
  const circumference = 2 * Math.PI * 44;
  const progress = ratio === undefined ? undefined : Math.max(0, Math.min(1, ratio));

  return <Box role="group" aria-label={`${label} ${value}`} style={{ width: '100%', maxWidth: 136, aspectRatio: '1', position: 'relative', marginInline: 'auto' }}>
    <svg viewBox="0 0 100 100" aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
      <circle cx="50" cy="50" r="44" fill="none" stroke="var(--mantine-color-default-border)" strokeWidth="7" />
      {progress !== undefined && color && <circle cx="50" cy="50" r="44" fill="none" stroke={`var(--mantine-color-${color}-6)`} strokeWidth="7" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress)} />}
    </svg>
    <Stack gap={0} align="center" justify="center" style={{ position: 'absolute', inset: 0 }}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text fw={600} ff="monospace" style={{ fontSize: value.length > 6 ? 'clamp(0.65rem, 2.2vw, 0.875rem)' : 'clamp(0.9rem, 3vw, 1.25rem)', lineHeight: 1.3 }}>{value}</Text>
    </Stack>
  </Box>;
}

function MetricsLoading() {
  return <section aria-label="メトリクスを読み込み中" aria-busy="true">
    <SectionHeading eyebrow="LATEST METRICS" title="最新の状態" detail="1 分平均" />
    <SimpleGrid cols={3} spacing="xs" mt="md" mb="xl" aria-label="最新メトリクス">
      {['CPU', 'メモリ', 'ディスク', 'Load 1m', '稼働時間'].map((label) => <Box key={label} style={{ width: '100%', maxWidth: 136, aspectRatio: '1', marginInline: 'auto', display: 'grid', placeItems: 'center' }}>
        <Skeleton circle width="100%" height="100%" />
      </Box>)}
    </SimpleGrid>
    <Group justify="space-between" align="end" wrap="wrap">
      <SectionHeading eyebrow="HISTORY" title="メトリクスの推移" />
      <SegmentedControl size="xs" value={String(1)} data={[{ label: '1 時間', value: '1' }, { label: '6 時間', value: '6' }, { label: '24 時間', value: '24' }]} disabled aria-label="履歴の表示範囲" />
    </Group>
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm" mt="sm">
      {[0, 1, 2].map((chart) => <Paper key={chart} withBorder p="md" style={{ gridColumn: chart === 2 ? '1 / -1' : undefined }}>
        <Group justify="space-between"><Skeleton height={18} width={120} /><Skeleton height={18} width={56} /></Group>
        <Skeleton height={chart === 2 ? 155 : 140} mt={10} />
        <Group mt="xs" justify="space-between"><Skeleton height={14} width={42} /><Skeleton height={14} width={42} /></Group>
      </Paper>)}
    </SimpleGrid>
  </section>;
}

function App() {
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get('host') ?? '');
  const [page, setPage] = useState<'metrics' | 'devices'>('metrics');
  const [historyRange, setHistoryRange] = useState<HistoryRange>(1);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busyAgent, setBusyAgent] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [installCopied, setInstallCopied] = useState(false);
  const [installCopyError, setInstallCopyError] = useState('');
  const [navOpened, navHandlers] = useDisclosure(false);
  const openNavSwipe = useSwipeable({
    onSwipedRight: () => navHandlers.open(),
    delta: 50,
  });
  const closeNavSwipe = useSwipeable({
    onSwipedLeft: () => navHandlers.close(),
    delta: 50,
  });
  const queryClient = useQueryClient();
  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: ({ signal }) => fetchHosts(signal),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) => fetchAgents(signal),
    enabled: page === 'devices',
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const hosts = hostsQuery.data?.hosts ?? [];
  const agents = agentsQuery.data?.agents ?? [];
  const selectedHost = hosts.find((host) => host.id === selectedId) ?? hosts[0];
  const metricsQuery = useQuery({
    queryKey: ['metrics', selectedHost?.id, historyRange],
    queryFn: ({ signal }) => fetchMetrics(selectedHost!.id, historyRange, signal),
    enabled: !!selectedHost && page === 'metrics',
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const metrics = metricsQuery.data?.metrics ?? [];
  const error = hostsQuery.error ?? metricsQuery.error;
  const errorMessage = error instanceof Error ? error.message : 'データを取得できませんでした';
  const isLoading = hostsQuery.isPending || (!!selectedHost && metricsQuery.isPending);
  const hasError = (!hostsQuery.data && hostsQuery.isError) || (!!selectedHost && !metricsQuery.data && metricsQuery.isError);
  const state = isLoading ? 'loading' : hasError ? 'error' : 'ready';
  const agentError = agentsQuery.isError
    ? agentsQuery.error instanceof Error ? agentsQuery.error.message : 'Agent 一覧を取得できませんでした'
    : '';
  const updatedAt = metricsQuery.dataUpdatedAt ? new Date(metricsQuery.dataUpdatedAt) : null;
  const agentInstallCommand = `curl -fsSL https://raw.githubusercontent.com/OJII3/cfmon/main/scripts/install-agent.sh | sh -s -- '${window.location.origin}/api/v1/ingest'`;

  const current = metrics.at(-1);
  const gauges = current ? [
    { label: 'CPU', value: formatPercent(current.cpu), ratio: current.cpu, color: 'teal' },
    { label: 'メモリ', value: formatPercent(current.memory), ratio: current.memory, color: 'blue' },
    { label: 'ディスク', value: formatPercent(current.disk), ratio: current.disk, color: 'orange' },
    { label: 'Load 1m', value: current.load1.toFixed(2) },
    { label: '稼働時間', value: formatUptime(current.uptime) },
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
      void queryClient.invalidateQueries();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setMutationError(cause instanceof AccessLoginRequiredError ? cause.message : message.includes('expired') || message.includes('pending_agent_not_found')
        ? '申請の期限が切れています。Agent を再起動して新しい申請を送ってください。'
        : message.includes('conflict') || message.includes('host_already_approved')
          ? 'このホストはすでに登録されています。登録済み Agent を確認してください。'
          : message || '操作に失敗しました。最新状態を再読み込みしてください。');
      void queryClient.invalidateQueries();
    } finally {
      setBusyAgent('');
    }
  }

  async function copyAgentInstallCommand() {
    try {
      await navigator.clipboard.writeText(agentInstallCommand);
      setInstallCopied(true);
      setInstallCopyError('');
      window.setTimeout(() => setInstallCopied(false), 2000);
    } catch {
      setInstallCopyError('コマンドをコピーできませんでした。ブラウザーのクリップボード権限を確認してください。');
    }
  }

  return <AppShell
    header={{ height: 64 }}
    navbar={{ width: 248, breakpoint: 'sm', collapsed: { mobile: !navOpened } }}
    padding="md"
  >
    <AppShell.Navbar {...closeNavSwipe} p="md">
      <AppShell.Section mb="xl">
        <Anchor href="#" underline="never" c="inherit"><Group gap="sm"><ThemeIcon color="teal" radius="md">c</ThemeIcon><Box><Text fw={700}>cfmon</Text><Text size="xs" c="dimmed" ff="monospace">HOST MONITOR</Text></Box></Group></Anchor>
      </AppShell.Section>
      <AppShell.Section grow component={ScrollArea}>
        <Stack gap={5}>
          <NavLink label="メトリクス" active={page === 'metrics'} onClick={() => { setPage('metrics'); navHandlers.close(); }} />
          <NavLink label="デバイス管理" active={page === 'devices'} onClick={() => { setPage('devices'); navHandlers.close(); }} />
        </Stack>
        {page === 'metrics' && <>
          <Group justify="space-between" mt="xl" mb="xs"><Text size="xs" c="dimmed">ホスト</Text><Badge variant="light" color="gray">{hosts.length}</Badge></Group>
          <Stack gap={5}>
            {hosts.map((host) => <NavLink
              key={host.id}
              label={host.hostname}
              description={host.os || 'OS 不明'}
              active={selectedHost?.id === host.id}
              leftSection={<ThemeIcon size={8} radius="xl" color="teal" />}
              onClick={() => {
                navHandlers.close();
                if (host.id === selectedHost?.id) return;
                setSelectedId(host.id);
                const url = new URL(window.location.href);
                url.searchParams.set('host', host.id);
                window.history.replaceState(null, '', url);
              }}
            />)}
          </Stack>
        </>}
      </AppShell.Section>
      <AppShell.Section pt="md">
        <Group gap="xs"><ThemeIcon size={8} radius="xl" color="teal" /><Text size="xs" c="dimmed">自動更新 30 秒</Text></Group>
        <Anchor href="https://github.com/OJII3/cfmon" target="_blank" rel="noreferrer" size="xs" c="dimmed" mt="sm" display="block">GitHub リポジトリ ↗</Anchor>
      </AppShell.Section>
    </AppShell.Navbar>

    <AppShell.Header px={{ base: 'md', sm: 'xl' }}>
      <Group justify="space-between" h="100%">
        <Group gap="sm"><Burger opened={navOpened} onClick={navHandlers.toggle} hiddenFrom="sm" size="sm" aria-label="ナビゲーションを開く" /><Text size="sm" c="dimmed">システム / {page === 'metrics' ? 'メトリクス' : 'デバイス管理'}</Text></Group>
        <Group gap="md"><Text visibleFrom="sm" size="xs" c="dimmed" ff="monospace">{page === 'metrics' ? (updatedAt ? `更新 ${updatedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '接続中') : 'Agent の登録と状態'}</Text>
          <Button variant="default" size="xs" onClick={() => void queryClient.invalidateQueries()} leftSection={<Text component="span" c="teal" size="lg">↻</Text>}>更新</Button>
        </Group>
      </Group>
    </AppShell.Header>

    <AppShell.Main {...openNavSwipe}>
      {page === 'metrics' ? <Stack gap="xl">
        <Group justify="space-between" align="center">
          <Box><Text size="xs" c="dimmed" ff="monospace">OVERVIEW / HOSTS</Text>{hostsQuery.isPending && !selectedHost ? <Skeleton height={36} width={220} my={2} /> : <Title order={1}>{selectedHost?.hostname ?? 'ホスト監視'}</Title>}
            {hostsQuery.isPending && !selectedHost ? <Skeleton height={20} width={280} mt={4} /> : <Text c="dimmed" size="sm">{selectedHost ? `${selectedHost.os || 'OS 不明'} · 最終受信 ${formatSeen(selectedHost.last_seen)}` : 'ホストの状態をリアルタイムで確認できます。'}</Text>}
          </Box>
          {hostsQuery.isPending && !selectedHost ? <Skeleton height={22} width={72} /> : selectedHost && <Badge variant="light" color={Date.now() - new Date(selectedHost.last_seen).getTime() < 120_000 ? 'teal' : 'gray'}>
            {Date.now() - new Date(selectedHost.last_seen).getTime() < 120_000 ? '最近受信' : '受信停止'}
          </Badge>}
        </Group>

        {state === 'loading' && <MetricsLoading />}
        {state === 'error' && <Alert color="red" title="データを取得できませんでした">
          <Text size="sm">{errorMessage}</Text>
          {errorMessage === ACCESS_LOGIN_REQUIRED_MESSAGE && <Button component="a" href={accessLoginUrl()} variant="subtle" size="xs" mt="xs">Cloudflare Access にログイン</Button>}
          <Button variant="light" color="red" size="xs" mt="xs" onClick={() => void queryClient.invalidateQueries()}>再試行</Button>
        </Alert>}
        {state === 'ready' && hosts.length === 0 && <Paper withBorder p="xl" ta="center"><ThemeIcon size="xl" variant="light" radius="md" mx="auto" mb="md">⌁</ThemeIcon><Title order={2}>ホストがまだありません</Title><Text c="dimmed" size="sm">Agent の申請を承認すると、メトリクスが届き始めます。</Text></Paper>}
        {state === 'ready' && hosts.length > 0 && !current && <Alert color="gray">このホストのメトリクスはまだありません。</Alert>}
        {state === 'ready' && current && <section>
          <SectionHeading eyebrow="LATEST METRICS" title="最新の状態" detail="1 分平均" />
          <SimpleGrid cols={3} spacing="xs" mt="md" mb="xl" aria-label="最新メトリクス">
            {gauges.map((gauge) => <MetricGauge key={gauge.label} {...gauge} />)}
          </SimpleGrid>
          <Group justify="space-between" align="end" wrap="wrap">
            <SectionHeading eyebrow="HISTORY" title="メトリクスの推移" />
            <SegmentedControl
              size="xs"
              value={String(historyRange)}
              onChange={(value) => setHistoryRange(Number(value) as HistoryRange)}
              data={[
                { label: '1 時間', value: '1' },
                { label: '6 時間', value: '6' },
                { label: '24 時間', value: '24' },
              ]}
              aria-label="履歴の表示範囲"
            />
          </Group>
          <Charts metrics={metrics} />
        </section>}

      </Stack>
      : <Stack gap="xl">
        <Box><Text size="xs" c="dimmed" ff="monospace">DEVICE MANAGEMENT / AGENTS</Text><Title order={1}>デバイス管理</Title><Text c="dimmed" size="sm">Agent の追加、承認、登録解除を管理します。</Text></Box>
        {agentError && <Alert color="red" title="Agent 一覧を取得できませんでした" withCloseButton={false}>
          <Text size="sm">{agentError}</Text>
          {agentError === ACCESS_LOGIN_REQUIRED_MESSAGE && <Button component="a" href={accessLoginUrl()} variant="subtle" size="xs" mt="xs">Cloudflare Access にログイン</Button>}
          <Button variant="light" color="red" size="xs" mt="xs" onClick={() => void queryClient.invalidateQueries({ queryKey: ['agents'] })}>再試行</Button>
        </Alert>}
        {mutationError && <Alert color="red" title="操作を完了できませんでした">
          <Text size="sm">{mutationError}</Text>
          {mutationError === ACCESS_LOGIN_REQUIRED_MESSAGE && <Button component="a" href={accessLoginUrl()} variant="subtle" size="xs" mt="xs">Cloudflare Access にログイン</Button>}
        </Alert>}

        <section>
          <SectionHeading eyebrow="AGENT ACCESS" title="Agent の登録" detail="承認前の Agent はデータを送信できません" />
          <Paper withBorder p="sm" mt="sm">
            <Group justify="space-between" gap="xs">
              <Text fw={600} size="sm">Linux x86_64 / macOS に Agent を追加</Text>
              <Button size="xs" onClick={() => void copyAgentInstallCommand()}>{installCopied ? 'コピーしました' : 'コマンドをコピー'}</Button>
            </Group>
            {installCopyError && <Text size="xs" c="red" mt="xs" role="alert">{installCopyError}</Text>}
            <Stack gap="xs" mt="xs">
              <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{agentInstallCommand}</Code>
              <Text size="xs" c="dimmed">Linux x86_64 と macOS arm64 に対応しています。監視対象ホストのターミナルで実行してください。clone、MoonBit、C 開発環境は不要です。</Text>
            </Stack>
          </Paper>
        </section>

        <section>
          <SectionHeading eyebrow="PENDING APPROVAL" title="承認待ち" detail={`${pendingAgents.length} 件`} />
          {!agentError && pendingAgents.length === 0 && <Paper withBorder p="md" mt="sm"><Text c="dimmed" size="sm">承認待ちの Agent はありません。</Text></Paper>}
          <Stack gap="sm" mt="sm">
            {pendingAgents.map((agent) => <Paper withBorder p="lg" key={agent.public_key}>
              <Box><Badge color="yellow" variant="light">承認待ち</Badge><Title order={3} mt="sm">{agent.host}</Title><Text size="xs" c="dimmed">{agent.os || 'OS 不明'} · 登録申請 {formatAge(agent.last_requested_at)}</Text></Box>
              <Text size="xs" c="dimmed" mt="lg" mb="xs">公開鍵の指紋 <Text component="span" size="xs" c="dimmed" ff="monospace">SHA-256</Text></Text>
              <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{formatFingerprint(agent.fingerprint)}</Code>
              <Stack gap="sm" mt="md">
                <Checkbox checked={!!checked[agent.public_key]} onChange={(event) => setChecked((current) => ({ ...current, [agent.public_key]: event.currentTarget.checked }))} label="Agent 画面の指紋と一致することを確認しました" />
                <Button disabled={!checked[agent.public_key] || !!busyAgent} loading={busyAgent === agent.public_key} onClick={() => void mutateAgent(agent, 'approve')}>この Agent を承認</Button>
              </Stack>
            </Paper>)}
          </Stack>
        </section>

        <section>
          <SectionHeading eyebrow="REGISTERED AGENTS" title="登録済み Agent" detail={`${approvedAgents.length} 台`} />
          {approvedAgents.length === 0 ? <Paper withBorder p="md" mt="sm"><Text c="dimmed" size="sm">登録済みの Agent はありません。</Text></Paper> : <Stack gap="xs" mt="sm">{approvedAgents.map((agent) => <Paper withBorder p="sm" key={agent.public_key}>
            <Group justify="space-between" wrap="wrap">
              <Group gap="sm" wrap="nowrap"><Badge color="teal" variant="light">承認済み</Badge><Box><Text fw={600} size="sm" truncate>{agent.host}</Text><Text size="xs" c="dimmed">{agent.os || 'OS 不明'} · 最終通信 {formatAge(agent.last_requested_at)}</Text></Box></Group>
              <Button variant="light" color="red" size="xs" disabled={!!busyAgent} loading={busyAgent === agent.public_key} onClick={() => void mutateAgent(agent, 'revoke')}>登録解除</Button>
            </Group>
          </Paper>)}</Stack>}
        </section>
      </Stack>}
    </AppShell.Main>
  </AppShell>;
}

export default App;
