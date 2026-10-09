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
  request: Request,
  env: Env,
  json: JsonResponse,
  id?: string,
): Promise<Response> {
  if (!env.ANALYTICS_SQL) return json({ error: "service_unavailable" }, 503);
  if (kind === "metrics" && !isValidHostId(id ?? "")) return json({ error: "invalid_host_id" }, 400);

  const rangeHours = Number(new URL(request.url).searchParams.get("range") ?? "1");
  if (kind === "metrics" && ![1, 6, 24].includes(rangeHours)) return json({ error: "invalid_metrics_range" }, 400);

  const query = kind === "hosts"
    ? `SELECT index1 AS id, argMax(blob1, timestamp) AS hostname, argMax(blob2, timestamp) AS os, argMax(timestamp, timestamp) AS last_seen FROM events.analyticsEngine.cfmon_metrics WHERE timestamp >= NOW() - INTERVAL '1' DAY GROUP BY index1 ORDER BY last_seen DESC LIMIT 1000`
    : `SELECT toStartOfInterval(timestamp, INTERVAL '1' MINUTE) AS bucket, SUM("sampleInterval" * double1) / SUM("sampleInterval") AS cpu, SUM("sampleInterval" * double2) / SUM("sampleInterval") AS memory, SUM("sampleInterval" * double3) / SUM("sampleInterval") AS load1, SUM("sampleInterval" * double4) / SUM("sampleInterval") AS disk, SUM("sampleInterval" * double5) / SUM("sampleInterval") AS rx_bps, SUM("sampleInterval" * double6) / SUM("sampleInterval") AS tx_bps, SUM("sampleInterval" * double7) / SUM("sampleInterval") AS uptime FROM events.analyticsEngine.cfmon_metrics WHERE index1 = $host AND timestamp >= NOW() - INTERVAL '${rangeHours}' HOUR GROUP BY bucket ORDER BY bucket DESC LIMIT ${rangeHours * 60}`;

  let rows: Record<string, unknown>[];
  try {
    const result = await env.ANALYTICS_SQL.query({
      query,
      ...(kind === "metrics" ? { params: { host: id ?? "" } } : {}),
    });
    rows = result.data;
  } catch (error) {
    console.error("Analytics SQL query failed", { kind, message: error instanceof Error ? error.message : String(error) });
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
