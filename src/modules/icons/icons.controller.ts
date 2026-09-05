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
import { IconsService } from './icons.service';

@Controller('icons')
export class IconsController {
  constructor(private readonly iconsService: IconsService) {}

  // GET /api/icons/collections
  @Get('collections')
  async getCollections() {
    const collections = await this.iconsService.getAllCollections();
    return {
      success: true,
      data: collections,
    };
  }

  // GET /api/icons/collection/:collectionId
  @Get('collection/:collectionId')
  async getCollection(@Param('collectionId') collectionId: string) {
    const metadata = await this.iconsService.getCollectionMetadata(
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

  // GET /api/icons/collection/:collectionId/icons
  @Get('collection/:collectionId/icons')
  async getCollectionIcons(
    @Param('collectionId') collectionId: string,
    @Query('limit') limit: number = 50,
    @Query('offset') offset: number = 0,
    @Query('category') category?: string,
    @Query('style') style?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.iconsService.getIcons(collectionId, {
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

  // GET /api/icons/:collectionId/:iconName.svg
  @Get(':collectionId/:iconName.svg')
  async getIconSVG(
    @Param('collectionId') collectionId: string,
    @Param('iconName') iconName: string,
    @Res() reply: FastifyReply,
    @Query('color') color?: string,
    @Query('size') size?: number,
    @Query('stroke') stroke?: number,
  ) {
    // Remove .svg extension if present
    const cleanName = iconName.replace(/\.svg$/, '');

    const svg = await this.iconsService.generateSVG(
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
        .send({ error: 'Icon not found' });
    }

    // Set headers for SVG and Cloudflare caching
    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    reply.header('ETag', `"${collectionId}-${cleanName}-v1"`);

    return reply.code(HttpStatus.OK).send(svg);
  }

  // GET /api/icons/stats
  @Get('stats')
  async getStats() {
    const stats = await this.iconsService.getStats();
    return {
      success: true,
      data: stats,
    };
  }

  // GET /api/icons/search
  @Get('search')
  async searchIcons(
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

    const results = await this.iconsService.searchIcons(query, {
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
