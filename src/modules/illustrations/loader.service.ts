import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFile } from "fs/promises";
import { join } from "path";
import { CacheService } from "./cache.service";

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
    this.dataRoot = this.configService.get<string>("dataRoot");
  }

  async onModuleInit() {
    try {
      await this.loadCollectionsFile();
      await this.loadSourcesFile();
      this.logger.log(
        `Loaded ${this.collectionsData.totalCollections} illustration collections`,
      );
    } catch (error) {
      this.logger.error("Failed to load illustration metadata files", error);
    }
  }

  private async loadCollectionsFile() {
    const filePath = join(this.dataRoot, "illustrations", "collections.json");
    const data = await readFile(filePath, "utf-8");
    this.collectionsData = JSON.parse(data);
  }

  private async loadSourcesFile() {
    const filePath = join(this.dataRoot, "illustrations", "sources.json");
    const data = await readFile(filePath, "utf-8");
    this.sourcesData = JSON.parse(data);
  }

  async getCollectionsList() {
    if (!this.collectionsData) await this.loadCollectionsFile();
    return {
      total: this.collectionsData.totalCollections,
      collections: this.collectionsData.collections,
    };
  }

  async getMetadata(collectionId: string) {
    const cacheKey = `metadata:${collectionId}`;
    const cached = this.cacheService.getCollection(cacheKey);
    if (cached) return cached;

    try {
      const filePath = join(
        this.dataRoot,
        "illustrations",
        collectionId,
        "metadata.json",
      );
      const data = await readFile(filePath, "utf-8");
      const metadata = JSON.parse(data);
      this.cacheService.setCollection(cacheKey, metadata);
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
    if (this.sourcesData?.[collectionId]) {
      return this.sourcesData[collectionId].license || null;
    }
    return null;
  }

  async getCollection(collectionId: string) {
    const cached = this.cacheService.getCollection(collectionId);
    if (cached) {
      this.logger.debug(
        `Cache HIT for illustration collection: ${collectionId}`,
      );
      return cached;
    }

    this.logger.debug(
      `Cache MISS for illustration collection: ${collectionId}`,
    );

    try {
      const filePath = join(
        this.dataRoot,
        "illustrations",
        collectionId,
        "icons.json",
      );
      const startTime = Date.now();
      const data = await readFile(filePath, "utf-8");
      const items = JSON.parse(data);

      const categoryKeywords: Record<string, string[]> = {
        People: [
          "person",
          "people",
          "human",
          "man",
          "woman",
          "girl",
          "boy",
          "team",
          "crowd",
          "family",
        ],
        Business: [
          "business",
          "work",
          "office",
          "meeting",
          "finance",
          "money",
          "startup",
          "corporate",
          "deal",
        ],
        Technology: [
          "tech",
          "computer",
          "phone",
          "device",
          "digital",
          "app",
          "software",
          "data",
          "robot",
          "ai",
        ],
        Nature: [
          "nature",
          "tree",
          "plant",
          "flower",
          "mountain",
          "sea",
          "earth",
          "eco",
          "green",
          "forest",
        ],
        Health: [
          "health",
          "medical",
          "doctor",
          "hospital",
          "fitness",
          "sport",
          "wellness",
          "yoga",
          "exercise",
        ],
        Education: [
          "education",
          "school",
          "book",
          "study",
          "learn",
          "student",
          "teacher",
          "science",
          "knowledge",
        ],
        Travel: [
          "travel",
          "trip",
          "journey",
          "map",
          "plane",
          "city",
          "adventure",
          "tourism",
          "hotel",
        ],
        Lifestyle: [
          "lifestyle",
          "home",
          "food",
          "cooking",
          "music",
          "art",
          "shopping",
          "fashion",
          "relax",
        ],
        Abstract: [
          "abstract",
          "geometric",
          "shape",
          "pattern",
          "colorful",
          "gradient",
          "wave",
          "minimal",
        ],
      };

      const categoryRegexMap = new Map<string, RegExp>();
      for (const [cat, kws] of Object.entries(categoryKeywords)) {
        categoryRegexMap.set(cat, new RegExp(`\\b(${kws.join("|")})\\b`, "i"));
      }

      for (const item of items) {
        const searchStr =
          `${item.name} ${(item.tags || []).join(" ")}`.toLowerCase();
        let matched = false;
        for (const [cat, regex] of categoryRegexMap.entries()) {
          if (regex.test(searchStr)) {
            item.category = cat;
            matched = true;
            break;
          }
        }
        if (!matched) item.category = "Others";
      }

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `Loaded ${items.length} illustrations from ${collectionId} in ${elapsed}ms`,
      );

      this.cacheService.setCollection(collectionId, items);
      return items;
    } catch (error) {
      this.logger.error(
        `Failed to load illustration collection ${collectionId}`,
        error.message,
      );
      return null;
    }
  }

  async calculateStats() {
    if (!this.collectionsData) throw new Error("Collections data not loaded");

    const byStyle = new Map<string, number>();
    const byLicense = new Map<string, number>();
    const byCategory = new Map<string, number>();

    const categoryList = [
      "People",
      "Business",
      "Technology",
      "Nature",
      "Health",
      "Education",
      "Travel",
      "Lifestyle",
      "Abstract",
      "Others",
    ];
    for (const cat of categoryList) byCategory.set(cat, 0);

    const bySource = this.collectionsData.collections.map((c) => ({
      id: c.id,
      name: c.name,
      total: c.total,
      styles: c.styles,
      license: this.sourcesData?.[c.id]?.license || "Unknown",
      licenseUrl: this.sourcesData?.[c.id]?.licenseUrl || "",
    }));

    for (const collection of this.collectionsData.collections) {
      collection.styles.forEach((style: string) => {
        byStyle.set(style, (byStyle.get(style) || 0) + collection.total);
      });

      if (this.sourcesData?.[collection.id]) {
        const license = this.sourcesData[collection.id].license;
        byLicense.set(
          license,
          (byLicense.get(license) || 0) + collection.total,
        );
      }

      try {
        const items = await this.getCollection(collection.id);
        if (!items) continue;
        for (const item of items) {
          const cat = item.category || "Others";
          byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
        }
      } catch (e) {
        this.logger.warn(
          `Failed to load illustrations for ${collection.id}: ${e.message}`,
        );
      }
    }

    return {
      total: this.collectionsData.totalIcons,
      totalCollections: this.collectionsData.totalCollections,
      collections: bySource,
      byStyle: Object.fromEntries(byStyle),
      byLicense: Object.fromEntries(byLicense),
      byCategory: Object.fromEntries(byCategory),
    };
  }
}
