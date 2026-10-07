export type Host = { id: string; hostname: string; os: string; last_seen: string };
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

async function get<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const fetchHosts = (token: string, signal: AbortSignal) =>
  get<{ hosts: Host[] }>('/api/v1/hosts', token, signal);

export const fetchMetrics = (id: string, token: string, signal: AbortSignal) =>
  get<HostMetrics>(`/api/v1/hosts/${encodeURIComponent(id)}/metrics`, token, signal);
