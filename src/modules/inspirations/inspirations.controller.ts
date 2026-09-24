import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { extname } from 'path';
import { InspirationsService } from './inspirations.service';
import { LoaderService } from './loader.service';

/**
 * Read-only API over data/inspirations.
 *
 * Image routes stream files that the manifest lists. A path that is not
 * published — including anything with traversal in it — simply misses the
 * allow-list and 404s.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(',').map((v) => v.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

@Controller('inspirations')
export class InspirationsController {
  constructor(
    private readonly service: InspirationsService,
    private readonly loader: LoaderService,
  ) {}

  // GET /api/inspirations/meta — counts + taxonomy, for tabs and filters
  @Get('meta')
  async getMeta() {
    return { success: true, data: await this.service.getCounts() };
  }

  // GET /api/inspirations/screens
  @Get('screens')
  async getScreens(
    @Query('platform') platform?: string,
    @Query('type') type?: string,
    @Query('state') state?: string,
    @Query('industry') industry?: string,
    @Query('style') style?: string,
    @Query('element') element?: string,
    @Query('app') app?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: 'newest' | 'oldest' | 'app' | 'curated',
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    const data = await this.service.getScreens({
      platform: splitList(platform),
      screenType: splitList(type),
      state: splitList(state),
      industry: splitList(industry),
      style: splitList(style),
      element: splitList(element),
      app,
      q,
      sort,
      limit,
      offset,
    });
    return { success: true, data };
  }

  // GET /api/inspirations/screen/:id
  @Get('screen/:id')
  async getScreen(@Param('id') id: string) {
    const data = await this.service.getScreen(id);
    if (!data) throw new NotFoundException(`Screen '${id}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/screen/:id/similar
  @Get('screen/:id/similar')
  async getSimilar(@Param('id') id: string, @Query('limit') limit = 12) {
    const data = await this.service.getSimilar(id, Math.min(Number(limit) || 12, 60));
    if (!data) throw new NotFoundException(`Screen '${id}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/screen/:id/analysis
  @Get('screen/:id/analysis')
  async getAnalysis(@Param('id') id: string) {
    const screen = await this.loader.getScreen(id);
    if (!screen) throw new NotFoundException(`Screen '${id}' not found`);
    const data = await this.service.getAnalysis(id);
    // A screen with no stored analysis is reported as such rather than
    // answered with invented findings.
    return { success: true, data, analyzed: Boolean(data) };
  }

  // GET /api/inspirations/apps
  @Get('apps')
  async getApps(@Query('industry') industry?: string, @Query('sort') sort?: 'newest' | 'oldest' | 'az' | 'rating') {
    return { success: true, data: await this.service.getApps(industry, sort) };
  }

  // GET /api/inspirations/app/:slug
  @Get('app/:slug')
  async getApp(@Param('slug') slug: string) {
    const data = await this.service.getApp(slug);
    if (!data) throw new NotFoundException(`App '${slug}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/flows
  @Get('flows')
  async getFlows(@Query('category') category?: string, @Query('platform') platform?: string) {
    return { success: true, data: await this.service.getFlows(category, platform) };
  }

  // GET /api/inspirations/flow/:id
  @Get('flow/:id')
  async getFlow(@Param('id') id: string) {
    const data = await this.service.getFlow(id);
    if (!data) throw new NotFoundException(`Flow '${id}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/patterns
  @Get('patterns')
  async getPatterns(@Query('category') category?: string) {
    return { success: true, data: await this.service.getPatterns(category) };
  }

  // GET /api/inspirations/pattern/:slug
  @Get('pattern/:slug')
  async getPattern(@Param('slug') slug: string) {
    const data = await this.service.getPattern(slug);
    if (!data) throw new NotFoundException(`Pattern '${slug}' not found`);
    return { success: true, data };
  }

  // GET /api/inspirations/elements
  @Get('elements')
  async getElements() {
    return { success: true, data: await this.service.getElements() };
  }

  // GET /api/inspirations/search?q=
  @Get('search')
  async search(
    @Query('q') q = '',
    @Query('mode') mode?: string,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ) {
    const safeLimit = Math.min(Number(limit) || 50, 200);
    const safeOffset = Number(offset) || 0;
    const data = mode === 'text'
      ? await this.service.searchScreenshotText(q, safeLimit, safeOffset)
      : await this.service.search(q, safeLimit, safeOffset);
    return { success: true, data };
  }

  // GET /api/inspirations/screens/:platform/:app/:file — the image bytes
  @Get('screens/:platform/:app/:file')
  async getScreenFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('file') file: string,
    @Query('download') download: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`screens/${platform}/${app}/${file}`, file, download === '1', reply);
  }

  /**
   * GET /api/inspirations/screens/:platform/:app/:flow/:file — the image bytes
   * for a screen stored inside a flow folder.
   *
   * Declared as its own route rather than a wildcard, because exactly one extra
   * level exists and naming it keeps the path a set of ordinary segments. The
   * real gate is the servable-file map, which is built from the manifest, so an
   * unpublished path cannot resolve either way.
   */
  @Get('screens/:platform/:app/:flow/:file')
  async getFlowScreenFile(
    @Param('platform') platform: string,
    @Param('app') app: string,
    @Param('flow') flow: string,
    @Param('file') file: string,
    @Query('download') download: string,
    @Res() reply: FastifyReply,
  ) {
    return this.sendFile(`screens/${platform}/${app}/${flow}/${file}`, file, download === '1', reply);
  }

  // GET /api/inspirations/logos/:file
  @Get('logos/:file')
  async getLogoFile(@Param('file') file: string, @Res() reply: FastifyReply) {
    return this.sendFile(`logos/${file}`, file, false, reply);
  }

  private async sendFile(
    key: string,
    fileName: string,
    asDownload: boolean,
    reply: FastifyReply,
  ) {
    const absolute = await this.loader.resolveServableFile(key);
    if (!absolute) {
      return reply.code(404).send({ success: false, error: 'Not found' });
    }

    if (asDownload) {
      // Download is gated on the licence recorded for the app, not on the
      // request: view-only material is displayed but never handed over.
      const screenId = key.startsWith('screens/') ? this.screenIdForKey(key) : null;
      const screen = screenId ? await this.loader.getScreen(screenId) : null;
      if (!screen?.downloadable) {
        return reply.code(403).send({
          success: false,
          error: 'This screenshot is view-only under its recorded licence',
        });
      }
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    }

    let size: number;
    let mtime: Date;
    try {
      const info = await stat(absolute);
      size = info.size;
      mtime = info.mtime;
    } catch {
      return reply.code(404).send({ success: false, error: 'Not found' });
    }

    reply.header('Content-Type', CONTENT_TYPES[extname(absolute).toLowerCase()] || 'application/octet-stream');
    reply.header('Content-Length', size);
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    reply.header('ETag', `"${size}-${mtime.getTime()}"`);
    return reply.send(createReadStream(absolute));
  }

  /**
   * screens/<platform>/<app>/<file> or screens/<platform>/<app>/<flow>/<file>
   * → the screen id the build script assigned. The flow folder, when there is
   * one, is part of the id, exactly as manifest.builder.ts derives it.
   */
  private screenIdForKey(key: string): string | null {
    const parts = key.split('/');
    if (parts.length !== 4 && parts.length !== 5) return null;
    const [, platform, app, ...rest] = parts;
    const file = rest.join('/');
    const base = file.replace(/\.[^.]+$/, '').split('/').join('-');
    return `${app}-${platform}-${base}`;
  }
}
