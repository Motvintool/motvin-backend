import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { IllustrationsService } from './illustrations.service';

@Controller('illustrations')
export class IllustrationsController {
  constructor(private readonly illustrationsService: IllustrationsService) {}

  // GET /api/illustrations/collections
  @Get('collections')
  async getCollections() {
    const collections = await this.illustrationsService.getAllCollections();
    return { success: true, data: collections };
  }

  // GET /api/illustrations/collection/:collectionId
  @Get('collection/:collectionId')
  async getCollection(@Param('collectionId') collectionId: string) {
    const metadata = await this.illustrationsService.getCollectionMetadata(collectionId);
    if (!metadata) throw new NotFoundException(`Collection '${collectionId}' not found`);
    return { success: true, data: metadata };
  }

  // GET /api/illustrations/collection/:collectionId/illustrations
  @Get('collection/:collectionId/illustrations')
  async getCollectionIllustrations(
    @Param('collectionId') collectionId: string,
    @Query('limit') limit: number = 50,
    @Query('offset') offset: number = 0,
    @Query('category') category?: string,
    @Query('style') style?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.illustrationsService.getIllustrations(collectionId, {
      limit: Math.min(limit, 200),
      offset,
      category,
      style,
      search,
    });
    return { success: true, data: result };
  }

  // GET /api/illustrations/:collectionId/:itemId.svg
  @Get(':collectionId/:itemId.svg')
  async getIllustrationSVG(
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
    @Res() reply: FastifyReply,
  ) {
    const cleanId = itemId.replace(/\.svg$/, '');
    const svg = await this.illustrationsService.generateSVG(collectionId, cleanId);
    if (!svg) {
      return reply.code(HttpStatus.NOT_FOUND).send({ error: 'Illustration not found' });
    }
    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    reply.header('ETag', `"${collectionId}-${cleanId}-v1"`);
    return reply.code(HttpStatus.OK).send(svg);
  }

  // GET /api/illustrations/stats
  @Get('stats')
  async getStats() {
    const stats = await this.illustrationsService.getStats();
    return { success: true, data: stats };
  }

  // GET /api/illustrations/search
  @Get('search')
  async searchIllustrations(
    @Query('q') query: string = '',
    @Query('collection') collection?: string,
    @Query('category') category?: string,
    @Query('style') style?: string,
    @Query('license') license?: string,
    @Query('ids') ids?: string,
    @Query('limit') limit: number = 50,
    @Query('offset') offset: number = 0,
  ) {
    const results = await this.illustrationsService.searchIllustrations(query, {
      collection: collection?.split(','),
      category,
      style,
      license,
      ids: ids?.split(','),
      limit: Math.min(limit, 200),
      offset,
    });
    return { success: true, data: results };
  }
}
