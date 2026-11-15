import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, createVerify } from 'crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Authorization for every write endpoint under /api/inspirations/admin.
 *
 * The browser hides the admin UI from anyone who is not the admin, but that is
 * presentation only — a hidden link is not access control. This guard is what
 * actually protects the store: it verifies the caller's Firebase ID token
 * against Google's public signing keys and checks the verified email against
 * the allowlist. Nothing writes without passing here.
 *
 * Verification is done directly rather than through firebase-admin so the
 * backend needs no service-account credentials: ID tokens are RS256 JWTs whose
 * signing certificates Google publishes.
 */

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** Clock skew tolerated on exp/iat, in seconds. */
const SKEW = 60;

type Claims = {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
  firebase?: { sign_in_provider?: string };
};

export type AdminIdentity = { uid: string; email: string };

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly projectId: string;
  private readonly allowedEmails: string[];

  private certs: Record<string, string> = {};
  private certsExpireAt = 0;
  private certsInFlight: Promise<void> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.projectId = this.configService.get<string>('firebase.projectId') || '';
    this.allowedEmails = this.configService.get<string[]>('admin.emails') || [];
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (!this.projectId) {
      this.logger.error('FIREBASE_PROJECT_ID is not set — refusing every admin request');
      throw new ServiceUnavailableException('Admin API is not configured');
    }
    if (this.allowedEmails.length === 0) {
      this.logger.error('INSPIRATIONS_ADMIN_EMAILS is empty — refusing every admin request');
      throw new ServiceUnavailableException('Admin API is not configured');
    }

    const header = request.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : '';
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const claims = await this.verify(token);

    const email = (claims.email || '').toLowerCase();
    if (!email) throw new ForbiddenException('Token carries no email');
    if (!claims.email_verified) throw new ForbiddenException('Email address is not verified');
    if (!this.allowedEmails.includes(email)) {
      this.logger.warn(`Admin request refused for ${email}`);
      throw new ForbiddenException('This account may not administer the library');
    }

    (request as FastifyRequest & { admin?: AdminIdentity }).admin = { uid: claims.sub, email };
    return true;
  }

  /** Full RS256 + claim verification. Any failure denies the request. */
  private async verify(token: string): Promise<Claims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed token');

    let header: { alg?: string; kid?: string };
    let claims: Claims;
    try {
      header = JSON.parse(base64UrlDecode(parts[0]).toString('utf-8'));
      claims = JSON.parse(base64UrlDecode(parts[1]).toString('utf-8'));
    } catch {
      throw new UnauthorizedException('Malformed token');
    }

    if (header.alg !== 'RS256') throw new UnauthorizedException('Unexpected token algorithm');
    if (!header.kid) throw new UnauthorizedException('Token has no key id');

    const cert = await this.certFor(header.kid);
    if (!cert) throw new UnauthorizedException('Unknown token signing key');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();

    let publicKey;
    try {
      publicKey = createPublicKey(cert);
    } catch {
      throw new ServiceUnavailableException('Could not read Google signing certificate');
    }
    if (!verifier.verify(publicKey, base64UrlDecode(parts[2]))) {
      throw new UnauthorizedException('Token signature is invalid');
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== this.projectId) throw new UnauthorizedException('Token is for another project');
    if (claims.iss !== `https://securetoken.google.com/${this.projectId}`) {
      throw new UnauthorizedException('Token issuer is not Firebase');
    }
    if (!claims.sub) throw new UnauthorizedException('Token has no subject');
    if (claims.exp <= now - SKEW) throw new UnauthorizedException('Token has expired');
    if (claims.iat > now + SKEW) throw new UnauthorizedException('Token is not valid yet');

    return claims;
  }

  /**
   * Google's signing certificates, cached until the response says they expire.
   * Concurrent misses share one fetch.
   */
  private async certFor(kid: string): Promise<string | null> {
    if (this.certs[kid] && Date.now() < this.certsExpireAt) return this.certs[kid];

    if (!this.certsInFlight) {
      this.certsInFlight = this.fetchCerts().finally(() => {
        this.certsInFlight = null;
      });
    }
    await this.certsInFlight;
    return this.certs[kid] || null;
  }

  private async fetchCerts(): Promise<void> {
    try {
      const res = await fetch(CERT_URL);
      if (!res.ok) throw new Error(`status ${res.status}`);
      this.certs = (await res.json()) as Record<string, string>;

      const cacheControl = res.headers.get('cache-control') || '';
      const maxAge = /max-age=(\d+)/.exec(cacheControl);
      const ttl = maxAge ? Number(maxAge[1]) * 1000 : 60 * 60 * 1000;
      this.certsExpireAt = Date.now() + ttl;
    } catch (error) {
      // Fail closed: without keys nothing can be verified, so nothing is let in.
      this.certs = {};
      this.certsExpireAt = 0;
      this.logger.error(`Could not fetch Google signing keys: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Cannot verify sign-in right now');
    }
  }
}
