import { handleIngest } from "./ingest";
import { handleQuery } from "./query";

export interface Env {
  METRICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  INGEST_TOKEN?: string;
  QUERY_TOKEN?: string;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/ingest") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return handleIngest(request, env, json);
    }
    if (url.pathname === "/api/v1/hosts") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return handleQuery("hosts", request, env, json);
    }
    const metricMatch = url.pathname.match(/^\/api\/v1\/hosts\/([^/]+)\/metrics$/);
    if (metricMatch) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      let id: string;
      try {
        id = decodeURIComponent(metricMatch[1]);
      } catch {
        return json({ error: "invalid_host_id" }, 400);
      }
      return handleQuery("metrics", request, env, json, id);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

export { json };
