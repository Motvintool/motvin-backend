import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthorizeQuery, McpOAuthService, OAuthError, TokenRequest } from './mcp-oauth.service';
import { McpRateLimitService, waitText } from './mcp-rate-limit.service';

/**
 * HTTP surface of the MCP authorization server: /api/mcp/oauth/*.
 *
 * Standard endpoints (register, authorize, token, revoke) answer in the shapes
 * OAuth clients expect — no `{success, data}` wrapper, and errors as
 * `{error, error_description}`. The two endpoints the connect page uses
 * (`request` and `approve`) follow the API's usual wrapper, as the web app's
 * other calls do.
 *
 * None of these need an account, so every request is rate-limited by the
 * caller's address; past the limit the answer is 429 with Retry-After.
 */
@Controller('mcp/oauth')
export class McpOAuthController {
  constructor(
    private readonly oauth: McpOAuthService,
    private readonly limits: McpRateLimitService,
  ) {}

  /** RFC 7591 dynamic client registration. */
  @Post('register')
  register(@Body() body: unknown, @Res() reply: FastifyReply) {
    return this.oauthResponse(reply, () => reply.code(201).send(this.oauth.registerClient(body)));
  }

  /** Sends the person to the connect page, or straight back to the client with an error. */
  @Get('authorize')
  authorize(@Query() query: AuthorizeQuery, @Res() reply: FastifyReply) {
    return this.oauthResponse(reply, async () => {
      const { redirectTo } = await this.oauth.beginAuthorization(query);
      return reply.code(302).header('Cache-Control', 'no-store').redirect(redirectTo);
    });
  }

  /** What the connect page shows: who is asking, and for what. */
  @Get('request')
  describe(@Query('request') request: string, @Res() reply: FastifyReply) {
    return this.oauthResponse(reply, () => reply.send({ success: true, data: this.oauth.describeRequest(request) }));
  }

  /** The person's decision, with their Firebase ID token when they allow. */
  @Post('approve')
  @HttpCode(200)
  approve(
    @Body() body: { request?: string; idToken?: string; decision?: 'allow' | 'deny' },
    @Res() reply: FastifyReply,
  ) {
    return this.oauthResponse(reply, async () => {
      const data = body?.decision === 'deny'
        ? this.oauth.deny(body?.request)
        : await this.oauth.approve(body?.request, body?.idToken);
      return reply.send({ success: true, data });
    });
  }

  @Post('token')
  @HttpCode(200)
  token(@Body() body: TokenRequest, @Res() reply: FastifyReply) {
    return this.oauthResponse(reply, () =>
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(this.oauth.token(body || {})),
    );
  }

  /** RFC 7009. Always 200: a token that is unknown or already dead needs nothing. */
  @Post('revoke')
  @HttpCode(200)
  revoke(@Body() body: { token?: string }, @Res() reply: FastifyReply) {
    return this.oauthResponse(reply, () => {
      this.oauth.revoke(body?.token);
      return reply.send({});
    });
  }

  private async oauthResponse(reply: FastifyReply, run: () => unknown | Promise<unknown>) {
    if (!this.oauth.isConfigured) {
      return reply.code(503).send({ error: 'temporarily_unavailable', error_description: 'MCP is not configured on this server' });
    }
    const limit = this.limits.takeOAuth(clientAddress(reply.request));
    if (!limit.ok) {
      return reply
        .code(429)
        .header('Retry-After', String(limit.retryAfter))
        .header('Cache-Control', 'no-store')
        .send({ error: 'too_many_requests', error_description: `Too many requests from this address. Try again ${waitText(limit.retryAfter)}.` });
    }
    try {
      return await run();
    } catch (error) {
      if (error instanceof OAuthError) {
        return reply.code(error.status).header('Cache-Control', 'no-store').send({ error: error.code, error_description: error.description });
      }
      throw error;
    }
  }
}

/**
 * The caller's address. Behind Cloudflare, CF-Connecting-IP is set by
 * Cloudflare itself and cannot be forged by the client, unlike the left end of
 * X-Forwarded-For; without it, Fastify's own view of the address is used.
 */
function clientAddress(request: FastifyRequest): string {
  const cloudflare = request.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare) return cloudflare;
  return request.ip || 'unknown';
}
