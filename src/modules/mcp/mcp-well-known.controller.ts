import { Controller, Get, Header } from '@nestjs/common';
import { McpOAuthService } from './mcp-oauth.service';

/**
 * Discovery documents, served at the origin root (main.ts excludes
 * `.well-known` from the /api prefix). An MCP client that gets a 401 from
 * /api/mcp reads the protected-resource document to find the authorization
 * server, then that server's metadata to find the endpoints. Both the plain
 * and the path-suffixed forms are served because clients differ in which
 * they try first.
 */
@Controller('.well-known')
export class McpWellKnownController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Get('oauth-authorization-server')
  @Header('Cache-Control', 'public, max-age=3600')
  authorizationServer() {
    return this.oauth.authorizationServerMetadata();
  }

  @Get('oauth-authorization-server/api/mcp')
  @Header('Cache-Control', 'public, max-age=3600')
  authorizationServerForResource() {
    return this.oauth.authorizationServerMetadata();
  }

  /** Some clients probe OpenID discovery first; the same document satisfies them. */
  @Get('openid-configuration')
  @Header('Cache-Control', 'public, max-age=3600')
  openid() {
    return this.oauth.authorizationServerMetadata();
  }

  @Get('oauth-protected-resource')
  @Header('Cache-Control', 'public, max-age=3600')
  protectedResource() {
    return this.oauth.protectedResourceMetadata();
  }

  @Get('oauth-protected-resource/api/mcp')
  @Header('Cache-Control', 'public, max-age=3600')
  protectedResourceForMcp() {
    return this.oauth.protectedResourceMetadata();
  }
}
