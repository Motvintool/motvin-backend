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
  private sourcesData: any;

  constructor(
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {
    this.dataRoot = this.configService.get<string>('dataRoot');
  }

  async onModuleInit() {
    // Load collections.json and sources.json at startup
    try {
      await this.loadCollectionsFile();
      await this.loadSourcesFile();
      this.logger.log(
        `Loaded ${this.collectionsData.totalCollections} collections metadata`,
      );
    } catch (error) {
      this.logger.error('Failed to load metadata files', error);
    }
  }

  private async loadCollectionsFile() {
    const path = join(this.dataRoot, 'icons', 'collections.json');
    const data = await readFile(path, 'utf-8');
    this.collectionsData = JSON.parse(data);
  }

  private async loadSourcesFile() {
    const path = join(this.dataRoot, 'icons', 'sources.json');
    const data = await readFile(path, 'utf-8');
    this.sourcesData = JSON.parse(data);
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

  getCollectionLicense(collectionId: string): string | null {
    if (this.sourcesData && this.sourcesData[collectionId]) {
      return this.sourcesData[collectionId].license || null;
    }
    return null;
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

      const categoryKeywords = {
        Arrows: ['arrow', 'chevron', 'caret', 'direction', 'point', 'up', 'down', 'left', 'right'],
        Communication: ['phone', 'mail', 'chat', 'message', 'envelope', 'call', 'speech', 'comment', 'send', 'wifi', 'signal', 'network', 'bluetooth'],
        Media: ['play', 'pause', 'stop', 'video', 'music', 'audio', 'sound', 'volume', 'speaker', 'mic', 'cast'],
        People: ['user', 'person', 'people', 'avatar', 'profile', 'face', 'group', 'man', 'woman'],
        Business: ['briefcase', 'office', 'chart', 'graph', 'money', 'dollar', 'euro', 'coin', 'wallet', 'trend', 'bag'],
        Weather: ['sun', 'moon', 'cloud', 'rain', 'snow', 'wind', 'lightning', 'weather', 'storm', 'temp'],
        Device: ['laptop', 'mobile', 'phone', 'tablet', 'screen', 'monitor', 'keyboard', 'mouse', 'battery', 'cpu', 'device', 'desktop', 'computer'],
        Navigation: ['map', 'location', 'pin', 'gps', 'compass', 'globe', 'route', 'marker', 'local'],
        File: ['file', 'folder', 'document', 'archive', 'paper', 'copy', 'paste', 'clipboard'],
        Security: ['lock', 'key', 'shield', 'guard', 'protect', 'secure', 'password', 'unlock'],
        Time: ['clock', 'time', 'watch', 'hour', 'minute', 'calendar', 'date', 'schedule'],
        Status: ['check', 'cross', 'x', 'close', 'tick', 'success', 'warning', 'error', 'alert', 'info', 'bell', 'plus', 'minus', 'add', 'remove', 'delete', 'clear', 'cancel', 'badge'],
        AI: ['ai', 'robot', 'bot', 'sparkle', 'magic', 'brain', 'smart', 'machine'],
        Editing: ['edit', 'pencil', 'pen', 'write', 'draw', 'brush', 'crop', 'cut', 'paint', 'filter', 'view', 'eye', 'zoom', 'search', 'format', 'layout', 'list', 'table', 'sort', 'select'],
        Characters: ['font', 'text', 'letter', 'character', 'type', 'bold', 'italic', 'heading', 'language'],
        Hands: ['hand', 'finger', 'thumb', 'point', 'touch', 'grab', 'hold'],
        Home: ['home', 'house', 'building', 'roof', 'door', 'nest'],
        Album: ['album', 'photo', 'picture', 'image', 'gallery'],
        Camera: ['camera', 'lens', 'shutter', 'focus'],
        Nature: ['leaf', 'tree', 'plant', 'flower', 'forest', 'wood', 'bug', 'animal', 'water', 'fire', 'drop'],
        Finance: ['bank', 'money', 'coin', 'card', 'credit', 'dollar', 'euro', 'wallet', 'pay', 'currency'],
        Education: ['book', 'school', 'learn', 'student', 'graduate', 'degree', 'hat', 'read', 'class'],
        Transport: ['car', 'bus', 'train', 'plane', 'truck', 'bike', 'ship', 'boat', 'vehicle', 'auto'],
        Design: ['layer', 'vector', 'palette', 'color', 'paint', 'canvas', 'grid', 'align', 'distribute', 'path'],
        Commerce: ['shop', 'cart', 'bag', 'store', 'buy', 'sell', 'price', 'tag', 'basket'],
        Health: ['health', 'medical', 'hospital', 'pill', 'heart', 'pulse', 'doctor', 'nurse'],
        Food: ['food', 'drink', 'cup', 'coffee', 'meal', 'fork', 'knife', 'spoon', 'pizza', 'burger', 'apple', 'dining'],
        Social: ['share', 'like', 'thumb', 'heart', 'star', 'network', 'connect', 'link'],
        Brands: ['logo', 'brand', 'facebook', 'twitter', 'google', 'apple', 'microsoft', 'github', 'amazon'],
        Sports: ['ball', 'game', 'sport', 'play', 'run', 'jump', 'swim', 'fitness'],
        Gaming: ['game', 'play', 'console', 'controller', 'joystick', 'pixel', 'vr', 'dice', 'chess'],
        Development: ['code', 'bracket', 'terminal', 'bug', 'debug', 'program', 'api', 'server', 'database', 'web'],
        System: ['setting', 'gear', 'cog', 'option', 'config', 'power', 'off', 'on', 'switch', 'menu', 'tool'],
        Shapes: ['circle', 'square', 'triangle', 'rectangle', 'star', 'polygon', 'cube', 'shape'],
        Music: ['music', 'note', 'clef', 'melody', 'song', 'tune'],
        Travel: ['travel', 'bag', 'luggage', 'suitcase', 'ticket', 'flight', 'trip'],
      };

      const categoryRegexMap = new Map<string, RegExp>();
      for (const [category, keywords] of Object.entries(categoryKeywords)) {
        categoryRegexMap.set(category, new RegExp(`\\b(${keywords.join('|')})\\b`, 'i'));
      }

      // Pre-compute category for each icon before caching
      for (const icon of icons) {
        const searchStr = `${icon.name} ${(icon.tags || []).join(' ')}`.toLowerCase();
        let matched = false;
        for (const [category, regex] of categoryRegexMap.entries()) {
          if (regex.test(searchStr)) {
            icon.category = category;
            matched = true;
            break;
          }
        }
        if (!matched) {
          icon.category = 'Others';
        }
      }

      const loadTime = Date.now() - startTime;
      this.logger.log(
        `Loaded and categorized ${icons.length} icons from ${collectionId} in ${loadTime}ms`,
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

  async calculateStats() {
    if (!this.collectionsData) {
      throw new Error('Collections data not loaded');
    }

    // Aggregate stats by style and license
    const byStyle = new Map<string, number>();
    const byLicense = new Map<string, number>();
    const byCategory = new Map<string, number>();
    const bySource = this.collectionsData.collections.map((c) => ({
      id: c.id,
      name: c.name,
      total: c.total,
      styles: c.styles,
    }));

    // Category list to initialize counts with 0
    const categoryList = ['Arrows', 'Communication', 'Media', 'People', 'Business', 'Weather', 'Device', 'Navigation', 'File', 'Security', 'Time', 'Status', 'AI', 'Editing', 'Characters', 'Hands', 'Home', 'Album', 'Camera', 'Nature', 'Finance', 'Education', 'Transport', 'Design', 'Commerce', 'Health', 'Food', 'Social', 'Brands', 'Sports', 'Gaming', 'Development', 'System', 'Shapes', 'Music', 'Travel'];


    for (const category of categoryList) {
      byCategory.set(category, 0);
    }
    byCategory.set('Others', 0);

    // Load and process icons from each collection
    const startTime = Date.now();
    for (const collection of this.collectionsData.collections) {
      // Style counts (from collection metadata)
      collection.styles.forEach((style) => {
        const count = byStyle.get(style) || 0;
        byStyle.set(style, count + collection.total);
      });

      // License counts (from sources.json)
      if (this.sourcesData && this.sourcesData[collection.id]) {
        const license = this.sourcesData[collection.id].license;
        const count = byLicense.get(license) || 0;
        byLicense.set(license, count + collection.total);
      }

      // Category counts (requires loading icons)
      try {
        const icons = await this.getCollection(collection.id);
        if (!icons) continue;

        for (const icon of icons) {
          const cat = icon.category || 'Others';
          byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
        }
      } catch (error) {
        this.logger.warn(`Failed to load icons for ${collection.id}: ${error.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    this.logger.log(`Calculated stats in ${elapsed}ms`);

    return {
      total: this.collectionsData.totalIcons,
      totalCollections: this.collectionsData.totalCollections,
      collections: bySource,
      byStyle: Object.fromEntries(byStyle),
      byLicense: Object.fromEntries(byLicense),
      byCategory: Object.fromEntries(byCategory),
      lastUpdated: this.collectionsData.lastUpdated,
      version: this.collectionsData.version,
    };
  }
}
