import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';

@Injectable()
export class CacheService implements OnModuleInit {
  private readonly logger = new Logger(CacheService.name);
  private collectionCache: LRUCache<string, any>;
  private logoCache: LRUCache<string, any>;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const config = this.configService.get('cache');

    // Collection-level cache
    this.collectionCache = new LRUCache({
      max: config.maxCollections,
      maxSize: config.maxSizeMB * 1024 * 1024, // Convert MB to bytes
      sizeCalculation: (value) => {
        return JSON.stringify(value).length;
      },
      ttl: config.collectionTTL,
      updateAgeOnGet: true, // Reset TTL on access
      allowStale: false,
    });

    // Logo-level cache (for individual logos)
    this.logoCache = new LRUCache({
      max: 10000, // Max 10K logos
      maxSize: 50 * 1024 * 1024, // 50 MB
      sizeCalculation: (value) => JSON.stringify(value).length,
      ttl: config.logoTTL,
      updateAgeOnGet: true,
      allowStale: false,
    });

    this.logger.log(
      `Cache initialized: Collections(max=${config.maxCollections}, size=${config.maxSizeMB}MB, ttl=${config.collectionTTL}ms)`,
    );
    this.logger.log(
      `Logo cache initialized: max=10000, size=50MB, ttl=${config.logoTTL}ms`,
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

  // Logo cache operations
  getLogo(key: string): any {
    return this.logoCache.get(key);
  }

  setLogo(key: string, value: any): void {
    this.logoCache.set(key, value);
  }

  hasLogo(key: string): boolean {
    return this.logoCache.has(key);
  }

  // Cache stats
  getStats() {
    return {
      collections: {
        size: this.collectionCache.size,
        itemCount: this.collectionCache.size,
        calculatedSize: this.collectionCache.calculatedSize,
      },
      logos: {
        size: this.logoCache.size,
        itemCount: this.logoCache.size,
        calculatedSize: this.logoCache.calculatedSize,
      },
    };
  }

  // Clear all caches
  clear() {
    this.collectionCache.clear();
    this.logoCache.clear();
    this.logger.log('All caches cleared');
  }
}
