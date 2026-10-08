import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { ACCESS_LOGIN_REQUIRED_MESSAGE, AccessLoginRequiredError, approveAgent, fetchAgents, fetchHosts, fetchMetrics, revokeAgent, type Agent, type Host, type Metric } from './api';
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
const accessLoginUrl = () => `/api/v1/auth/login?redirect_url=${encodeURIComponent(window.location.href)}`;

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <Group className="section-heading" justify="space-between" align="end">
    <Box><Text className="eyebrow">{eyebrow}</Text><Title order={2}>{title}</Title></Box>
    {detail && <Text size="xs" c="dimmed">{detail}</Text>}
  </Group>;
}

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
  const [installCopied, setInstallCopied] = useState(false);
  const [installCopyError, setInstallCopyError] = useState('');
  const [navOpened, navHandlers] = useDisclosure(false);
  const generation = useRef(0);
  const selectedHost = hosts.find((host) => host.id === selectedId);
  const agentInstallCommand = `curl -fsSL https://raw.githubusercontent.com/OJII3/cfmon/main/scripts/install-agent.sh | sh -s -- '${window.location.origin}/api/v1/ingest'`;

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
      setMutationError(cause instanceof AccessLoginRequiredError ? cause.message : message.includes('expired') || message.includes('pending_agent_not_found')
        ? '申請の期限が切れています。Agent を再起動して新しい申請を送ってください。'
        : message.includes('conflict') || message.includes('host_already_approved')
          ? 'このホストはすでに登録されています。登録済み Agent を確認してください。'
          : message || '操作に失敗しました。最新状態を再読み込みしてください。');
      setRefreshKey((value) => value + 1);
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
    className="app-shell"
    header={{ height: 64 }}
    navbar={{ width: 248, breakpoint: 'sm', collapsed: { mobile: !navOpened } }}
    padding="xl"
  >
    <AppShell.Navbar className="sidebar" p="md">
      <AppShell.Section className="brand-row">
        <a className="brand" href="#"><span className="brand-mark">c</span><span>cfmon<small>HOST MONITOR</small></span></a>
      </AppShell.Section>
      <AppShell.Section grow component={ScrollArea} className="host-nav">
        <Group className="nav-heading" justify="space-between"><Text className="eyebrow">インベントリ</Text><Badge variant="light" color="gray">{hosts.length}</Badge></Group>
        <Stack gap={5}>
          {hosts.map((host) => <NavLink
            key={host.id}
            label={host.hostname}
            description={host.os || 'OS 不明'}
            active={selectedId === host.id}
            leftSection={<span className="host-dot" />}
            onClick={() => {
              navHandlers.close();
              if (host.id === selectedId) return;
              setMetrics([]);
              setState('loading');
              setSelectedId(host.id);
            }}
          />)}
        </Stack>
      </AppShell.Section>
      <AppShell.Section className="sidebar-foot"><span className="live-dot" />自動更新 30 秒</AppShell.Section>
    </AppShell.Navbar>

    <AppShell.Header className="topbar" px={{ base: 'md', sm: 'xl' }}>
      <Group justify="space-between" h="100%">
        <Group gap="sm"><Burger opened={navOpened} onClick={navHandlers.toggle} hiddenFrom="sm" size="sm" aria-label="ホスト一覧を開く" /><Text className="breadcrumb">システム <span>/</span> ホスト</Text></Group>
        <Group gap="md"><Text className="updated">{updatedAt ? `更新 ${updatedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '接続中'}</Text>
          <Button variant="default" size="xs" onClick={() => setRefreshKey((value) => value + 1)} leftSection={<span className="refresh-glyph">↻</span>}>更新</Button>
        </Group>
      </Group>
    </AppShell.Header>

    <AppShell.Main className="main-content">
      <Stack gap="xl">
        <Group className="page-heading" justify="space-between" align="center">
          <Box><Text className="eyebrow">OVERVIEW / HOSTS</Text><Title order={1}>{selectedHost?.hostname ?? 'ホスト監視'}</Title>
            <Text c="dimmed" size="sm">{selectedHost ? `${selectedHost.os || 'OS 不明'} · 最終受信 ${formatSeen(selectedHost.last_seen)}` : 'ホストの状態をリアルタイムで確認できます。'}</Text>
          </Box>
          {selectedHost && <Badge className="status-pill" variant="light" color={Date.now() - new Date(selectedHost.last_seen).getTime() < 120_000 ? 'teal' : 'gray'} leftSection={<span className="status-dot" />}>
            {Date.now() - new Date(selectedHost.last_seen).getTime() < 120_000 ? '最近受信' : '受信停止'}
          </Badge>}
        </Group>

        <section>
          <SectionHeading eyebrow="AGENT ACCESS" title="Agent の登録" detail="承認前の Agent はデータを送信できません" />
          <Paper className="agent-install-panel" withBorder p="md" mt="sm">
            <Stack gap="xs" className="install-copy">
              <Text fw={600} size="sm">Linux x86_64 / macOS に Agent を追加</Text>
              <Code className="install-command">{agentInstallCommand}</Code>
              <Text size="xs" c="dimmed">Linux x86_64 と macOS arm64 に対応しています。監視対象ホストのターミナルで実行してください。clone、MoonBit、C 開発環境は不要です。</Text>
              {installCopyError && <Text size="xs" c="red" role="alert">{installCopyError}</Text>}
            </Stack>
            <Button className="install-button" onClick={() => void copyAgentInstallCommand()}>{installCopied ? 'コピーしました' : 'インストールコマンドをコピー'}</Button>
          </Paper>
        </section>

        {agentError && <Alert color="red" title="Agent 一覧を取得できませんでした" withCloseButton={false}>
          <Text size="sm">{agentError}</Text>
          {agentError === ACCESS_LOGIN_REQUIRED_MESSAGE && <Button component="a" href={accessLoginUrl()} variant="subtle" size="xs" mt="xs">Cloudflare Access にログイン</Button>}
          <Button variant="light" color="red" size="xs" mt="xs" onClick={() => setRefreshKey((value) => value + 1)}>再試行</Button>
        </Alert>}
        {mutationError && <Alert color="red" title="操作を完了できませんでした">
          <Text size="sm">{mutationError}</Text>
          {mutationError === ACCESS_LOGIN_REQUIRED_MESSAGE && <Button component="a" href={accessLoginUrl()} variant="subtle" size="xs" mt="xs">Cloudflare Access にログイン</Button>}
        </Alert>}

        <section>
          <SectionHeading eyebrow="PENDING APPROVAL" title="承認待ち" detail={`${pendingAgents.length} 件`} />
          {!agentError && pendingAgents.length === 0 && <Paper className="agent-empty" withBorder mt="sm"><Text c="dimmed" size="sm">承認待ちの Agent はありません。</Text></Paper>}
          <Stack gap="sm" mt="sm">
            {pendingAgents.map((agent) => <Paper className="agent-card pending-agent" withBorder p="lg" key={agent.public_key}>
              <Group justify="space-between" align="start">
                <Box><Badge color="yellow" variant="light">承認待ち</Badge><Title order={3} mt="sm">{agent.host}</Title><Text size="xs" c="dimmed">{agent.os || 'OS 不明'} · 登録申請 {formatAge(agent.last_requested_at)}</Text></Box>
              </Group>
              <Text className="fingerprint-label" size="xs" mt="lg" mb="xs">公開鍵の指紋 <span>SHA-256</span></Text>
              <Code className="fingerprint">{formatFingerprint(agent.fingerprint)}</Code>
              <Group justify="space-between" align="center" mt="md" className="approval-actions">
                <Checkbox checked={!!checked[agent.public_key]} onChange={(event) => setChecked((current) => ({ ...current, [agent.public_key]: event.currentTarget.checked }))} label="Agent 画面の指紋と一致することを確認しました" />
                <Button disabled={!checked[agent.public_key] || !!busyAgent} loading={busyAgent === agent.public_key} onClick={() => void mutateAgent(agent, 'approve')}>この Agent を承認</Button>
              </Group>
            </Paper>)}
          </Stack>
        </section>

        <section>
          <SectionHeading eyebrow="REGISTERED AGENTS" title="登録済み Agent" detail={`${approvedAgents.length} 台`} />
          {approvedAgents.length > 0 && <Stack gap="xs" mt="sm">{approvedAgents.map((agent) => <Paper className="registered-agent" withBorder p="sm" key={agent.public_key}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap" className="registered-copy"><Badge color="teal" variant="light">承認済み</Badge><Box><Text fw={600} size="sm" truncate>{agent.host}</Text><Text size="xs" c="dimmed">{agent.os || 'OS 不明'}</Text></Box></Group>
              <Button variant="light" color="red" size="xs" disabled={!!busyAgent} loading={busyAgent === agent.public_key} onClick={() => void mutateAgent(agent, 'revoke')}>登録解除</Button>
            </Group>
          </Paper>)}</Stack>}
        </section>

        {state === 'loading' && <Alert color="teal" title="読み込み中" icon={<span className="loading-mark">◌</span>}>メトリクスを読み込んでいます…</Alert>}
        {state === 'error' && <Alert color="red" title="データを取得できませんでした">
          <Text size="sm">{error}</Text>
          {error === ACCESS_LOGIN_REQUIRED_MESSAGE && <Button component="a" href={accessLoginUrl()} variant="subtle" size="xs" mt="xs">Cloudflare Access にログイン</Button>}
          <Button variant="light" color="red" size="xs" mt="xs" onClick={() => setRefreshKey((value) => value + 1)}>再試行</Button>
        </Alert>}
        {state === 'ready' && hosts.length === 0 && <Paper className="empty-state" withBorder p="xl"><Text className="empty-icon">⌁</Text><Title order={2}>ホストがまだありません</Title><Text c="dimmed" size="sm">Agent の申請を承認すると、メトリクスが届き始めます。</Text></Paper>}
        {state === 'ready' && hosts.length > 0 && !current && <Alert color="gray">このホストのメトリクスはまだありません。</Alert>}
        {state === 'ready' && current && <section>
          <SectionHeading eyebrow="LATEST METRICS" title="最新の状態" detail="1 分平均" />
          <SimpleGrid className="metric-grid" cols={{ base: 2, md: 3, xl: 5 }} spacing="sm" mt="sm" aria-label="最新メトリクス">
            {cards.map((card) => <Paper className={`metric-card ${card.tone}`} withBorder p="md" key={card.label}>
              <Text className="metric-label" size="xs" c="dimmed">{card.label}</Text><Text className="metric-value" fw={600}>{card.value}</Text>
            </Paper>)}
          </SimpleGrid>
          <SectionHeading eyebrow="HISTORY" title="メトリクスの推移" detail="1 分間隔 · 1 時間" />
          <Charts metrics={metrics} />
        </section>}
      </Stack>
      <Text className="app-footer" ta="center">cfmon <span>·</span> ホストの状態をシンプルに可視化</Text>
    </AppShell.Main>
  </AppShell>;
}

export default App;
