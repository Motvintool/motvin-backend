import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { LoaderService } from "./loader.service";
import { CacheService } from "./cache.service";
import { LRUCache } from 'lru-cache';
const MiniSearch = require('minisearch');

interface Logo {
  id: string;
  name: string;
  category: string;
  tags: string[];
  style: string;
  viewBox: string;
  svg: string;
  body?: string;
}

interface LogoOptions {
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

interface SVGOptions {
  color?: string;
  size?: number;
  stroke?: number;
}

@Injectable()
export class LogosService implements OnModuleInit {
  private readonly logger = new Logger(LogosService.name);
  private searchCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 }); // 5 minutes cache
  private miniSearch: any;
  private allLogosMetadata: any[] = [];
  private searchIndexReady = false;

  constructor(
    private readonly loaderService: LoaderService,
    private readonly cacheService: CacheService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing MiniSearch index in the background...');
    this.miniSearch = new MiniSearch({
      idField: 'uid',
      fields: ['name', 'tags'],
      storeFields: ['id', 'name', 'collection', 'collectionName', 'category', 'style', 'viewBox', 'license', 'imageUrl', 'source', 'sourceName', 'author', 'licenseUrl']
    });
    
    this.buildSearchIndex().catch(err => this.logger.error('Failed to build search index', err));
  }

  private async buildSearchIndex() {
    const collectionsData = await this.loaderService.getCollectionsList();
    let totalIndexed = 0;
    
    for (const c of collectionsData.collections) {
      const collectionId = c.id;
      const items = await this.loaderService.getCollection(collectionId);
      if (!items) continue;

      const metadata = await this.loaderService.getMetadata(collectionId);
      const collectionLicense = await this.loaderService.getCollectionLicense(collectionId);

      // Inherit collection-level style (logos have no per-item style)
      const collectionStyle = (c.styles && c.styles.length > 0) ? c.styles[0] : undefined;
      const docs = items.map((item: any) => {
        const { svg, body, tags, ...rest } = item;
        const doc = {
          ...rest,
          uid: `${collectionId}_${item.id}`,
          tags: (tags || []).join(' '),
          collection: collectionId,
          collectionName: metadata?.name || collectionId,
          license: collectionLicense,
          style: item.style || collectionStyle,
        };
        this.allLogosMetadata.push(doc);
        return doc;
      });

      this.miniSearch.addAll(docs);
      totalIndexed += docs.length;
    }
    this.searchIndexReady = true;
    this.logger.log(`MiniSearch index built successfully. Indexed ${totalIndexed} logos.`);
  }

  async getAllCollections() {
    return this.loaderService.getCollectionsList();
  }

  async getCollectionMetadata(collectionId: string) {
    return this.loaderService.getMetadata(collectionId);
  }

  async getLogos(collectionId: string, options: LogoOptions) {
    const logos = await this.loaderService.getCollection(collectionId);

    if (!logos) {
      return null;
    }

    // Filter logos
    let filtered = logos;

    if (options.category) {
      filtered = filtered.filter(
        (logo) =>
          logo.category.toLowerCase() === options.category.toLowerCase(),
      );
    }

    if (options.style) {
      filtered = filtered.filter(
        (logo) => logo.style.toLowerCase() === options.style.toLowerCase(),
      );
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      filtered = filtered.filter(
        (logo) =>
          logo.name.toLowerCase().includes(searchLower) ||
          (logo.tags || []).some((tag) =>
            tag.toLowerCase().includes(searchLower),
          ),
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
      logos: withoutSVG,
      pagination: {
        limit,
        offset,
        hasMore: offset + limit < filtered.length,
      },
    };
  }

  async generateSVG(
    collectionId: string,
    logoName: string,
    options: SVGOptions = {},
  ): Promise<string | null> {
    // Check cache first
    const cacheKey = `${collectionId}:${logoName}`;
    const cached = this.cacheService.getLogo(cacheKey);

    let logo: Logo;

    if (cached) {
      logo = cached;
    } else {
      // Load from collection
      const logos = await this.loaderService.getCollection(collectionId);
      if (!logos) return null;

      logo = logos.find((i) => i.name === logoName);
      if (!logo) return null;

      // Cache the logo
      this.cacheService.setLogo(cacheKey, logo);
    }

    // Generate SVG with options
    const color = options.color
      ? `#${options.color.replace("#", "")}`
      : "currentColor";
    const size = options.size || 24;
    const stroke = options.stroke || 2;

    // Replace color and stroke in SVG
    let svg = logo.svg
      .replace(/currentColor/g, color)
      .replace(/stroke-width="[^"]*"/g, `stroke-width="${stroke}"`);

    // Wrap in SVG element
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${logo.viewBox}">${svg}</svg>`;
  }

  async searchLogos(query: string, options: SearchOptions) {
    if (!this.searchIndexReady) {
      this.logger.warn('Search index is still building. Search might be temporarily unavailable.');
      return { query, total: 0, returned: 0, results: [] };
    }

    const cacheKey = JSON.stringify({ query, options });
    const cachedResult = this.searchCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const isEmptyQuery = !query || query.trim() === "";

    const collectionsToSearch = options.collection && options.collection.length > 0 ? options.collection : null;
    const categoryFilter = options.category ? options.category.split(",") : null;
    const styleFilter = options.style ? options.style.split(",") : null;
    const licenseFilter = options.license ? options.license.split(",") : null;
    const idsFilter = options.ids && options.ids.length > 0 ? options.ids : null;

    const filterFn = (result: any) => {
      if (collectionsToSearch && !collectionsToSearch.includes(result.collection)) return false;
      if (categoryFilter && !categoryFilter.includes(result.category)) return false;
      if (styleFilter) {
        const itemStyle = (result.style || '').toLowerCase();
        const match = styleFilter.some((s: string) => s.toLowerCase() === itemStyle);
        if (!match) return false;
      }
      if (licenseFilter && !licenseFilter.includes(result.license)) return false;
      if (idsFilter && !idsFilter.includes(result.id)) return false;
      return true;
    };

    let results: any[] = [];
    
    if (isEmptyQuery) {
      const hasFilters = collectionsToSearch || categoryFilter || styleFilter || licenseFilter || idsFilter;
      results = hasFilters ? this.allLogosMetadata.filter(filterFn) : this.allLogosMetadata;
      results = results.map((r: any) => ({ ...r, relevance: 0.5 }));
    } else {
      const searchResults = this.miniSearch.search(query, {
        prefix: true,
        combineWith: 'AND',
        filter: filterFn,
      });
      results = searchResults.map((r: any) => ({ ...r, relevance: r.score }));
    }

    const requestedOffset = Number(options.offset) || 0;
    const requestedLimit = Number(options.limit) || 50;
    const paginated = results.slice(requestedOffset, requestedOffset + requestedLimit);

    for (const item of paginated) {
      const colItems = await this.loaderService.getCollection(item.collection);
      if (colItems) {
        const fullItem = colItems.find((i: any) => i.id === item.id);
        if (fullItem) {
          item.svg = fullItem.svg || fullItem.body || "";
          item.tags = fullItem.tags || [];
        }
      }
    }

    const finalResult = {
      query,
      total: results.length,
      returned: paginated.length,
      results: paginated,
    };
    
    this.searchCache.set(cacheKey, finalResult);
    return finalResult;
  }



  async getStats() {
    const cacheKey = "stats:global";
    const cached = this.cacheService.getCollection(cacheKey);

    if (cached) {
      this.logger.debug("Cache HIT for stats");
      return cached;
    }

    this.logger.debug("Cache MISS for stats - calculating");
    const stats = await this.loaderService.calculateStats();

    // Cache with 1 hour TTL (stats don't change often)
    this.cacheService.setCollection(cacheKey, stats);

    return stats;
  }
}
