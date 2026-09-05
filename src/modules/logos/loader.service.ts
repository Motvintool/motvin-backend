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
    // Load collections.json and sources.json at startup
    try {
      await this.loadCollectionsFile();
      await this.loadSourcesFile();
      this.logger.log(
        `Loaded ${this.collectionsData.totalCollections} collections metadata`,
      );
    } catch (error) {
      this.logger.error("Failed to load metadata files", error);
    }
  }

  private async loadCollectionsFile() {
    const path = join(this.dataRoot, "logos", "collections.json");
    const data = await readFile(path, "utf-8");
    this.collectionsData = JSON.parse(data);
  }

  private async loadSourcesFile() {
    const path = join(this.dataRoot, "logos", "sources.json");
    const data = await readFile(path, "utf-8");
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
    const cached = this.cacheService.getCollection(`metadata:${collectionId}`);
    if (cached) return cached;

    try {
      const path = join(this.dataRoot, "logos", collectionId, "metadata.json");
      const data = await readFile(path, "utf-8");
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
      const path = join(this.dataRoot, "logos", collectionId, "icons.json");
      const startTime = Date.now();

      const data = await readFile(path, "utf-8");
      const logos = JSON.parse(data);

      const categoryKeywords = {
        Technology: [
          "tech",
          "software",
          "computer",
          "digital",
          "code",
          "web",
          "internet",
          "app",
          "system",
          "data",
          "cloud",
          "cyber",
        ],
        Social: ["social", "network", "chat", "connect", "community", "forum"],
        Finance: [
          "bank",
          "money",
          "pay",
          "crypto",
          "finance",
          "capital",
          "wallet",
          "invest",
          "wealth",
          "trading",
        ],
        Commerce: [
          "shop",
          "store",
          "cart",
          "retail",
          "buy",
          "ecommerce",
          "market",
          "trade",
          "deal",
        ],
        Entertainment: [
          "movie",
          "film",
          "music",
          "game",
          "play",
          "media",
          "studio",
          "art",
          "cinema",
          "radio",
          "tv",
        ],
        Automotive: [
          "car",
          "auto",
          "vehicle",
          "motor",
          "drive",
          "transport",
          "wheels",
        ],
        Food: [
          "food",
          "drink",
          "coffee",
          "restaurant",
          "eat",
          "meal",
          "cafe",
          "bakery",
          "kitchen",
          "recipe",
        ],
        Healthcare: [
          "health",
          "medical",
          "care",
          "medicine",
          "hospital",
          "clinic",
          "wellness",
          "pharmacy",
          "dental",
        ],
        Education: [
          "school",
          "university",
          "learn",
          "study",
          "academy",
          "college",
          "tutor",
          "knowledge",
          "student",
        ],
        Travel: [
          "travel",
          "trip",
          "hotel",
          "flight",
          "tour",
          "journey",
          "holiday",
          "vacation",
          "explore",
        ],
        RealEstate: [
          "home",
          "house",
          "property",
          "estate",
          "land",
          "realty",
          "mortgage",
          "rent",
          "building",
          "architecture",
        ],
        Fashion: [
          "fashion",
          "clothing",
          "wear",
          "style",
          "apparel",
          "boutique",
          "design",
          "trend",
          "garment",
        ],
        Sports: [
          "sport",
          "game",
          "fitness",
          "team",
          "athletic",
          "gym",
          "workout",
          "active",
        ],
        Construction: [
          "build",
          "construction",
          "tool",
          "contractor",
          "engineer",
          "architect",
          "structure",
        ],
        Energy: [
          "energy",
          "power",
          "green",
          "eco",
          "solar",
          "electric",
          "nature",
          "enviroment",
        ],
        Media: [
          "news",
          "press",
          "broadcast",
          "journal",
          "magazine",
          "publish",
          "print",
        ],
        Agency: [
          "agency",
          "consult",
          "group",
          "partner",
          "solution",
          "service",
          "firm",
          "studio",
          "manage",
        ],
      };

      const categoryRegexMap = new Map<string, RegExp>();
      for (const [category, keywords] of Object.entries(categoryKeywords)) {
        categoryRegexMap.set(
          category,
          new RegExp(`\\b(${keywords.join("|")})\\b`, "i"),
        );
      }

      // Pre-compute category for each logo before caching
      for (const logo of logos) {
        const searchStr =
          `${logo.name} ${(logo.tags || []).join(" ")}`.toLowerCase();
        let matched = false;
        for (const [category, regex] of categoryRegexMap.entries()) {
          if (regex.test(searchStr)) {
            logo.category = category;
            matched = true;
            break;
          }
        }
        if (!matched) {
          logo.category = "Others";
        }
      }

      const loadTime = Date.now() - startTime;
      this.logger.log(
        `Loaded and categorized ${logos.length} logos from ${collectionId} in ${loadTime}ms`,
      );

      // Cache the collection
      this.cacheService.setCollection(collectionId, logos);

      return logos;
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
      throw new Error("Collections data not loaded");
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
      license: this.sourcesData?.[c.id]?.license || "Unknown",
      licenseUrl: this.sourcesData?.[c.id]?.licenseUrl || "",
    }));

    // Category list to initialize counts with 0
    const categoryList = [
      "Technology",
      "Social",
      "Finance",
      "Commerce",
      "Entertainment",
      "Automotive",
      "Food",
      "Healthcare",
      "Education",
      "Travel",
      "RealEstate",
      "Fashion",
      "Sports",
      "Construction",
      "Energy",
      "Media",
      "Agency",
    ];

    for (const category of categoryList) {
      byCategory.set(category, 0);
    }
    byCategory.set("Others", 0);

    // Load and process logos from each collection
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

      // Category counts (requires loading logos)
      try {
        const logos = await this.getCollection(collection.id);
        if (!logos) continue;

        for (const logo of logos) {
          const cat = logo.category || "Others";
          byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
        }
      } catch (error) {
        this.logger.warn(
          `Failed to load logos for ${collection.id}: ${error.message}`,
        );
      }
    }

    const elapsed = Date.now() - startTime;
    this.logger.log(`Calculated stats in ${elapsed}ms`);

    return {
      total: this.collectionsData.totalLogos,
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
