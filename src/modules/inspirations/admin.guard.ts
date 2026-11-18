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
import type { FastifyRequest } from 'fastify';
import { FirebaseIdTokenVerifier } from '../../common/firebase-id-token';

/**
 * Authorization for every write endpoint under /api/inspirations/admin.
 *
 * The browser hides the admin UI from anyone who is not the admin, but that is
 * presentation only — a hidden link is not access control. This guard is what
 * actually protects the store: it verifies the caller's Firebase ID token
 * against Google's public signing keys and checks the verified email against
 * the allowlist. Nothing writes without passing here.
 *
 * Token verification itself lives in FirebaseIdTokenVerifier, shared with the
 * MCP authorization server.
 */

export type AdminIdentity = { uid: string; email: string };

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly projectId: string;
  private readonly allowedEmails: string[];
  private readonly verifier: FirebaseIdTokenVerifier;

  constructor(private readonly configService: ConfigService) {
    this.projectId = this.configService.get<string>('firebase.projectId') || '';
    this.allowedEmails = this.configService.get<string[]>('admin.emails') || [];
    this.verifier = new FirebaseIdTokenVerifier(this.projectId);
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

    const claims = await this.verifier.verify(token);

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
}
