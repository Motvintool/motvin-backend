import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CacheService } from './cache.service';

@Injectable()
export class LoaderService implements OnModuleInit {
  private readonly logger = new Logger(LoaderService.name);
  private dataRoot: string;
  private collectionsData: any;

  constructor(
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {
    this.dataRoot = this.configService.get<string>('dataRoot');
  }

  async onModuleInit() {
    // Load collections.json at startup
    try {
      await this.loadCollectionsFile();
      this.logger.log(
        `Loaded ${this.collectionsData.totalCollections} collections metadata`,
      );
    } catch (error) {
      this.logger.error('Failed to load collections.json', error);
    }
  }

  private async loadCollectionsFile() {
    const path = join(this.dataRoot, 'icons', 'collections.json');
    const data = await readFile(path, 'utf-8');
    this.collectionsData = JSON.parse(data);
  }

  async getCollectionsList() {
    if (!this.collectionsData) {
      await this.loadCollectionsFile();
    }
    return {
      total: this.collectionsData.totalCollections,
      collections: this.collectionsData.collections,
    };
  }

  async getMetadata(collectionId: string) {
    // Check cache first
    const cached = this.cacheService.getCollection(
      `metadata:${collectionId}`,
    );
    if (cached) return cached;

    try {
      const path = join(
        this.dataRoot,
        'icons',
        collectionId,
        'metadata.json',
      );
      const data = await readFile(path, 'utf-8');
      const metadata = JSON.parse(data);

      // Cache it
      this.cacheService.setCollection(`metadata:${collectionId}`, metadata);

      return metadata;
    } catch (error) {
      this.logger.error(
        `Failed to load metadata for ${collectionId}`,
        error.message,
      );
      return null;
    }
  }

  async getCollection(collectionId: string) {
    // Check cache first
    const cached = this.cacheService.getCollection(collectionId);
    if (cached) {
      this.logger.debug(`Cache HIT for collection: ${collectionId}`);
      return cached;
    }

    this.logger.debug(`Cache MISS for collection: ${collectionId}`);

    try {
      const path = join(this.dataRoot, 'icons', collectionId, 'icons.json');
      const startTime = Date.now();

      const data = await readFile(path, 'utf-8');
      const icons = JSON.parse(data);

      const loadTime = Date.now() - startTime;
      this.logger.log(
        `Loaded ${icons.length} icons from ${collectionId} in ${loadTime}ms`,
      );

      // Cache the collection
      this.cacheService.setCollection(collectionId, icons);

      return icons;
    } catch (error) {
      this.logger.error(
        `Failed to load collection ${collectionId}`,
        error.message,
      );
      return null;
    }
  }
}
