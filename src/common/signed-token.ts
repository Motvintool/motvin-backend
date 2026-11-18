import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Compact signed tokens (HS256 JWTs) for things this server both issues and
 * later reads back: MCP access and refresh tokens, authorization codes, and
 * the registered-client records that stand in for a client database.
 *
 * Hand-rolled on node:crypto rather than a JWT library because nothing here
 * needs key rotation, asymmetric keys or JWKS — one server-side secret signs
 * and verifies everything, and the payload is a flat JSON object.
 */

export interface SignedClaims {
  /** Issued-at, seconds since the epoch. Filled in by `signToken`. */
  iat: number;
  /** Expiry, seconds since the epoch. Filled in by `signToken`. */
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function hmac(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

/** Signs `claims` with `secret`, valid for `ttlSeconds` from now. */
export function signToken(claims: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds })).toString('base64url');
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${hmac(secret, signingInput).toString('base64url')}`;
}

/**
 * Verifies signature and expiry. Returns the claims, or null for anything
 * that is not a token this server signed and that is still valid — the caller
 * never learns why, which is the right amount of detail for an outsider.
 */
export function verifyToken<T extends Record<string, unknown>>(token: string, secret: string): (T & SignedClaims) | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;

  const expected = hmac(secret, `${parts[0]}.${parts[1]}`);
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let claims: T & SignedClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}
