import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./index";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function localBypass(request: Request, env: Env): boolean {
  if (env.DEVELOPMENT !== "true") return false;
  const url = new URL(request.url);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export async function requireAccess(request: Request, env: Env): Promise<boolean> {
  if (localBypass(request, env)) return true;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const authorization = request.headers.get("cf-access-jwt-assertion")
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!authorization) return false;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  try {
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksByIssuer.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(authorization, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "email"],
    });
    return typeof payload.email === "string" && payload.email.length > 0;
  } catch {
    return false;
  }
}

export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}
