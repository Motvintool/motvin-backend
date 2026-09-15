import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AdminGuard, type AdminIdentity } from './admin.guard';
import { InspirationsAdminService } from './inspirations-admin.service';

/**
 * Write API for the Inspirations store, used by /inspirations/admin in the web
 * app.
 *
 * Every route is behind AdminGuard, which verifies the caller's Firebase ID
 * token and checks the email against the allowlist. The UI hiding the admin
 * link is a convenience; this guard is the actual control.
 *
 * Images arrive as raw bodies rather than multipart form data, which keeps the
 * backend free of an upload dependency. The filename travels in the path, so
 * it is validated like any other path segment.
 */
@Controller('inspirations/admin')
@UseGuards(AdminGuard)
export class InspirationsAdminController {
  constructor(private readonly admin: InspirationsAdminService) {}

  /** Confirms the caller is an admin, and says which account they are. */
  @Get('session')
  session(@Req() request: FastifyRequest & { admin?: AdminIdentity }) {
    return { success: true, data: { admin: request.admin } };
  }

  /** Everything the admin UI renders, including files held back by the gate. */
  @Get('state')
  state() {
    return { success: true, data: this.admin.getState() };
  }

  @Post('rebuild')
  rebuild() {
    return { success: true, data: this.admin.rebuild() };
  }

  // ─── Screens ──────────────────────────────────────────────────────────────

  @Post('screens/:platform/:app/:file')
  uploadScreen(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('file') file: string,
    @Query('overwrite') overwrite: string,
    @Req() request: FastifyRequest,
  ) {
    const body = request.body as Buffer;
    return {
      success: true,
      data: this.admin.uploadScreen(platform, app, file, body, overwrite === '1'),
    };
  }

  @Put('screens/:platform/:app/:file/meta')
  saveScreenMeta(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('file') file: string,
    @Body() meta: unknown,
  ) {
    return { success: true, data: this.admin.saveScreenMeta(platform, app, file, meta) };
  }

  @Delete('screens/:platform/:app/:file')
  deleteScreen(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('file') file: string,
  ) {
    return { success: true, data: this.admin.deleteScreen(platform, app, file) };
  }

  // ─── Logos ────────────────────────────────────────────────────────────────

  @Post('logos/:app/:file')
  uploadLogo(
    @Param('app') app: string,
    @Param('file') file: string,
    @Req() request: FastifyRequest,
  ) {
    return { success: true, data: this.admin.uploadLogo(app, file, request.body as Buffer) };
  }

  // ─── Apps ─────────────────────────────────────────────────────────────────

  @Put('apps/:app')
  saveApp(@Param('app') app: string, @Body() body: Record<string, unknown>) {
    return { success: true, data: this.admin.saveApp({ ...body, id: app }) };
  }

  @Delete('apps/:app')
  deleteApp(@Param('app') app: string) {
    return { success: true, data: this.admin.deleteApp(app) };
  }

  // ─── Licensing ────────────────────────────────────────────────────────────

  @Put('sources/:app')
  saveSource(@Param('app') app: string, @Body() body: unknown) {
    return { success: true, data: this.admin.saveSource(app, body) };
  }

  // ─── Flows ────────────────────────────────────────────────────────────────

  @Put('flows/:flow')
  saveFlow(@Param('flow') flow: string, @Body() body: Record<string, unknown>) {
    return { success: true, data: this.admin.saveFlow({ ...body, id: flow }) };
  }

  @Delete('flows/:flow')
  deleteFlow(@Param('flow') flow: string) {
    return { success: true, data: this.admin.deleteFlow(flow) };
  }
}
