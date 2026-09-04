import { Injectable, Logger } from "@nestjs/common";
import { LoaderService } from "./loader.service";
import { CacheService } from "./cache.service";
import { LRUCache } from 'lru-cache';

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
export class IconsService {
  private readonly logger = new Logger(IconsService.name);
  private searchCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 }); // 5 minutes cache

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
    const cacheKey = JSON.stringify({ query, options });
    const cachedResult = this.searchCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const queryLower = query ? query.toLowerCase() : "";
    const isEmptyQuery = !query || query.trim() === "";
    const results = [];

    // Get collections to search
    const collectionsData = await this.loaderService.getCollectionsList();
    let collectionsToSearch = collectionsData.collections.map((c) => c.id);

    const preferredCollection = "heroicons";
    collectionsToSearch.sort((left, right) => {
      if (left === preferredCollection) return -1;
      if (right === preferredCollection) return 1;
      return 0;
    });

    if (options.collection && options.collection.length > 0) {
      collectionsToSearch = collectionsToSearch.filter((id) =>
        options.collection.includes(id),
      );
    }

    // For empty query, optimize by loading only what we need
    const requestedOffset = Number(options.offset) || 0;
    const requestedLimit = Number(options.limit) || 50;
    const needed = requestedOffset + requestedLimit;

    // Search across collections
    const hasFilters =
      options.collection ||
      options.category ||
      options.style ||
      options.license ||
      (options.ids && options.ids.length > 0);
    this.logger.debug(
      `Starting search: isEmptyQuery=${isEmptyQuery}, hasFilters=${!!hasFilters}, collectionsToSearch=${collectionsToSearch.length}, needed=${needed}`,
    );

    for (const collectionId of collectionsToSearch) {
      // Optimization: Stop loading if we have enough results for pagination (only if no specific filters)
      if (isEmptyQuery && !hasFilters && results.length >= needed + 1000) {
        this.logger.debug(
          `Breaking early: results.length=${results.length} >= needed+1000=${needed + 1000}`,
        );
        break; // We have enough icons for current page + buffer
      }

      const icons = await this.loaderService.getCollection(collectionId);
      if (!icons) continue;
      this.logger.debug(
        `Loaded collection ${collectionId}: ${icons.length} icons, total so far: ${results.length}`,
      );

      const metadata = await this.loaderService.getMetadata(collectionId);
      const collectionLicense =
        await this.loaderService.getCollectionLicense(collectionId);

      // Skip entire collection if license filter doesn't match
      if (options.license) {
        const licenses = options.license.split(",");
        if (!licenses.includes(collectionLicense)) {
          this.logger.debug(
            `Skipping collection ${collectionId}: license ${collectionLicense} not in ${options.license}`,
          );
          continue;
        }
      }

      for (const icon of icons) {
        // Match query (skip filtering if empty query)
        if (!isEmptyQuery) {
          const matchName = icon.name.toLowerCase().includes(queryLower);
          const matchTags = (icon.tags || []).some((tag) =>
            tag.toLowerCase().includes(queryLower),
          );

          if (!matchName && !matchTags) continue;
        }

        // Filter by category/style (license already filtered at collection level)
        if (options.category) {
          const categories = options.category.split(",");
          if (!categories.includes(icon.category)) continue;
        }
        if (options.style) {
          const styles = options.style.split(",");
          if (!styles.includes(icon.style)) continue;
        }
        if (options.ids && options.ids.length > 0) {
          if (!options.ids.includes(icon.id)) continue;
        }

        // Calculate relevance (simple scoring)
        let relevance = isEmptyQuery ? 0.5 : 0; // Default relevance for empty query
        if (!isEmptyQuery) {
          const matchName = icon.name.toLowerCase().includes(queryLower);
          const matchTags = (icon.tags || []).some((tag) =>
            tag.toLowerCase().includes(queryLower),
          );

          if (icon.name.toLowerCase() === queryLower) relevance = 1.0;
          else if (icon.name.toLowerCase().startsWith(queryLower))
            relevance = 0.8;
          else if (matchName) relevance = 0.6;
          else if (matchTags) relevance = 0.4;
        }

        results.push({
          id: icon.id,
          name: icon.name,
          collection: collectionId,
          collectionName: metadata?.name || collectionId,
          category: icon.category,
          tags: icon.tags || [],
          style: icon.style,
          svg: icon.svg,
          viewBox: icon.viewBox,
          license: collectionLicense,
          relevance,
        });
      }
    }

    // Sort by relevance
    results.sort((a, b) => b.relevance - a.relevance);

    // Pagination
    this.logger.debug(
      `Pagination: results=${results.length}, offset=${requestedOffset}, limit=${requestedLimit}`,
    );
    const paginated = results.slice(
      requestedOffset,
      requestedOffset + requestedLimit,
    );
    this.logger.debug(`After slice: paginated=${paginated.length}`);

    // Determine total count based on filters (hasFilters already defined above)
    const totalCount =
      isEmptyQuery && !hasFilters
        ? collectionsData.collections.reduce((sum, c) => sum + c.total, 0) // No query, no filters = global total
        : results.length; // With query or filters = actual filtered count

    const finalResult = {
      query,
      total: totalCount,
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
