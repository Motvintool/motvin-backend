import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { InspirationScreen, LoaderService } from '../inspirations/loader.service';

/**
 * Small JPEG renditions of library screenshots, inlined in tool results so
 * the AI can look at a screen rather than only read about it.
 *
 * Stored screens are full-resolution WebP (a phone capture is ~1170px wide);
 * at that size a dozen of them would make a result several megabytes. A
 * 360px JPEG at moderate quality is 20–40 KB and still legible to a vision
 * model. Renditions are cached in memory by screen and width, so repeated
 * searches over the same popular screens cost one resize.
 */

type ImageOps = {
  resize(options: { width: number; withoutEnlargement: boolean }): ImageOps;
  jpeg(options: { quality: number; mozjpeg?: boolean }): ImageOps;
  toBuffer(): Promise<Buffer>;
};

// Loaded the way inspirations-admin.service.ts does: sharp ships its own
// native binary and a CommonJS entry, so a plain require keeps the import
// simple under the project's module settings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: (input: string) => ImageOps = require('sharp');

export const PREVIEW_MIME = 'image/jpeg';

@Injectable()
export class ScreenPreviewService {
  private readonly cache = new LRUCache<string, Buffer>({
    max: 2000,
    maxSize: 96 * 1024 * 1024,
    sizeCalculation: (buffer) => buffer.length,
  });

  constructor(private readonly loader: LoaderService) {}

  /** The rendition as a JPEG buffer, or null when the file is not published. */
  async jpeg(screen: InspirationScreen, width: number): Promise<Buffer | null> {
    const key = `${screen.id}@${screen.version ?? ''}:${width}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const absolute = await this.loader.resolveServableFile(`screens/${screen.file}`);
    if (!absolute) return null;

    const buffer = await sharp(absolute)
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();
    this.cache.set(key, buffer);
    return buffer;
  }

  /** The rendition as the base64 string an MCP image content block carries. */
  async base64(screen: InspirationScreen, width: number): Promise<string | null> {
    const buffer = await this.jpeg(screen, width);
    return buffer ? buffer.toString('base64') : null;
  }
}
