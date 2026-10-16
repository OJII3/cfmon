import type { Env } from "./index";
import { isValidHostId } from "./ingest";
import { localBypass, requireServiceAccess, sameOrigin } from "./auth";

const MAX_BODY_BYTES = 16 * 1024;
const PENDING_TTL = 900;

type VerifiedAgentRequest = { publicKey: string; fingerprint: string; body: Uint8Array };
type JsonResponse = (data: unknown, status?: number) => Response;

export async function digest(bytes: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string, length: number): Uint8Array | null {
  if (text.length !== length * 2 || !/^[0-9a-f]+$/.test(text)) return null;
  return Uint8Array.from(text.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

async function readBody(request: Request): Promise<Uint8Array | null> {
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
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function extractAgentTokenHex(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return (request.headers.get("x-cfmon-token") ?? "").trim();
}

export async function verifyAgentRequest(request: Request): Promise<VerifiedAgentRequest | null> {
  const tokenHex = extractAgentTokenHex(request);
  const rawToken = fromHex(tokenHex, 32);
  if (!rawToken) return null;
  const body = await readBody(request);
  if (!body) return null;
  const fingerprint = hex(await digest(rawToken));
  return { publicKey: fingerprint, fingerprint, body };
}

function parseBody(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function approvedResponse(env: Env, fingerprint: string, json: JsonResponse): Response {
  const clientId = env.ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.ACCESS_CLIENT_SECRET?.trim();
  if (!clientId || clientId === "setup-pending" || !clientSecret || clientSecret === "setup-pending") {
    return json({ error: "service_unavailable" }, 503);
  }
  return json({
    status: "approved",
    fingerprint,
    access_client_id: clientId,
    access_client_secret: clientSecret,
  }, 200);
}

export async function handlePair(request: Request, env: Env, json: JsonResponse): Promise<Response> {
  if (!env.REGISTRY) return json({ error: "service_unavailable" }, 503);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (env.PAIR_RATE_LIMIT) {
    const outcome = await env.PAIR_RATE_LIMIT.limit({ key: ip });
    if (!outcome.success) return json({ error: "rate_limited" }, 429);
  } else if (!localBypass(request, env)) return json({ error: "service_unavailable" }, 503);
  const verified = await verifyAgentRequest(request);
  if (!verified) return json({ error: "invalid_token" }, 401);
  const body = parseBody(verified.body);
  if (!body || typeof body.host !== "string" || !isValidHostId(body.host) || typeof body.os !== "string" || body.os.length > 128) {
    return json({ error: "invalid_payload" }, 400);
  }
  const current = await env.REGISTRY.prepare("SELECT host, status FROM agents WHERE public_key = ?").bind(verified.publicKey).first<{ host: string; status: string }>();
  if (current?.status === "revoked") return json({ status: "revoked", fingerprint: verified.fingerprint }, 403);
  if (current?.status === "approved") {
    if (current.host !== body.host) return json({ error: "host_mismatch" }, 403);
    await env.REGISTRY.prepare("UPDATE agents SET last_requested_at = ? WHERE public_key = ? AND status = 'approved' AND host = ?").bind(Math.floor(Date.now() / 1000), verified.publicKey, body.host).run();
    const latest = await env.REGISTRY.prepare("SELECT host, status FROM agents WHERE public_key = ?").bind(verified.publicKey).first<{ host: string; status: string }>();
    if (latest?.status === "revoked") return json({ status: "revoked", fingerprint: verified.fingerprint }, 403);
    if (latest?.status !== "approved" || latest.host !== body.host) return json({ error: "host_mismatch" }, 403);
    return approvedResponse(env, verified.fingerprint, json);
  }
  await env.REGISTRY.prepare(`INSERT INTO agents (public_key, fingerprint, host, os, status, last_requested_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(public_key) DO UPDATE SET fingerprint = excluded.fingerprint, host = excluded.host, os = excluded.os, status = 'pending', last_requested_at = excluded.last_requested_at
    WHERE agents.status = 'pending'`)
    .bind(verified.publicKey, verified.fingerprint, body.host, body.os, Math.floor(Date.now() / 1000)).run();
  const latest = await env.REGISTRY.prepare("SELECT host, status FROM agents WHERE public_key = ?").bind(verified.publicKey).first<{ host: string; status: string }>();
  if (latest?.status === "revoked") return json({ status: "revoked", fingerprint: verified.fingerprint }, 403);
  if (latest?.status === "approved") {
    if (latest.host !== body.host) return json({ error: "host_mismatch" }, 403);
    return approvedResponse(env, verified.fingerprint, json);
  }
  if (latest?.status !== "pending") return json({ error: "service_unavailable" }, 503);
  return json({ status: "pending", fingerprint: verified.fingerprint }, 202);
}

export async function handleIngest(request: Request, env: Env, json: JsonResponse): Promise<Response> {
  if (!env.REGISTRY || !env.METRICS) return json({ error: "service_unavailable" }, 503);
  if (!await requireServiceAccess(request, env)) return json({ error: "unauthorized" }, 401);
  const verified = await verifyAgentRequest(request);
  if (!verified) return json({ error: "invalid_token" }, 401);
  const body = parseBody(verified.body);
  if (!body || typeof body.host !== "string" || !isValidHostId(body.host)) return json({ error: "invalid_payload" }, 400);
  const agent = await env.REGISTRY.prepare("SELECT host, status FROM agents WHERE public_key = ?").bind(verified.publicKey).first<{ host: string; status: string }>();
  if (!agent || agent.status !== "approved" || agent.host !== body.host) return json({ error: "forbidden" }, 403);
  const requiredNumbers = ["cpu", "memory", "load1", "disk", "rx_bps", "tx_bps", "uptime"] as const;
  if (body.os !== undefined && (typeof body.os !== "string" || body.os.length > 128)) return json({ error: "invalid_payload" }, 400);
  if (!requiredNumbers.every((key) => typeof body[key] === "number" && Number.isFinite(body[key]) && (key === "cpu" || key === "memory" || key === "disk" ? Number(body[key]) >= 0 && Number(body[key]) <= 1 : Number(body[key]) >= 0))) {
    return json({ error: "invalid_payload" }, 400);
  }
  const gpuNumbers = ["gpu_utilization", "gpu_memory"] as const;
  if (!gpuNumbers.every((key) => body[key] === undefined || (typeof body[key] === "number" && Number.isFinite(body[key]) && (Number(body[key]) === -1 || (Number(body[key]) >= 0 && Number(body[key]) <= 1))))) {
    return json({ error: "invalid_payload" }, 400);
  }
  const [cpu, memory, load1, disk, rx, tx, uptime] = requiredNumbers.map((key) => Number(body[key]));
  const [gpuUtilization, gpuMemory] = gpuNumbers.map((key) => body[key] === undefined ? -1 : Number(body[key]));
  try {
    env.METRICS.writeDataPoint({ indexes: [body.host], blobs: [body.host, typeof body.os === "string" ? body.os : ""], doubles: [cpu, memory, load1, disk, rx, tx, uptime, gpuUtilization, gpuMemory] });
  } catch { return json({ error: "upstream_unavailable" }, 502); }
  await env.REGISTRY.prepare("UPDATE agents SET last_requested_at = ? WHERE public_key = ?").bind(Math.floor(Date.now() / 1000), verified.publicKey).run();
  return json({ ok: true }, 202);
}

export async function handleAgentAdmin(request: Request, env: Env, json: JsonResponse, action: "list" | "approve" | "revoke"): Promise<Response> {
  if (!env.REGISTRY) return json({ error: "service_unavailable" }, 503);
  if (action !== "list" && !sameOrigin(request)) return json({ error: "invalid_origin" }, 403);
  if (action === "list") {
    const { results } = await env.REGISTRY.prepare("SELECT public_key, host, os, status, fingerprint, last_requested_at FROM agents WHERE status = 'approved' OR (status = 'pending' AND last_requested_at >= ?) OR (status = 'revoked' AND last_requested_at >= ?) ORDER BY last_requested_at DESC")
      .bind(Math.floor(Date.now() / 1000) - PENDING_TTL, Math.floor(Date.now() / 1000) - 86400).all<Record<string, unknown>>();
    return json({ agents: (results ?? []).map((row) => ({ ...row, last_requested_at: new Date(Number(row.last_requested_at) * 1000).toISOString() })) });
  }
  const match = new URL(request.url).pathname.match(/^\/api\/v1\/agents\/([0-9a-f]{64})\/(approve|revoke)$/);
  if (!match) return json({ error: "not_found" }, 404);
  const key = match[1];
  if (action === "approve") {
    const bodyBytes = await readBody(request);
    if (!bodyBytes) return json({ error: "payload_too_large" }, 413);
    const body = parseBody(bodyBytes);
    if (!body || !/^[0-9a-f]{64}$/.test(String(body.fingerprint ?? ""))) return json({ error: "invalid_fingerprint" }, 400);
    const row = await env.REGISTRY.prepare("SELECT host, status, fingerprint, last_requested_at FROM agents WHERE public_key = ?").bind(key).first<{ host: string; status: string; fingerprint: string; last_requested_at: number }>();
    if (!row || row.status !== "pending" || row.fingerprint !== body.fingerprint || row.last_requested_at < Math.floor(Date.now() / 1000) - PENDING_TTL) return json({ error: "pending_agent_not_found" }, 404);
    const conflict = await env.REGISTRY.prepare("SELECT public_key FROM agents WHERE host = ? AND status = 'approved' AND public_key != ?").bind(row.host, key).first();
    if (conflict) return json({ error: "host_already_approved" }, 409);
    try {
      const result = await env.REGISTRY.prepare("UPDATE agents SET status = 'approved' WHERE public_key = ? AND status = 'pending' AND fingerprint = ? AND last_requested_at >= ?")
        .bind(key, body.fingerprint, Math.floor(Date.now() / 1000) - PENDING_TTL).run();
      if (!result.meta.changes) return json({ error: "pending_agent_not_found" }, 404);
    } catch {
      return json({ error: "host_already_approved" }, 409);
    }
    return json({ ok: true });
  }
  const revokeBytes = await readBody(request);
  if (!revokeBytes) return json({ error: "payload_too_large" }, 413);
  const revokeBody = parseBody(revokeBytes);
  if (!revokeBody || typeof revokeBody !== "object" || Array.isArray(revokeBody) || Object.keys(revokeBody).length !== 0) {
    return json({ error: "invalid_payload" }, 400);
  }
  const result = await env.REGISTRY.prepare("UPDATE agents SET status = 'revoked' WHERE public_key = ? AND status = 'approved'").bind(key).run();
  if (!result.meta.changes) return json({ error: "agent_not_found" }, 404);
  return json({ ok: true });
}

export async function cleanupRegistry(env: Env): Promise<void> {
  if (!env.REGISTRY) return;
  const now = Math.floor(Date.now() / 1000);
  await env.REGISTRY.prepare("DELETE FROM agents WHERE status = 'pending' AND last_requested_at < ?").bind(now - PENDING_TTL).run();
}
