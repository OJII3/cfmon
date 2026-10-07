import { afterEach, describe, expect, it, vi } from "vitest";
import app, { type Env } from "../src/index";
import { quoteSqlLiteral } from "../src/query";

const writeDataPoint = vi.fn();
const assetsFetch = vi.fn(async () => new Response("dashboard"));
const env = (): Env => ({
  METRICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
  ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
  CF_ACCOUNT_ID: "account",
  CF_API_TOKEN: "cloudflare-token",
  INGEST_TOKEN: "ingest-secret",
  QUERY_TOKEN: "query-secret",
});
const payload = {
  host: "bronya",
  os: "linux",
  cpu: 0.32,
  memory: 0.71,
  load1: 1.42,
  disk: 0.51,
  rx_bps: 120340,
  tx_bps: 58321,
  uptime: 93211,
};
const request = (path: string, method = "GET", token = "query-secret", body?: unknown) => new Request(`https://cfmon.test${path}`, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writeDataPoint.mockReset();
  assetsFetch.mockClear();
});

describe("Worker routes", () => {
  it("ingests a validated payload into the configured Analytics Engine slots", async () => {
    const response = await app.fetch(request("/api/v1/ingest", "POST", "ingest-secret", payload), env());
    expect(response.status).toBe(202);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["bronya"],
      blobs: ["bronya", "linux"],
      doubles: [0.32, 0.71, 1.42, 0.51, 120340, 58321, 93211],
    });
  });

  it("rejects missing secrets, bad credentials, malformed and invalid payloads", async () => {
    expect((await app.fetch(request("/api/v1/ingest", "POST", "", payload), env())).status).toBe(401);
    expect((await app.fetch(request("/api/v1/hosts", "GET", "wrong-token"), env())).status).toBe(401);
    expect((await app.fetch(request("/api/v1/ingest", "POST", "ingest-secret", { ...payload, cpu: 1.1 }), env())).status).toBe(400);
    expect((await app.fetch(request("/api/v1/ingest", "POST", "ingest-secret", { ...payload, load1: Infinity }), env())).status).toBe(400);
    const missingSecretEnv = env();
    missingSecretEnv.INGEST_TOKEN = "";
    expect((await app.fetch(request("/api/v1/ingest", "POST", "ingest-secret", payload), missingSecretEnv)).status).toBe(503);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("rejects oversized ingest bodies", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 + 1));
        controller.close();
      },
    });
    const response = await app.fetch(new Request("https://cfmon.test/api/v1/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer ingest-secret" },
      body,
      // stream request requires duplex in Node's implementation
      duplex: "half",
    } as RequestInit), env());
    expect(response.status).toBe(413);
  });

  it("routes host queries and metrics queries through the Analytics Engine SQL API", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: [{ id: "bronya", hostname: "bronya", os: "linux", last_seen: "2026-10-07 12:00:00" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const hosts = await app.fetch(request("/api/v1/hosts"), env());
    expect(hosts.status).toBe(200);
    expect(await hosts.json()).toEqual({ hosts: [{ id: "bronya", hostname: "bronya", os: "linux", last_seen: "2026-10-07T12:00:00.000Z" }] });
    expect(fetchMock.mock.calls[0][0]).toContain("/accounts/account/analytics_engine/sql");

    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ bucket: "2026-10-07 12:00:00", cpu: 0.5, memory: 0.6, load1: 1, disk: 0.7, rx_bps: 10, tx_bps: 20, uptime: 100 }] }));
    const metrics = await app.fetch(request("/api/v1/hosts/bronya/metrics"), env());
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({ host: "bronya", metrics: [{ cpu: 0.5, timestamp: "2026-10-07T12:00:00.000Z" }] });
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain("SUM(_sample_interval * double1) / SUM(_sample_interval)");
  });

  it("escapes SQL literals and rejects host ids outside the hostname format", async () => {
    expect(quoteSqlLiteral("host' OR '1'='1")).toBe("'host'' OR ''1''=''1'");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.fetch(request(`/api/v1/hosts/${encodeURIComponent("host' OR '1'='1")}/metrics`), env());
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns safe errors on upstream failure and serves non-API paths from assets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream error", { status: 500 })));
    const failed = await app.fetch(request("/api/v1/hosts"), env());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "upstream_unavailable" });
    const staticResponse = await app.fetch(request("/"), env());
    expect(staticResponse.status).toBe(200);
    expect(assetsFetch).toHaveBeenCalledOnce();
  });
});
