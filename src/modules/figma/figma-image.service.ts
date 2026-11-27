import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { InspirationScreen, LoaderService } from '../inspirations/loader.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: typeof import('sharp').default = require('sharp');

/**
 * The images the Figma plugin puts on the canvas.
 *
 * Library screens are stored as WebP, which Figma cannot take (PNG, JPEG and
 * GIF only), and Figma shrinks any image wider or taller than 4096px. So each
 * screen is sent as JPEG in parts at most 4096px tall: a phone screen or a web
 * app screen is one part, a long website page several, stacked by the plugin.
 *
 * Licences are respected as everywhere else: a screen that may be downloaded
 * comes at full resolution; a view-only one only at preview size.
 */

export const PART_HEIGHT = 4096;
const MAX_WIDTH = 4096;
/** View-only screens, as wide as a large preview. */
const VIEW_ONLY_WIDTH = { ios: 720, web: 1152 };

export interface Rendition {
  /** Pixel size of the image sent, all parts together. */
  width: number;
  height: number;
  parts: number;
  /** Whether this is the full-resolution file (its licence allows download). */
  full: boolean;
  /** The frame's size on the canvas, in design points: a 1170px iPhone capture is a 390pt screen. */
  frame: { width: number; height: number };
}

/** What a screen becomes in Figma: image size, how many parts, and its frame. */
export function rendition(screen: Pick<InspirationScreen, 'width' | 'height' | 'platform' | 'downloadable'>): Rendition {
  const sourceWidth = screen.width || 0;
  const sourceHeight = screen.height || 0;
  const cap = screen.downloadable ? MAX_WIDTH : screen.platform === 'ios' ? VIEW_ONLY_WIDTH.ios : VIEW_ONLY_WIDTH.web;
  const width = Math.min(sourceWidth, cap);
  const height = sourceWidth ? Math.round((sourceHeight * width) / sourceWidth) : 0;
  // Captures are taken at the device's pixel density: @3x on an iPhone, @2x on a retina desktop.
  const density = screen.platform === 'ios' ? (sourceWidth >= 900 ? 3 : 1) : sourceWidth >= 2000 ? 2 : 1;
  const frameWidth = Math.round(sourceWidth / density);
  return {
    width,
    height,
    parts: Math.max(1, Math.ceil(height / PART_HEIGHT)),
    full: Boolean(screen.downloadable),
    frame: { width: frameWidth, height: sourceWidth ? Math.round((sourceHeight * frameWidth) / sourceWidth) : 0 },
  };
}

@Injectable()
export class FigmaImageService {
  private readonly cache = new LRUCache<string, Buffer>({
    max: 500,
    maxSize: 128 * 1024 * 1024,
    sizeCalculation: (buffer) => buffer.length,
  });

  constructor(private readonly loader: LoaderService) {}

  /** One part of the screen as JPEG, or null when there is no such part or the file is not published. */
  async part(screen: InspirationScreen, index: number): Promise<Buffer | null> {
    const shape = rendition(screen);
    if (!shape.width || !Number.isInteger(index) || index < 0 || index >= shape.parts) return null;
    const key = `${screen.id}@${screen.version ?? ''}:${shape.width}:${index}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const absolute = await this.loader.resolveServableFile(`screens/${screen.file}`);
    if (!absolute) return null;

    const top = index * PART_HEIGHT;
    const buffer = await sharp(absolute, { limitInputPixels: false })
      // Exactly the size the plugin was told, so the parts line up.
      .resize({ width: shape.width, height: shape.height, fit: 'fill' })
      .extract({ left: 0, top, width: shape.width, height: Math.min(PART_HEIGHT, shape.height - top) })
      // 4:4:4 keeps small UI text crisp, which the default chroma halving blurs.
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer();
    this.cache.set(key, buffer);
    return buffer;
  }
}
