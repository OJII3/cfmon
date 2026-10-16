import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, SignJWT } from "jose";
import app, { type Env } from "../src/index";
import { digest, hex } from "../src/pairing";

const TEST_CLIENT_ID = "test-service-client-id.access";
const TEST_CLIENT_SECRET = "test-service-client-secret";

class MemoryRegistry {
  agents = new Map<string, { public_key: string; fingerprint: string; host: string; os: string; status: string; last_requested_at: number }>();
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
        if (sql.includes("INSERT INTO agents")) {
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

let agentTokenHex: string;
let agentFingerprint: string;
const registry = new MemoryRegistry();
const writeDataPoint = vi.fn();
const assetsFetch = vi.fn(async () => new Response("dashboard"));
const env = (): Env => ({
  METRICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
  ANALYTICS_SQL: { query: vi.fn(async ({ query }: { query: string }) => ({ data: query.includes("GROUP BY index1") ? [{ id: "bronya", hostname: "bronya", os: "linux", last_seen: "2026-10-07 12:00:00" }] : [] })) } as unknown as AnalyticsSQLBinding,
  REGISTRY: registry as unknown as D1Database,
  PAIR_RATE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
  ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
  ACCESS_CLIENT_ID: TEST_CLIENT_ID,
  ACCESS_CLIENT_SECRET: TEST_CLIENT_SECRET,
  DEVELOPMENT: "true",
});

async function generateAgentToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  agentTokenHex = hex(bytes);
  agentFingerprint = hex(await digest(bytes));
}

function agentRequest(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentTokenHex}`,
      ...(path === "/api/v1/ingest"
        ? {
            "CF-Access-Client-Id": TEST_CLIENT_ID,
            "CF-Access-Client-Secret": TEST_CLIENT_SECRET,
          }
        : {}),
      ...extraHeaders,
    },
    body: payload,
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); writeDataPoint.mockReset(); assetsFetch.mockClear(); });

describe("Worker auth and query", () => {
  it("redirects to the Cloudflare Access login page and rejects external return URLs", async () => {
    const localEnv = { ...env(), ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "audience" };
    const login = await app.fetch(new Request("https://cfmon.test/api/v1/auth/login?redirect_url=%2Fhosts%3Fview%3Dcpu"), localEnv);
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/login/cfmon.test?kid=audience&redirect_url=%2Fhosts%3Fview%3Dcpu");
    const unsafe = await app.fetch(new Request("https://cfmon.test/api/v1/auth/login?redirect_url=https%3A%2F%2Fevil.test"), localEnv);
    expect(unsafe.status).toBe(400);
  });

  it("keeps Analytics SQL failures generic for clients while logging diagnostics", async () => {
    const localEnv = env();
    vi.mocked(localEnv.ANALYTICS_SQL.query).mockRejectedValueOnce(new Error("dataset unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await app.fetch(new Request("http://localhost/api/v1/hosts"), localEnv);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unavailable" });
    expect(error).toHaveBeenCalledWith("Analytics SQL query failed", { kind: "hosts", message: "dataset unavailable" });
  });

  it("uses the Analytics SQL binding and fails closed without Access configuration", async () => {
    const localEnv = env();
    const query = vi.mocked(localEnv.ANALYTICS_SQL.query);
    const response = await app.fetch(new Request("http://localhost/api/v1/hosts"), localEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hosts: [{ id: "bronya", hostname: "bronya", os: "linux", last_seen: "2026-10-07T12:00:00.000Z" }] });
    expect(query.mock.calls[0][0].query).toContain("events.analyticsEngine.cfmon_metrics");
    expect(query.mock.calls[0][0].query).not.toContain("FORMAT JSON");
    const metricsResponse = await app.fetch(new Request("http://localhost/api/v1/hosts/bronya/metrics"), localEnv);
    expect(metricsResponse.status).toBe(200);
    expect(query.mock.calls[1][0].query).toContain('"sampleInterval"');
    expect(query.mock.calls[1][0].query).not.toContain("_sample_interval");
    expect(query.mock.calls[1][0].params).toEqual({ host: "bronya" });
    expect((await app.fetch(new Request("https://cfmon.test/api/v1/hosts"), env())).status).toBe(401);
  });

  it("pairs an agent token, requires approval before issuing Service Token, validates host, then supports revocation", async () => {
    await generateAgentToken();
    const localEnv = env();

    const pair = await app.fetch(agentRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv);
    expect(pair.status).toBe(202);
    const pairResult = await pair.json() as { status: string; fingerprint: string; access_client_id?: string; access_client_secret?: string };
    expect(pairResult.fingerprint).toBe(agentFingerprint);
    expect(pairResult.access_client_id).toBeUndefined();
    expect(pairResult.access_client_secret).toBeUndefined();

    const metrics = { host: "bronya", os: "linux", cpu: 0.3, memory: 0.7, load1: 1, disk: 0.5, rx_bps: 10, tx_bps: 20, uptime: 300 };
    expect((await app.fetch(agentRequest("/api/v1/ingest", metrics), localEnv)).status).toBe(403);

    const approval = new Request(`http://localhost/api/v1/agents/${agentFingerprint}/approve`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: pairResult.fingerprint }),
    });
    expect((await app.fetch(approval, localEnv)).status).toBe(200);

    const approvedPair = await app.fetch(agentRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv);
    expect(approvedPair.status).toBe(200);
    expect(await approvedPair.json()).toEqual({
      status: "approved",
      fingerprint: agentFingerprint,
      access_client_id: TEST_CLIENT_ID,
      access_client_secret: TEST_CLIENT_SECRET,
    });

    expect((await app.fetch(agentRequest("/api/v1/ingest", metrics), localEnv)).status).toBe(202);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect((await app.fetch(agentRequest("/api/v1/ingest", { ...metrics, host: "other" }), localEnv)).status).toBe(403);

    const approvedTokenHex = agentTokenHex;
    const approvedFingerprint = agentFingerprint;
    await generateAgentToken();
    const duplicatePair = await app.fetch(agentRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv);
    const duplicateFingerprint = (await duplicatePair.json() as { fingerprint: string }).fingerprint;
    expect(duplicatePair.status).toBe(202);
    const duplicateApproval = new Request(`http://localhost/api/v1/agents/${agentFingerprint}/approve`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: duplicateFingerprint }),
    });
    expect((await app.fetch(duplicateApproval, localEnv)).status).toBe(409);
    agentTokenHex = approvedTokenHex;
    agentFingerprint = approvedFingerprint;

    const revoke = new Request(`http://localhost/api/v1/agents/${agentFingerprint}/revoke`, {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: "{}",
    });
    expect((await app.fetch(revoke, localEnv)).status).toBe(200);
    expect((await app.fetch(agentRequest("/api/v1/ingest", metrics), localEnv)).status).toBe(403);
    expect((await app.fetch(agentRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv)).status).toBe(403);
  });

  it("rejects ingest without Service Token, with invalid Service Token, with invalid agent token, and cross-origin admin mutations", async () => {
    await generateAgentToken();
    const localEnv = env();
    const pair = await app.fetch(agentRequest("/api/v1/pair", { host: "bronya", os: "linux" }), localEnv);
    expect(pair.status).toBe(202);
    const approval = new Request(`http://localhost/api/v1/agents/${agentFingerprint}/approve`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: agentFingerprint }),
    });
    expect((await app.fetch(approval, localEnv)).status).toBe(200);

    const metrics = { host: "bronya", os: "linux", cpu: 0.3, memory: 0.7, load1: 1, disk: 0.5, rx_bps: 10, tx_bps: 20, uptime: 300 };
    const missingServiceToken = new Request("http://localhost/api/v1/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentTokenHex}`,
      },
      body: JSON.stringify(metrics),
    });
    expect((await app.fetch(missingServiceToken, localEnv)).status).toBe(401);

    const badServiceSecret = agentRequest("/api/v1/ingest", metrics, {
      "CF-Access-Client-Secret": "wrong-secret",
    });
    expect((await app.fetch(badServiceSecret, localEnv)).status).toBe(401);

    const badAgentToken = agentRequest("/api/v1/ingest", metrics, {
      Authorization: "Bearer invalid-token",
    });
    expect((await app.fetch(badAgentToken, localEnv)).status).toBe(401);

    expect((await app.fetch(new Request(`http://localhost/api/v1/agents/${agentFingerprint}/revoke`, {
      method: "POST",
      headers: { Origin: "https://evil.test" },
      body: "{}",
    }), localEnv)).status).toBe(403);
  });

  it("accepts a signed Access JWT and rejects a forged one or Service Token JWT on admin routes", async () => {
    const accessKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await exportJWK(accessKeys.publicKey);
    jwk.kid = "access-test";
    jwk.alg = "RS256";
    const token = await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS256", kid: "access-test" })
      .setIssuer("https://team.cloudflareaccess.com").setAudience("audience").setSubject("user-1")
      .setIssuedAt().setExpirationTime("5m").sign(accessKeys.privateKey);
    const serviceTokenJwt = await new SignJWT({ common_name: TEST_CLIENT_ID }).setProtectedHeader({ alg: "RS256", kid: "access-test" })
      .setIssuer("https://team.cloudflareaccess.com").setAudience("audience")
      .setIssuedAt().setExpirationTime("5m").sign(accessKeys.privateKey);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
    const localEnv = { ...env(), ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "audience" };
    const valid = await app.fetch(new Request("https://cfmon.test/api/v1/hosts", { headers: { "CF-Access-JWT-Assertion": token } }), localEnv);
    expect(valid.status).toBe(200);
    const serviceOnAdmin = await app.fetch(new Request("https://cfmon.test/api/v1/hosts", { headers: { "CF-Access-JWT-Assertion": serviceTokenJwt } }), localEnv);
    expect(serviceOnAdmin.status).toBe(401);
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
