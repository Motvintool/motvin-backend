import { Injectable, Logger } from '@nestjs/common';
import { LoaderService } from './loader.service';
import { CacheService } from './cache.service';

interface Icon {
  id: string;
  name: string;
  category: string;
  tags: string[];
  style: string;
  viewBox: string;
  svg: string;
}

interface IconOptions {
  limit?: number;
  offset?: number;
  category?: string;
  style?: string;
  search?: string;
}

interface SearchOptions {
  collection?: string[];
  category?: string;
  style?: string;
  limit?: number;
  offset?: number;
}

interface SVGOptions {
  color?: string;
  size?: number;
  stroke?: number;
}

@Injectable()
export class IconsService {
  private readonly logger = new Logger(IconsService.name);

  constructor(
    private readonly loaderService: LoaderService,
    private readonly cacheService: CacheService,
  ) {}

  async getAllCollections() {
    return this.loaderService.getCollectionsList();
  }

  async getCollectionMetadata(collectionId: string) {
    return this.loaderService.getMetadata(collectionId);
  }

  async getIcons(collectionId: string, options: IconOptions) {
    const icons = await this.loaderService.getCollection(collectionId);

    if (!icons) {
      return null;
    }

    // Filter icons
    let filtered = icons;

    if (options.category) {
      filtered = filtered.filter(
        (icon) =>
          icon.category.toLowerCase() === options.category.toLowerCase(),
      );
    }

    if (options.style) {
      filtered = filtered.filter(
        (icon) => icon.style.toLowerCase() === options.style.toLowerCase(),
      );
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      filtered = filtered.filter(
        (icon) =>
          icon.name.toLowerCase().includes(searchLower) ||
          icon.tags.some((tag) => tag.toLowerCase().includes(searchLower)),
      );
    }

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || 50;
    const paginated = filtered.slice(offset, offset + limit);

    // Remove SVG content from list (too large)
    const withoutSVG = paginated.map(({ svg, ...rest }) => rest);

    return {
      collection: collectionId,
      total: filtered.length,
      returned: withoutSVG.length,
      icons: withoutSVG,
      pagination: {
        limit,
        offset,
        hasMore: offset + limit < filtered.length,
      },
    };
  }

  async generateSVG(
    collectionId: string,
    iconName: string,
    options: SVGOptions = {},
  ): Promise<string | null> {
    // Check cache first
    const cacheKey = `${collectionId}:${iconName}`;
    const cached = this.cacheService.getIcon(cacheKey);

    let icon: Icon;

    if (cached) {
      icon = cached;
    } else {
      // Load from collection
      const icons = await this.loaderService.getCollection(collectionId);
      if (!icons) return null;

      icon = icons.find((i) => i.name === iconName);
      if (!icon) return null;

      // Cache the icon
      this.cacheService.setIcon(cacheKey, icon);
    }

    // Generate SVG with options
    const color = options.color
      ? `#${options.color.replace('#', '')}`
      : 'currentColor';
    const size = options.size || 24;
    const stroke = options.stroke || 2;

    // Replace color and stroke in SVG
    let svg = icon.svg
      .replace(/currentColor/g, color)
      .replace(/stroke-width="[^"]*"/g, `stroke-width="${stroke}"`);

    // Wrap in SVG element
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${icon.viewBox}">${svg}</svg>`;
  }

  async searchIcons(query: string, options: SearchOptions) {
    const queryLower = query.toLowerCase();
    const results = [];

    // Get collections to search
    const collectionsData = await this.loaderService.getCollectionsList();
    let collectionsToSearch = collectionsData.collections.map((c) => c.id);

    if (options.collection && options.collection.length > 0) {
      collectionsToSearch = collectionsToSearch.filter((id) =>
        options.collection.includes(id),
      );
    }

    // Search across collections
    for (const collectionId of collectionsToSearch) {
      const icons = await this.loaderService.getCollection(collectionId);
      if (!icons) continue;

      const metadata = await this.loaderService.getMetadata(collectionId);

      for (const icon of icons) {
        // Match query
        const matchName = icon.name.toLowerCase().includes(queryLower);
        const matchTags = icon.tags.some((tag) =>
          tag.toLowerCase().includes(queryLower),
        );

        if (!matchName && !matchTags) continue;

        // Filter by category/style
        if (options.category && icon.category !== options.category) continue;
        if (options.style && icon.style !== options.style) continue;

        // Calculate relevance (simple scoring)
        let relevance = 0;
        if (icon.name.toLowerCase() === queryLower) relevance = 1.0;
        else if (icon.name.toLowerCase().startsWith(queryLower)) relevance = 0.8;
        else if (matchName) relevance = 0.6;
        else if (matchTags) relevance = 0.4;

        results.push({
          id: icon.id,
          name: icon.name,
          collection: collectionId,
          collectionName: metadata?.name || collectionId,
          category: icon.category,
          tags: icon.tags,
          style: icon.style,
          relevance,
        });
      }
    }

    // Sort by relevance
    results.sort((a, b) => b.relevance - a.relevance);

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || 50;
    const paginated = results.slice(offset, offset + limit);

    return {
      query,
      total: results.length,
      returned: paginated.length,
      results: paginated,
    };
  }
}
