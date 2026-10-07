import type { Env } from "./index";

const MAX_BODY_BYTES = 16 * 1024;
const requiredNumbers = ["cpu", "memory", "load1", "disk", "rx_bps", "tx_bps", "uptime"] as const;
type MetricKey = (typeof requiredNumbers)[number];
type Payload = { host: string; os?: string } & Record<MetricKey, number>;

export function isValidHostId(host: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(host);
}

function validPayload(value: unknown): value is Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.host !== "string" || !isValidHostId(body.host)) return false;
  if (body.os !== undefined && (typeof body.os !== "string" || body.os.length > 128)) return false;
  return requiredNumbers.every((key) => {
    const n = body[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 &&
      (key === "cpu" || key === "memory" || key === "disk" ? n <= 1 : true);
  });
}

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handleIngest(
  request: Request,
  env: Env,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  if (!env.INGEST_TOKEN) return json({ error: "service_unavailable" }, 503);
  if (request.headers.get("authorization") !== `Bearer ${env.INGEST_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const bytes = await readLimitedBody(request);
  if (!bytes) return json({ error: "payload_too_large" }, 413);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!validPayload(value)) return json({ error: "invalid_payload" }, 400);

  const body = value;
  try {
    env.METRICS.writeDataPoint({
      indexes: [body.host],
      blobs: [body.host, body.os ?? ""],
      doubles: [body.cpu, body.memory, body.load1, body.disk, body.rx_bps, body.tx_bps, body.uptime],
    });
  } catch {
    return json({ error: "upstream_unavailable" }, 502);
  }
  return json({ ok: true }, 202);
}
