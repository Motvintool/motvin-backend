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
  metadata(): Promise<{ width?: number; height?: number }>;
  extract(region: { left: number; top: number; width: number; height: number }): ImageOps;
  resize(options: { width: number; withoutEnlargement: boolean }): ImageOps;
  jpeg(options: { quality: number; mozjpeg?: boolean }): ImageOps;
  toBuffer(): Promise<Buffer>;
};

// Loaded the way inspirations-admin.service.ts does: sharp ships its own
// native binary and a CommonJS entry, so a plain require keeps the import
// simple under the project's module settings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: (input: string, options?: { limitInputPixels: false }) => ImageOps = require('sharp');

/**
 * A website's whole page can be 16,000px tall: shrunk to preview width it is a thin strip no model can read.
 * Its preview is its top, as a visitor first sees it; a section taller than this many widths keeps its top too.
 */
const PAGE_TOP_SHARE = 1;
const SECTION_MAX_SHARE = 2.5;

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

    let image = sharp(absolute, { limitInputPixels: false });
    const site = screen.site;
    if (site) {
      const { width: w = 0, height: h = 0 } = await image.metadata();
      const keep = Math.round(w * (site.kind === 'page' ? PAGE_TOP_SHARE : SECTION_MAX_SHARE));
      if (w && h > keep) image = sharp(absolute, { limitInputPixels: false }).extract({ left: 0, top: 0, width: w, height: keep });
    }
    const buffer = await image
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
