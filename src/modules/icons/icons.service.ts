import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { LoaderService } from "./loader.service";
import { CacheService } from "./cache.service";
import { LRUCache } from 'lru-cache';
const MiniSearch = require('minisearch');

interface Icon {
  id: string;
  name: string;
  category: string;
  tags: string[];
  style: string;
  viewBox: string;
  svg: string;
  body?: string;
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
export class IconsService implements OnModuleInit {
  private readonly logger = new Logger(IconsService.name);
  private searchCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 }); // 5 minutes cache
  private miniSearch: any;
  private allIconsMetadata: any[] = [];
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
      storeFields: ['id', 'name', 'collection', 'collectionName', 'category', 'style', 'viewBox', 'license', 'isEditableStroke', 'imageUrl', 'source', 'sourceName', 'author', 'licenseUrl']
    });
    
    // We don't await this so the server starts immediately. The search will wait or fallback until ready.
    this.buildSearchIndex().catch(err => this.logger.error('Failed to build search index', err));
  }

  private async buildSearchIndex() {
    const collectionsData = await this.loaderService.getCollectionsList();
    let totalIndexed = 0;
    
    for (const c of collectionsData.collections) {
      const collectionId = c.id;
      const icons = await this.loaderService.getCollection(collectionId);
      if (!icons) continue;

      const metadata = await this.loaderService.getMetadata(collectionId);
      const collectionLicense = await this.loaderService.getCollectionLicense(collectionId);

      const docs = icons.map(icon => {
        const { svg, body, tags, ...rest } = icon as any;
        const rawSvg = svg || body || '';
        const isEditableStroke = rawSvg.includes('stroke-width');
        const doc = {
          ...rest,
          uid: `${collectionId}_${icon.id}`,
          tags: (tags || []).join(' '),
          collection: collectionId,
          collectionName: metadata?.name || collectionId,
          license: collectionLicense,
          isEditableStroke,
        };
        this.allIconsMetadata.push(doc);
        return doc;
      });

      this.miniSearch.addAll(docs);
      totalIndexed += docs.length;
    }
    this.searchIndexReady = true;
    this.logger.log(`MiniSearch index built successfully. Indexed ${totalIndexed} icons.`);
  }

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
          (icon.tags || []).some((tag) =>
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
      ? `#${options.color.replace("#", "")}`
      : "currentColor";
    const size = options.size || 24;
    const stroke = options.stroke || 2;

    // Replace color and stroke in SVG
    const rawSvg = icon.svg || icon.body || "";
    let svg = rawSvg
      .replace(/currentColor/g, color)
      .replace(/stroke-width="[^"]*"/g, `stroke-width="${stroke}"`);

    // Wrap in SVG element
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${icon.viewBox}">${svg}</svg>`;
  }

  async searchIcons(query: string, options: SearchOptions) {
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

    // Build filter helpers
    const collectionsToSearch = options.collection && options.collection.length > 0 ? options.collection : null;
    const categoryFilter = options.category ? options.category.split(",") : null;
    const styleFilter = options.style ? options.style.split(",") : null;
    const licenseFilter = options.license ? options.license.split(",") : null;
    const idsFilter = options.ids && options.ids.length > 0 ? options.ids : null;

    const filterFn = (result: any) => {
      if (collectionsToSearch && !collectionsToSearch.includes(result.collection)) return false;
      if (categoryFilter && !categoryFilter.includes(result.category)) return false;
      if (styleFilter && !styleFilter.includes(result.style)) return false;
      
      // Filter out non-editable strokes when Outline style is requested
      const hasOutlineFilter = styleFilter && styleFilter.some((s: string) => s.toLowerCase() === 'outline');
      if (hasOutlineFilter && result.style && result.style.toLowerCase() === 'outline' && !result.isEditableStroke) {
        return false;
      }
      
      if (licenseFilter && !licenseFilter.includes(result.license)) return false;
      if (idsFilter && !idsFilter.includes(result.id)) return false;
      return true;
    };

    let results: any[] = [];
    
    if (isEmptyQuery) {
      // Just filter the full metadata array
      const hasFilters = collectionsToSearch || categoryFilter || styleFilter || licenseFilter || idsFilter;
      results = hasFilters ? this.allIconsMetadata.filter(filterFn) : this.allIconsMetadata;
      results = results.map(r => ({ ...r, relevance: 0.5 }));
    } else {
      // Use MiniSearch
      const searchResults = this.miniSearch.search(query, {
        prefix: true, // allows matching partial words like 'hom'
        combineWith: 'AND',
        filter: filterFn,
      });
      results = searchResults.map(r => ({ ...r, relevance: r.score }));
    }

    // Pagination
    const requestedOffset = Number(options.offset) || 0;
    const requestedLimit = Number(options.limit) || 50;
    const paginated = results.slice(requestedOffset, requestedOffset + requestedLimit);

    // Fetch full SVG payloads only for the paginated items
    for (const item of paginated) {
      const colIcons = await this.loaderService.getCollection(item.collection);
      if (colIcons) {
        const fullIcon = colIcons.find((i: any) => i.id === item.id);
        if (fullIcon) {
          item.svg = fullIcon.svg || fullIcon.body || "";
          item.tags = fullIcon.tags || []; // restore tags array
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
