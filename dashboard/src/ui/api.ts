export type Host = { id: string; hostname: string; os: string; last_seen: string };
export type Agent = {
  public_key: string;
  host: string;
  os: string;
  status: 'pending' | 'approved' | 'revoked';
  fingerprint: string;
  last_requested_at: string;
};
export type Metric = {
  timestamp: string;
  cpu: number;
  memory: number;
  load1: number;
  disk: number;
  rx_bps: number;
  tx_bps: number;
  uptime: number;
};
export type HostMetrics = { host: string; metrics: Metric[] };

export const ACCESS_LOGIN_REQUIRED_MESSAGE = 'Cloudflare Access のログインが必要です。ログイン画面を開き、ログイン後に再読み込みしてください。';

export class AccessLoginRequiredError extends Error {
  constructor() {
    super(ACCESS_LOGIN_REQUIRED_MESSAGE);
    this.name = 'AccessLoginRequiredError';
  }
}

async function request<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    signal,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (response.status === 401) throw new AccessLoginRequiredError();
  const contentType = response.headers.get('content-type') ?? '';
  const responseUrl = new URL(response.url);
  if (responseUrl.origin === window.location.origin && responseUrl.pathname === '/cdn-cgi/access/login') {
    window.location.assign(response.url);
    throw new AccessLoginRequiredError();
  }
  if (contentType.includes('text/html')) throw new Error('API から予期しない HTML 応答を受け取りました。ログイン状態を確認してください。');
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const fetchHosts = (signal: AbortSignal) => request<{ hosts: Host[] }>('/api/v1/hosts', signal);
export const fetchMetrics = (id: string, signal: AbortSignal) =>
  request<HostMetrics>(`/api/v1/hosts/${encodeURIComponent(id)}/metrics`, signal);
export const fetchAgents = (signal: AbortSignal) => request<{ agents: Agent[] }>('/api/v1/agents', signal);
export const approveAgent = (agent: Agent) => request<{ status: string }>(`/api/v1/agents/${encodeURIComponent(agent.public_key)}/approve`, undefined, {
  method: 'POST', body: JSON.stringify({ fingerprint: agent.fingerprint }),
});
export const revokeAgent = (agent: Agent) => request<{ status: string }>(`/api/v1/agents/${encodeURIComponent(agent.public_key)}/revoke`, undefined, {
  method: 'POST', body: JSON.stringify({}),
});
