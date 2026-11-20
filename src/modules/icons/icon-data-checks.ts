/**
 * Checks that catch broken icon data before it reaches the library. Each one
 * guards against a real failure:
 *
 *  - Off-frame artwork: Elusive (304 icons) and Meteocons (450) were imported
 *    with their display size (24x24, 24x32) recorded as the viewBox while the
 *    paths are drawn on 1200 and 512 canvases, so every icon rendered blank or
 *    as a corner fragment.
 *  - Unknown styles, and Thin icons without the lineWeight the API sorts Thin
 *    by (see weightBand in icons.service.ts).
 *
 * Pure functions, so the spec can prove each check fires on the broken case.
 */

export const ICON_STYLES = ['outline', 'solid', 'duotone', 'thin', '3d'] as const;

export type IconRecord = {
  id: string;
  svg?: string;
  viewBox?: string;
  style?: string;
  lineWeight?: number | null;
};

/** [minX, minY, width, height], or null when it isn't four numbers with a positive size. */
export function parseViewBox(viewBox: string | undefined): [number, number, number, number] | null {
  const parts = String(viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [, , width, height] = parts;
  return width > 0 && height > 0 ? (parts as [number, number, number, number]) : null;
}

const PATH_DATA = /\sd="([^"]+)"/g;
const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/gi;

/**
 * The largest coordinate magnitude in the icon's path data — a rough extent.
 * Relative path commands keep it small, so it only ever under-reports; an
 * icon drawn far outside its frame still shows numbers far past the frame.
 */
export function maxPathCoordinate(svg: string | undefined): number {
  let max = 0;
  for (const [, d] of String(svg ?? '').matchAll(PATH_DATA)) {
    for (const [n] of d.matchAll(NUMBER)) max = Math.max(max, Math.abs(Number(n)));
  }
  return max;
}

// A well-framed set sits around 1 (coordinates up to the frame's size). The
// broken imports measured 11.6 (Meteocons) and 50 (Elusive).
export const OFF_FRAME_RATIO = 2.5;

/**
 * How far past its frame a collection draws, as the median over its icons of
 * (largest coordinate / frame size). The median, so one odd icon can't fail a
 * set and one tidy icon can't hide a broken one.
 */
export function offFrameRatio(icons: IconRecord[], sampleSize = 200): number {
  // A spread sample is plenty for a median and keeps a 30k-icon set fast.
  const step = Math.max(1, Math.floor(icons.length / sampleSize));
  const ratios: number[] = [];
  for (let index = 0; index < icons.length; index += step) {
    const icon = icons[index];
    const box = parseViewBox(icon.viewBox);
    const extent = maxPathCoordinate(icon.svg);
    if (!box || extent === 0) continue;
    const [minX, minY, width, height] = box;
    ratios.push(extent / (Math.max(width, height) + Math.max(minX, minY, 0)));
  }
  if (ratios.length === 0) return 0;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

/** Problems with a single icon's record, as short messages. */
export function iconProblems(icon: IconRecord): string[] {
  const problems: string[] = [];
  if (!icon.svg || !icon.svg.trim()) problems.push('no artwork');
  if (!parseViewBox(icon.viewBox)) problems.push(`bad viewBox "${icon.viewBox}"`);
  if (!ICON_STYLES.includes(icon.style as (typeof ICON_STYLES)[number])) {
    problems.push(`unknown style "${icon.style}"`);
  }
  if (icon.style === 'thin' && typeof icon.lineWeight !== 'number') {
    problems.push('thin icon without lineWeight');
  }
  return problems;
}
