import { Injectable, Logger } from '@nestjs/common';
import { LoaderService } from './loader.service';
import { CacheService } from './cache.service';
import { LRUCache } from 'lru-cache';

interface Illustration {
  id: string;
  name: string;
  category: string;
  tags: string[];
  style: string;
  viewBox: string;
  svg: string;
  body?: string;
}

interface IllustrationOptions {
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
  license?: string;
  ids?: string[];
  limit?: number;
  offset?: number;
}

@Injectable()
export class IllustrationsService {
  private readonly logger = new Logger(IllustrationsService.name);
  private searchCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 });

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

  async getIllustrations(collectionId: string, options: IllustrationOptions) {
    const items = await this.loaderService.getCollection(collectionId);
    if (!items) return null;

    let filtered = [...items];

    if (options.category) {
      filtered = filtered.filter(
        (i) => i.category?.toLowerCase() === options.category.toLowerCase(),
      );
    }
    if (options.style) {
      filtered = filtered.filter(
        (i) => i.style?.toLowerCase() === options.style.toLowerCase(),
      );
    }
    if (options.search) {
      const q = options.search.toLowerCase();
      filtered = filtered.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.tags || []).some((t: string) => t.toLowerCase().includes(q)),
      );
    }

    const offset = options.offset || 0;
    const limit = options.limit || 50;
    const paginated = filtered.slice(offset, offset + limit);
    const withoutSVG = paginated.map(({ svg, body, ...rest }) => rest);

    return {
      collection: collectionId,
      total: filtered.length,
      returned: withoutSVG.length,
      illustrations: withoutSVG,
      pagination: { limit, offset, hasMore: offset + limit < filtered.length },
    };
  }

  async generateSVG(collectionId: string, itemId: string): Promise<string | null> {
    const cacheKey = `${collectionId}:${itemId}`;
    const cached = this.cacheService.getItem(cacheKey);

    let item: Illustration;
    if (cached) {
      item = cached;
    } else {
      const items = await this.loaderService.getCollection(collectionId);
      if (!items) return null;
      item = items.find((i: Illustration) => i.id === itemId || i.name === itemId);
      if (!item) return null;
      this.cacheService.setItem(cacheKey, item);
    }

    const body = item.svg || item.body || '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${item.viewBox}">${body}</svg>`;
  }

  async searchIllustrations(query: string, options: SearchOptions) {
    const cacheKey = JSON.stringify({ query, options });
    const cachedResult = this.searchCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const queryLower = query ? query.toLowerCase() : '';
    const isEmptyQuery = !query || query.trim() === '';
    const results: any[] = [];

    const collectionsData = await this.loaderService.getCollectionsList();
    let collectionsToSearch = collectionsData.collections.map((c) => c.id);

    if (options.collection?.length) {
      collectionsToSearch = collectionsToSearch.filter((id) =>
        options.collection.includes(id),
      );
    }

    const requestedOffset = Number(options.offset) || 0;
    const requestedLimit = Number(options.limit) || 50;
    const needed = requestedOffset + requestedLimit;
    const hasFilters = options.collection || options.category || options.style || options.license || options.ids?.length;

    for (const collectionId of collectionsToSearch) {
      if (isEmptyQuery && !hasFilters && results.length >= needed + 500) break;

      const items = await this.loaderService.getCollection(collectionId);
      if (!items) continue;

      const collectionLicense = this.loaderService.getCollectionLicense(collectionId);

      if (options.license) {
        const licenses = options.license.split(',');
        if (!licenses.includes(collectionLicense)) continue;
      }

      for (const item of items) {
        if (options.ids?.length && !options.ids.includes(item.id)) continue;

        if (!isEmptyQuery) {
          const matchName = item.name.toLowerCase().includes(queryLower);
          const matchTags = (item.tags || []).some((t: string) =>
            t.toLowerCase().includes(queryLower),
          );
          if (!matchName && !matchTags) continue;
        }

        if (options.category) {
          const cats = options.category.split(',');
          if (!cats.includes(item.category)) continue;
        }
        if (options.style) {
          const styles = options.style.split(',');
          if (!styles.includes(item.style)) continue;
        }

        let relevance = isEmptyQuery ? 0.5 : 0;
        if (!isEmptyQuery) {
          if (item.name.toLowerCase() === queryLower) relevance = 1.0;
          else if (item.name.toLowerCase().startsWith(queryLower)) relevance = 0.8;
          else if (item.name.toLowerCase().includes(queryLower)) relevance = 0.6;
          else relevance = 0.4;
        }

        results.push({
          id: item.id,
          name: item.name,
          collection: collectionId,
          collectionName: collectionsData.collections.find((c) => c.id === collectionId)?.name || collectionId,
          category: item.category,
          tags: item.tags || [],
          style: item.style,
          viewBox: item.viewBox,
          license: collectionLicense,
          imageUrl: item.imageUrl || null,
          svg: item.imageUrl ? undefined : (item.svg || undefined), // inline SVG for items with no CDN URL
          relevance,
        });
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);

    const total = results.length;
    const paginated = results.slice(requestedOffset, requestedOffset + requestedLimit);

    const finalResult = {
      total,
      results: paginated,
      pagination: {
        limit: requestedLimit,
        offset: requestedOffset,
        hasMore: requestedOffset + requestedLimit < total,
      },
    };
    this.searchCache.set(cacheKey, finalResult);
    return finalResult;
  }

  async getStats() {
    return this.loaderService.calculateStats();
  }
}
