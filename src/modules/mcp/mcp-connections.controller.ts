import { Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpOAuthService, OAuthError } from './mcp-oauth.service';
import { McpRateLimitService } from './mcp-rate-limit.service';
import { McpUsageService } from './mcp-usage.service';

/**
 * The signed-in person's connected AI tools, for Motvin's settings page:
 *
 *   GET    /api/mcp/connections        their connections, most recently used first
 *   GET    /api/mcp/connections/usage  their own usage: today vs the daily limit,
 *                                      calls per day this week, recent searches
 *   DELETE /api/mcp/connections/:id    disconnect one (takes effect immediately)
 *   DELETE /api/mcp/connections        disconnect every tool at once
 *   POST   /api/mcp/connections/forget disconnect every tool and erase their usage
 *                                      history, for when they delete their account
 *
 * Authenticated with the person's Firebase ID token (Authorization: Bearer),
 * the same sign-in the rest of motvin.com uses. Answers in the API's usual
 * `{ success, data }` wrapper.
 */
@Controller('mcp/connections')
export class McpConnectionsController {
  constructor(
    private readonly oauth: McpOAuthService,
    private readonly usage: McpUsageService,
    private readonly limits: McpRateLimitService,
  ) {}

  @Get()
  list(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const person = await this.oauth.identifyPerson(bearer(request));
      return reply.send({ success: true, data: this.oauth.listConnections(person.uid) });
    });
  }

  @Get('usage')
  myUsage(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const person = await this.oauth.identifyPerson(bearer(request));
      const today = this.limits.dailyStatus(person.uid);
      const mine = this.usage.personal(person.uid);
      return reply.send({
        success: true,
        data: {
          today: { used: today.used, limit: today.limit, resets_at: today.resetsAt ? new Date(today.resetsAt).toISOString() : null },
          days: mine.days,
          recent_searches: mine.searches,
        },
      });
    });
  }

  @Delete()
  removeAll(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const person = await this.oauth.identifyPerson(bearer(request));
      return reply.send({ success: true, data: { disconnected: this.oauth.disconnectAll(person.uid) } });
    });
  }

  @Post('forget')
  forget(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const person = await this.oauth.identifyPerson(bearer(request));
      const disconnected = this.oauth.disconnectAll(person.uid);
      this.usage.forget(person.uid);
      this.limits.forget(person.uid);
      return reply.code(200).send({ success: true, data: { disconnected } });
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    return this.respond(reply, async () => {
      const person = await this.oauth.identifyPerson(bearer(request));
      if (!this.oauth.disconnect(person.uid, id)) {
        return reply.code(404).send({ success: false, message: 'That connection was not found — it may already be disconnected.' });
      }
      return reply.send({ success: true, data: { id } });
    });
  }

  private async respond(reply: FastifyReply, run: () => Promise<unknown>) {
    if (!this.oauth.isConfigured) {
      return reply.code(503).send({ success: false, message: 'MCP is not configured on this server' });
    }
    try {
      return await run();
    } catch (error) {
      if (error instanceof OAuthError) return reply.code(error.status).send({ success: false, message: error.description });
      throw error;
    }
  }
}

function bearer(request: FastifyRequest): string {
  const header = request.headers['authorization'];
  return typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}
