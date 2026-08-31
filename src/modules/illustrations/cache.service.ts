import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private collectionCache: LRUCache<string, any>;
  private itemCache: LRUCache<string, any>;

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.get('cache');

    this.collectionCache = new LRUCache({
      max: config?.maxCollections ?? 50,
      maxSize: (config?.maxSizeMB ?? 200) * 1024 * 1024,
      sizeCalculation: (v) => JSON.stringify(v).length,
      ttl: config?.collectionTTL ?? 3600000,
      updateAgeOnGet: true,
      allowStale: false,
    });

    this.itemCache = new LRUCache({
      max: 5000,
      maxSize: 50 * 1024 * 1024,
      sizeCalculation: (v) => JSON.stringify(v).length,
      ttl: config?.iconTTL ?? 3600000,
      updateAgeOnGet: true,
      allowStale: false,
    });
  }

  getCollection(key: string): any { return this.collectionCache.get(key); }
  setCollection(key: string, value: any): void { this.collectionCache.set(key, value); }
  hasCollection(key: string): boolean { return this.collectionCache.has(key); }

  getItem(key: string): any { return this.itemCache.get(key); }
  setItem(key: string, value: any): void { this.itemCache.set(key, value); }
  hasItem(key: string): boolean { return this.itemCache.has(key); }

  // Aliases so shared code using getLogo/setLogo also works
  getLogo = this.getItem.bind(this);
  setLogo = this.setItem.bind(this);
}
