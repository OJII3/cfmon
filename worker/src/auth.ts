import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./index";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const encoder = new TextEncoder();

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

export async function requireServiceAccess(request: Request, env: Env): Promise<boolean> {
  const expectedClientId = env.ACCESS_CLIENT_ID?.trim();
  const expectedClientSecret = env.ACCESS_CLIENT_SECRET?.trim();
  const headerClientId = request.headers.get("cf-access-client-id");
  const headerClientSecret = request.headers.get("cf-access-client-secret");
  const hasHeaderCredentials = headerClientId !== null || headerClientSecret !== null;

  if (hasHeaderCredentials) {
    if (
      !expectedClientId || expectedClientId === "setup-pending" ||
      !expectedClientSecret || expectedClientSecret === "setup-pending" ||
      !headerClientId || !headerClientSecret
    ) {
      return false;
    }
    const [idOk, secretOk] = await Promise.all([
      timingSafeEqualText(headerClientId, expectedClientId),
      timingSafeEqualText(headerClientSecret, expectedClientSecret),
    ]);
    if (!idOk || !secretOk) return false;
  }

  const jwt = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (jwt) {
    if (
      !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD ||
      env.ACCESS_AUD === "setup-pending" ||
      !expectedClientId || expectedClientId === "setup-pending"
    ) {
      return false;
    }
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    try {
      let jwks = jwksByIssuer.get(issuer);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        jwksByIssuer.set(issuer, jwks);
      }
      const { payload } = await jwtVerify(jwt, jwks, {
        issuer,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
      });
      if (payload.common_name !== expectedClientId) return false;
    } catch {
      return false;
    }
  }

  return hasHeaderCredentials || Boolean(jwt);
}

export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

async function timingSafeEqualText(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = a.length ^ b.length;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}
