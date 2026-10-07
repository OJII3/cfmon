import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, SignJWT } from "jose";
import app, { type Env } from "../src/index";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

class MemoryRegistry {
  agents = new Map<string, { public_key: string; fingerprint: string; host: string; os: string; status: string; last_requested_at: number }>();
  nonces = new Set<string>();
  prepare(sql: string) {
    let args: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => { args = values; return stmt; },
      first: async <T>() => {
        if (sql.includes("FROM agents WHERE public_key")) return this.agents.get(String(args[0])) as T ?? null;
        if (sql.includes("host = ? AND status")) return [...this.agents.values()].find((a) => a.host === args[0] && a.status === "approved" && a.public_key !== args[1]) as T ?? null;
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT INTO request_nonces")) {
          const nonce = `${args[0]}:${args[1]}`;
          if (this.nonces.has(nonce)) throw new Error("UNIQUE constraint failed: request_nonces.public_key, request_nonces.nonce");
          this.nonces.add(nonce);
        } else if (sql.includes("INSERT INTO agents")) {
          const [public_key, fingerprint, host, os, last_requested_at] = args as [string, string, string, string, number];
          this.agents.set(public_key, { public_key, fingerprint, host, os, status: "pending", last_requested_at });
        } else if (sql.includes("UPDATE agents SET status = 'approved'")) {
          const agent = this.agents.get(String(args[0]));
          if (agent) agent.status = "approved";
        } else if (sql.includes("UPDATE agents SET status = 'revoked'")) {
          const agent = this.agents.get(String(args[0]));
          if (agent?.status === "approved") agent.status = "revoked";
          return { meta: { changes: agent?.status === "revoked" ? 1 : 0 } };
        } else if (sql.includes("UPDATE agents SET last_requested_at")) {
          const agent = this.agents.get(String(args[1]));
          if (agent) agent.last_requested_at = Number(args[0]);
        }
        return { meta: { changes: 1 } };
      },
      all: async <T>() => ({ results: [...this.agents.values()].filter((a) => a.status !== "pending" || a.last_requested_at >= Number(args[0])).map((a) => ({ ...a })) as T[] }),
    };
    return stmt;
  }
  async batch() {}
}

let keyPair: CryptoKeyPair;
let publicKey: string;
const registry = new MemoryRegistry();
const writeDataPoint = vi.fn();
const assetsFetch = vi.fn(async () => new Response("dashboard"));
const env = (): Env => ({
  METRICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
  ANALYTICS_SQL: { query: vi.fn(async ({ query }: { query: string }) => ({ data: query.includes("GROUP BY index1") ? [{ id: "bronya", hostname: "bronya", os: "linux", last_seen: "2026-10-07 12:00:00" }] : [] })) } as unknown as AnalyticsSQLBinding,
  REGISTRY: registry as unknown as D1Database,
  PAIR_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
  ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
  DEVELOPMENT: "true",
});

async function signedRequest(path: string, body: unknown, nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 32), timestamp = String(Math.floor(Date.now() / 1000))) {
  const payload = JSON.stringify(body);
  const message = encoder.encode(`POST\n${path}\n${timestamp}\n${nonce}\n${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, message));
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cfmon-Key": publicKey, "X-Cfmon-Timestamp": timestamp, "X-Cfmon-Nonce": nonce, "X-Cfmon-Signature": hex(signature) },
    body: payload,
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); writeDataPoint.mockReset(); assetsFetch.mockClear(); });

describe("Worker auth and query", () => {
  it("uses the Analytics SQL binding and fails closed without Access configuration", async () => {
    const localEnv = env();
    const query = vi.mocked(localEnv.ANALYTICS_SQL.query);
    const response = await app.fetch(new Request("http://localhost/api/v1/hosts"), localEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hosts: [{ id: "bronya", hostname: "bronya", os: "linux", last_seen: "2026-10-07T12:00:00.000Z" }] });
    expect(query.mock.calls[0][0].query).toContain("events.analyticsEngine.cfmon_metrics");
    expect(query.mock.calls[0][0].query).not.toContain("FORMAT JSON");
    expect((await app.fetch(new Request("https://cfmon.test/api/v1/hosts"), env())).status).toBe(401);
  });

  it("pairs an Ed25519 key, requires approval, validates host and nonce, then supports revocation", async () => {
    keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    publicKey = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey) as ArrayBuffer));
    const localEnv = env();

    const pair = await app.fetch(await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv);
    expect(pair.status).toBe(202);
    const pairResult = await pair.json() as { fingerprint: string };
    expect(pairResult.fingerprint).toHaveLength(64);

    const replay = await app.fetch(await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }, "00000000000000000000000000000001"), localEnv);
    expect(replay.status).toBe(202);
    const duplicate = await app.fetch(await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }, "00000000000000000000000000000001"), localEnv);
    expect(duplicate.status).toBe(401);

    const metrics = { host: "bronya", os: "linux", cpu: 0.3, memory: 0.7, load1: 1, disk: 0.5, rx_bps: 10, tx_bps: 20, uptime: 300 };
    const nonceCount = registry.nonces.size;
    expect((await app.fetch(await signedRequest("/api/v1/ingest", metrics), localEnv)).status).toBe(403);
    expect(registry.nonces.size).toBe(nonceCount);
    const approval = new Request(`http://localhost/api/v1/agents/${publicKey}/approve`, { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint: pairResult.fingerprint }) });
    expect((await app.fetch(approval, localEnv)).status).toBe(200);
    expect((await app.fetch(await signedRequest("/api/v1/ingest", metrics), localEnv)).status).toBe(202);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect((await app.fetch(await signedRequest("/api/v1/ingest", { ...metrics, host: "other" }), localEnv)).status).toBe(403);

    const approvedPair = keyPair;
    const approvedPublicKey = publicKey;
    keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    publicKey = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey) as ArrayBuffer));
    const duplicatePair = await app.fetch(await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv);
    const duplicateFingerprint = (await duplicatePair.json() as { fingerprint: string }).fingerprint;
    expect(duplicatePair.status).toBe(202);
    const duplicateApproval = new Request(`http://localhost/api/v1/agents/${publicKey}/approve`, { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint: duplicateFingerprint }) });
    expect((await app.fetch(duplicateApproval, localEnv)).status).toBe(409);
    keyPair = approvedPair;
    publicKey = approvedPublicKey;

    const revoke = new Request(`http://localhost/api/v1/agents/${publicKey}/revoke`, { method: "POST", headers: { Origin: "http://localhost" }, body: "{}" });
    expect((await app.fetch(revoke, localEnv)).status).toBe(200);
    expect((await app.fetch(await signedRequest("/api/v1/ingest", metrics), localEnv)).status).toBe(403);
    expect((await app.fetch(await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv)).status).toBe(403);
  });

  it("rejects stale signed requests and cross-origin admin mutations", async () => {
    keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    publicKey = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey) as ArrayBuffer));
    const stale = await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }, "00000000000000000000000000000003", String(Math.floor(Date.now() / 1000) - 301));
    expect((await app.fetch(stale, env())).status).toBe(403);
    const original = await signedRequest("/api/v1/pair", { host: "bronya", os: "linux" }, "00000000000000000000000000000004");
    const tamperedBody = new Request(original.url, { method: "POST", headers: original.headers, body: JSON.stringify({ host: "other", os: "linux" }) });
    expect((await app.fetch(tamperedBody, env())).status).toBe(403);
    const wrongPath = new Request("http://localhost/api/v1/ingest", { method: "POST", headers: original.headers, body: "{}" });
    expect((await app.fetch(wrongPath, env())).status).toBe(403);
    expect((await app.fetch(new Request(`http://localhost/api/v1/agents/${publicKey}/revoke`, { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" }), env())).status).toBe(403);
  });

  it("accepts a signed Access JWT and rejects a forged one", async () => {
    const accessKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await exportJWK(accessKeys.publicKey);
    jwk.kid = "access-test";
    jwk.alg = "RS256";
    const token = await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS256", kid: "access-test" })
      .setIssuer("https://team.cloudflareaccess.com").setAudience("audience").setSubject("user-1")
      .setIssuedAt().setExpirationTime("5m").sign(accessKeys.privateKey);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
    const localEnv = { ...env(), ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "audience" };
    const valid = await app.fetch(new Request("https://cfmon.test/api/v1/hosts", { headers: { "CF-Access-JWT-Assertion": token } }), localEnv);
    expect(valid.status).toBe(200);
    const forged = await app.fetch(new Request("https://cfmon.test/api/v1/hosts", { headers: { "CF-Access-JWT-Assertion": `${token.slice(0, -3)}bad` } }), localEnv);
    expect(forged.status).toBe(401);
    const wrongAudience = await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS256", kid: "access-test" })
      .setIssuer("https://team.cloudflareaccess.com").setAudience("wrong-audience").setSubject("user-1")
      .setIssuedAt().setExpirationTime("5m").sign(accessKeys.privateKey);
    expect((await app.fetch(new Request("https://cfmon.test/api/v1/hosts", { headers: { "CF-Access-JWT-Assertion": wrongAudience } }), localEnv)).status).toBe(401);
    const expired = await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS256", kid: "access-test" })
      .setIssuer("https://team.cloudflareaccess.com").setAudience("audience").setSubject("user-1")
      .setIssuedAt().setExpirationTime("0s").sign(accessKeys.privateKey);
    expect((await app.fetch(new Request("https://cfmon.test/api/v1/hosts", { headers: { "CF-Access-JWT-Assertion": expired } }), localEnv)).status).toBe(401);
  });
});
