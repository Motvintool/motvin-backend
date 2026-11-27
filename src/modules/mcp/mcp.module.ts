import { Module } from '@nestjs/common';
import { InspirationsModule } from '../inspirations/inspirations.module';
import { LibrarySearchService } from './library-search.service';
import { McpController } from './mcp.controller';
import { McpConnectionsController } from './mcp-connections.controller';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { McpRateLimitService } from './mcp-rate-limit.service';
import { McpUsageController } from './mcp-usage.controller';
import { McpUsageService } from './mcp-usage.service';
import { McpToolsService } from './mcp-tools.service';
import { McpWellKnownController } from './mcp-well-known.controller';
import { ScreenPreviewService } from './screen-preview.service';

/**
 * Motvin MCP: lets AI clients search the Inspirations library on behalf of a
 * signed-in Motvin user.
 *
 * - McpWellKnownController  discovery documents at /.well-known/*
 * - McpOAuthController      the authorization server at /api/mcp/oauth/*
 * - McpController           the MCP endpoint at /api/mcp
 * - McpConnectionsController a person's connected tools at /api/mcp/connections
 * - McpToolsService         the tools, built on InspirationsService
 * - LibrarySearchService    the searches the tools and the Figma plugin share
 * - ScreenPreviewService    small JPEG previews the AI can look at
 * - McpRateLimitService     per-person and per-address rate limits
 * - McpUsageService         daily usage counts; McpUsageController shows them to the admin
 */
@Module({
  imports: [InspirationsModule],
  controllers: [McpWellKnownController, McpOAuthController, McpConnectionsController, McpUsageController, McpController],
  providers: [McpOAuthService, McpToolsService, LibrarySearchService, ScreenPreviewService, McpRateLimitService, McpUsageService],
  exports: [McpOAuthService, LibrarySearchService, ScreenPreviewService, McpRateLimitService, McpUsageService],
})
export class McpModule {}
