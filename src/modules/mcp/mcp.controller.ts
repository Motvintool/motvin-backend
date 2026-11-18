import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpOAuthService } from './mcp-oauth.service';
import { McpToolsService } from './mcp-tools.service';

/**
 * The MCP endpoint: POST /api/mcp, Streamable HTTP transport.
 *
 * Stateless by design — every request gets a fresh server and transport, and
 * the reply is plain JSON rather than an SSE stream. Nothing a tool does takes
 * long enough to need progress events, and statelessness means any number of
 * API instances can answer without sharing sessions. A client that opens the
 * optional GET stream is told it is not offered (405), which the spec allows.
 *
 * Access needs a bearer token from the OAuth server in this module. A missing
 * or bad token gets a 401 whose WWW-Authenticate header points at the
 * protected-resource metadata, which is how a client finds out where to sign
 * in.
 */

/** Request headers that describe the Node connection, not the message, and must not be copied onto the Web Request. */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect']);

@Controller('mcp')
export class McpController {
  constructor(
    private readonly oauth: McpOAuthService,
    private readonly tools: McpToolsService,
  ) {}

  @Post()
  async handle(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (!this.oauth.isConfigured) {
      return reply.code(503).send({ error: 'temporarily_unavailable', error_description: 'MCP is not configured on this server' });
    }

    const header = request.headers['authorization'];
    const token = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    const identity = token ? this.oauth.verifyAccessToken(token) : null;
    if (!identity) return this.challenge(reply, token ? 'invalid_token' : undefined);

    const server = this.tools.createServer(identity);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(this.toWebRequest(request), {
        authInfo: {
          token,
          clientId: identity.clientId,
          scopes: identity.scopes,
          extra: { uid: identity.uid, email: identity.email },
        },
        parsedBody: request.body,
      });
      const text = await response.text();
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(text.length ? text : undefined);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  /** No standalone server-to-client stream in stateless mode. */
  @Get()
  stream(@Res() reply: FastifyReply) {
    return this.notAllowed(reply);
  }

  /** No sessions, so nothing to end. */
  @Delete()
  end(@Res() reply: FastifyReply) {
    return this.notAllowed(reply);
  }

  private notAllowed(reply: FastifyReply) {
    return reply
      .code(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }

  private challenge(reply: FastifyReply, error?: string) {
    const metadata = `${this.oauth.issuer}/.well-known/oauth-protected-resource/api/mcp`;
    const parts = [`Bearer realm="Motvin"`, `resource_metadata="${metadata}"`];
    if (error) parts.push(`error="${error}"`);
    return reply
      .code(401)
      .header('WWW-Authenticate', parts.join(', '))
      .send({ error: error ?? 'unauthorized', error_description: 'Sign in to Motvin to use this MCP server' });
  }

  /** Fastify's request, re-expressed as the Web Request the transport consumes. */
  private toWebRequest(request: FastifyRequest): Request {
    const url = new URL(request.url, this.oauth.issuer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (HOP_HEADERS.has(key)) continue;
      if (Array.isArray(value)) headers.set(key, value.join(', '));
      else if (typeof value === 'string') headers.set(key, value);
    }
    const body = request.body == null ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    return new Request(url, { method: 'POST', headers, body });
  }
}
