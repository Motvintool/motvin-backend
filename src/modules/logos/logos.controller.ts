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
import { LogosService } from './logos.service';

@Controller('logos')
export class LogosController {
  constructor(private readonly logosService: LogosService) {}

  // GET /api/logos/collections
  @Get('collections')
  async getCollections() {
    const collections = await this.logosService.getAllCollections();
    return {
      success: true,
      data: collections,
    };
  }

  // GET /api/logos/collection/:collectionId
  @Get('collection/:collectionId')
  async getCollection(@Param('collectionId') collectionId: string) {
    const metadata = await this.logosService.getCollectionMetadata(
      collectionId,
    );

    if (!metadata) {
      throw new NotFoundException(
        `Collection '${collectionId}' not found`,
      );
    }

    return {
      success: true,
      data: metadata,
    };
  }

  // GET /api/logos/collection/:collectionId/logos
  @Get('collection/:collectionId/logos')
  async getCollectionLogos(
    @Param('collectionId') collectionId: string,
    @Query('limit') limit: number = 50,
    @Query('offset') offset: number = 0,
    @Query('category') category?: string,
    @Query('style') style?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.logosService.getLogos(collectionId, {
      limit: Math.min(limit, 200), // Max 200
      offset,
      category,
      style,
      search,
    });

    return {
      success: true,
      data: result,
    };
  }

  // GET /api/logos/:collectionId/:logoName.svg
  @Get(':collectionId/:logoName.svg')
  async getLogoSVG(
    @Param('collectionId') collectionId: string,
    @Param('logoName') logoName: string,
    @Res() reply: FastifyReply,
    @Query('color') color?: string,
    @Query('size') size?: number,
    @Query('stroke') stroke?: number,
  ) {
    // Remove .svg extension if present
    const cleanName = logoName.replace(/\.svg$/, '');

    const svg = await this.logosService.generateSVG(
      collectionId,
      cleanName,
      {
        color,
        size,
        stroke,
      },
    );

    if (!svg) {
      return reply
        .code(HttpStatus.NOT_FOUND)
        .send({ error: 'Logo not found' });
    }

    // Set headers for SVG and Cloudflare caching
    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    reply.header('ETag', `"${collectionId}-${cleanName}-v1"`);

    return reply.code(HttpStatus.OK).send(svg);
  }

  // GET /api/logos/stats
  @Get('stats')
  async getStats() {
    const stats = await this.logosService.getStats();
    return {
      success: true,
      data: stats,
    };
  }

  // GET /api/logos/search
  @Get('search')
  async searchLogos(
    @Query('q') query: string = '',  // Make optional with default empty string
    @Query('collection') collection?: string,
    @Query('category') category?: string,
    @Query('style') style?: string,
    @Query('license') license?: string,
    @Query('ids') ids?: string,
    @Query('limit') limit: number = 50,
    @Query('offset') offset: number = 0,
  ) {
    // Allow empty query for cross-collection browsing
    // if (!query) removed - empty query is now valid

    const results = await this.logosService.searchLogos(query, {
      collection: collection?.split(','),
      category,
      style,
      license,
      ids: ids?.split(','),
      limit: Math.min(limit, 200),
      offset,
    });

    return {
      success: true,
      data: results,
    };
  }
}
