import type { Env } from "./index";
import { isValidHostId } from "./ingest";

type JsonResponse = (data: unknown, status?: number) => Response;
export const quoteSqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

function authorized(request: Request, token: string | undefined): boolean {
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

function rowsFromResponse(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
  }
  return null;
}

function timestamp(value: unknown): string {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z"));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function runQuery(sql: string, env: Env): Promise<Record<string, unknown>[] | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return null;
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "text/plain" },
      body: sql,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return rowsFromResponse(await response.json());
  } catch {
    return null;
  }
}

export async function handleQuery(
  kind: "hosts" | "metrics",
  request: Request,
  env: Env,
  json: JsonResponse,
  id?: string,
): Promise<Response> {
  if (!env.QUERY_TOKEN) return json({ error: "service_unavailable" }, 503);
  if (!authorized(request, env.QUERY_TOKEN)) return json({ error: "unauthorized" }, 401);
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return json({ error: "service_unavailable" }, 503);
  if (kind === "metrics" && !isValidHostId(id ?? "")) return json({ error: "invalid_host_id" }, 400);

  const dataset = "cfmon_metrics";
  const sql = kind === "hosts"
    ? `SELECT index1 AS id, argMax(blob1, timestamp) AS hostname, argMax(blob2, timestamp) AS os, max(timestamp) AS last_seen FROM ${dataset} WHERE timestamp >= NOW() - INTERVAL '1' DAY GROUP BY index1 ORDER BY last_seen DESC LIMIT 1000 FORMAT JSON`
    : `SELECT toStartOfInterval(timestamp, INTERVAL '1' MINUTE) AS bucket, SUM(_sample_interval * double1) / SUM(_sample_interval) AS cpu, SUM(_sample_interval * double2) / SUM(_sample_interval) AS memory, SUM(_sample_interval * double3) / SUM(_sample_interval) AS load1, SUM(_sample_interval * double4) / SUM(_sample_interval) AS disk, SUM(_sample_interval * double5) / SUM(_sample_interval) AS rx_bps, SUM(_sample_interval * double6) / SUM(_sample_interval) AS tx_bps, SUM(_sample_interval * double7) / SUM(_sample_interval) AS uptime FROM ${dataset} WHERE index1 = ${quoteSqlLiteral(id ?? "")} AND timestamp >= NOW() - INTERVAL '1' HOUR GROUP BY bucket ORDER BY bucket DESC LIMIT 60 FORMAT JSON`;
  const rows = await runQuery(sql, env);
  if (!rows) return json({ error: "upstream_unavailable" }, 502);

  if (kind === "hosts") {
    return json({ hosts: rows.map((row) => ({
      id: String(row.id ?? ""),
      hostname: String(row.hostname ?? ""),
      os: String(row.os ?? ""),
      last_seen: timestamp(row.last_seen),
    })) });
  }
  const metrics = rows.map((row) => ({
    timestamp: timestamp(row.bucket),
    cpu: Number(row.cpu),
    memory: Number(row.memory),
    load1: Number(row.load1),
    disk: Number(row.disk),
    rx_bps: Number(row.rx_bps),
    tx_bps: Number(row.tx_bps),
    uptime: Number(row.uptime),
  })).filter((row) => row.timestamp).reverse();
  return json({ host: id, metrics });
}
