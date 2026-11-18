import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../inspirations/admin.guard';
import { McpOAuthService } from './mcp-oauth.service';
import { McpUsageService } from './mcp-usage.service';

/**
 * GET /api/mcp/usage?days=30 — how Motvin MCP is used, for the admin's MCP
 * usage tab. Admin only: behind the same AdminGuard as the library admin API
 * (Firebase ID token plus the admin email list).
 */
@Controller('mcp/usage')
@UseGuards(AdminGuard)
export class McpUsageController {
  constructor(
    private readonly usage: McpUsageService,
    private readonly oauth: McpOAuthService,
  ) {}

  @Get()
  report(@Query('days') days?: string) {
    return { success: true, data: this.usage.report(Number(days) || 30, this.oauth.connections.all().length) };
  }
}
