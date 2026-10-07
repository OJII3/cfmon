import { requireAccess } from "./auth";
import { handleAgentAdmin, handlePair, handleIngest, cleanupRegistry } from "./pairing";
import { handleQuery } from "./query";

export interface Env {
  METRICS: AnalyticsEngineDataset;
  ANALYTICS_SQL: AnalyticsSQLBinding;
  REGISTRY: D1Database;
  PAIR_RATE_LIMIT?: RateLimit;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEVELOPMENT?: string;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/pair") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return handlePair(request, env, json);
    }
    if (url.pathname === "/api/v1/ingest") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return handleIngest(request, env, json);
    }
    if (url.pathname === "/api/v1/agents") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (!await requireAccess(request, env)) return json({ error: "unauthorized" }, 401);
      return handleAgentAdmin(request, env, json, "list");
    }
    const agentMatch = url.pathname.match(/^\/api\/v1\/agents\/([0-9a-f]{64})\/(approve|revoke)$/);
    if (agentMatch) {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!await requireAccess(request, env)) return json({ error: "unauthorized" }, 401);
      return handleAgentAdmin(request, env, json, agentMatch[2] as "approve" | "revoke");
    }
    if (url.pathname === "/api/v1/hosts") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (!await requireAccess(request, env)) return json({ error: "unauthorized" }, 401);
      return handleQuery("hosts", request, env, json);
    }
    const metricMatch = url.pathname.match(/^\/api\/v1\/hosts\/([^/]+)\/metrics$/);
    if (metricMatch) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (!await requireAccess(request, env)) return json({ error: "unauthorized" }, 401);
      let id: string;
      try { id = decodeURIComponent(metricMatch[1]); }
      catch { return json({ error: "invalid_host_id" }, 400); }
      return handleQuery("metrics", request, env, json, id);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupRegistry(env);
  },
};

export { json };
