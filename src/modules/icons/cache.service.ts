import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';

@Injectable()
export class CacheService implements OnModuleInit {
  private readonly logger = new Logger(CacheService.name);
  private collectionCache: LRUCache<string, any>;
  private iconCache: LRUCache<string, any>;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const config = this.configService.get('cache');

    // Collection-level cache
    this.collectionCache = new LRUCache({
      max: config.maxCollections,
      maxSize: config.maxSizeMB * 1024 * 1024, // Convert MB to bytes
      sizeCalculation: (value) => {
        // Fast approximation: assume each icon object takes ~2KB
        // If it's an array of icons, return length * 2000. Otherwise 1.
        return Array.isArray(value) ? value.length * 2000 : 1;
      },
      ttl: config.collectionTTL,
      updateAgeOnGet: true, // Reset TTL on access
      allowStale: false,
    });

    // Icon-level cache (for individual icons)
    this.iconCache = new LRUCache({
      max: 10000, // Max 10K icons
      maxSize: 50 * 1024 * 1024, // 50 MB
      sizeCalculation: (value) => 2000,
      ttl: config.iconTTL,
      updateAgeOnGet: true,
      allowStale: false,
    });

    this.logger.log(
      `Cache initialized: Collections(max=${config.maxCollections}, size=${config.maxSizeMB}MB, ttl=${config.collectionTTL}ms)`,
    );
    this.logger.log(
      `Icon cache initialized: max=10000, size=50MB, ttl=${config.iconTTL}ms`,
    );
  }

  // Collection cache operations
  getCollection(key: string): any {
    return this.collectionCache.get(key);
  }

  setCollection(key: string, value: any): void {
    this.collectionCache.set(key, value);
  }

  hasCollection(key: string): boolean {
    return this.collectionCache.has(key);
  }

  // Icon cache operations
  getIcon(key: string): any {
    return this.iconCache.get(key);
  }

  setIcon(key: string, value: any): void {
    this.iconCache.set(key, value);
  }

  hasIcon(key: string): boolean {
    return this.iconCache.has(key);
  }

  // Cache stats
  getStats() {
    return {
      collections: {
        size: this.collectionCache.size,
        itemCount: this.collectionCache.size,
        calculatedSize: this.collectionCache.calculatedSize,
      },
      icons: {
        size: this.iconCache.size,
        itemCount: this.iconCache.size,
        calculatedSize: this.iconCache.calculatedSize,
      },
    };
  }

  // Clear all caches
  clear() {
    this.collectionCache.clear();
    this.iconCache.clear();
    this.logger.log('All caches cleared');
  }
}
