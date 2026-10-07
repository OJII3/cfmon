import type { Env } from "./index";
import { isValidHostId } from "./ingest";

type JsonResponse = (data: unknown, status?: number) => Response;

function timestamp(value: unknown): string {
  const text = String(value ?? "");
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(text.replace(" ", "T") + (text.endsWith("Z") ? "" : "Z"));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export async function handleQuery(
  kind: "hosts" | "metrics",
  _request: Request,
  env: Env,
  json: JsonResponse,
  id?: string,
): Promise<Response> {
  if (!env.ANALYTICS_SQL) return json({ error: "service_unavailable" }, 503);
  if (kind === "metrics" && !isValidHostId(id ?? "")) return json({ error: "invalid_host_id" }, 400);

  const query = kind === "hosts"
    ? `SELECT index1 AS id, argMax(blob1, timestamp) AS hostname, argMax(blob2, timestamp) AS os, max(timestamp) AS last_seen FROM events.analyticsEngine.cfmon_metrics WHERE timestamp >= NOW() - INTERVAL '1' DAY GROUP BY index1 ORDER BY last_seen DESC LIMIT 1000`
    : `SELECT toStartOfInterval(timestamp, INTERVAL '1' MINUTE) AS bucket, SUM(_sample_interval * double1) / SUM(_sample_interval) AS cpu, SUM(_sample_interval * double2) / SUM(_sample_interval) AS memory, SUM(_sample_interval * double3) / SUM(_sample_interval) AS load1, SUM(_sample_interval * double4) / SUM(_sample_interval) AS disk, SUM(_sample_interval * double5) / SUM(_sample_interval) AS rx_bps, SUM(_sample_interval * double6) / SUM(_sample_interval) AS tx_bps, SUM(_sample_interval * double7) / SUM(_sample_interval) AS uptime FROM events.analyticsEngine.cfmon_metrics WHERE index1 = $host AND timestamp >= NOW() - INTERVAL '1' HOUR GROUP BY bucket ORDER BY bucket DESC LIMIT 60`;

  let rows: Record<string, unknown>[];
  try {
    const result = await env.ANALYTICS_SQL.query({
      query,
      ...(kind === "metrics" ? { params: { host: id ?? "" } } : {}),
    });
    rows = result.data;
  } catch {
    return json({ error: "upstream_unavailable" }, 502);
  }

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
    cpu: Number(row.cpu), memory: Number(row.memory), load1: Number(row.load1),
    disk: Number(row.disk), rx_bps: Number(row.rx_bps), tx_bps: Number(row.tx_bps), uptime: Number(row.uptime),
  })).filter((row) => row.timestamp).reverse();
  return json({ host: id, metrics });
}
