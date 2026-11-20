import * as fs from 'fs';
import * as path from 'path';
import {
  OFF_FRAME_RATIO,
  iconProblems,
  maxPathCoordinate,
  offFrameRatio,
  parseViewBox,
  type IconRecord,
} from './icon-data-checks';

// Loaded the way screen-preview.service.ts does: a plain require, since the
// project's module settings don't give CommonJS packages a default import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: typeof import('sharp').default = require('sharp');

/**
 * Guards the icon data the library serves. The unit cases rebuild the real
 * failures (Elusive and Meteocons drawn off their frames); the data cases run
 * the same checks over every collection in data/icons.
 */

// An Elusive icon as it was imported: drawn on a 1200 canvas, framed as 24.
const ELUSIVE_BROKEN: IconRecord = {
  id: 'el-adjust',
  viewBox: '0 0 24 24',
  style: 'solid',
  svg: '<path fill="currentColor" d="M600 0C268.641 0 0 268.641 0 600s268.641 600 600 600s600-268.641 600-600S931.359 0 600 0"/>',
};
const ELUSIVE_FIXED: IconRecord = { ...ELUSIVE_BROKEN, viewBox: '0 0 1200 1200' };
const TABLER_STYLE: IconRecord = {
  id: 'tabler-home',
  viewBox: '0 0 24 24',
  style: 'outline',
  svg: '<path fill="none" stroke="currentColor" d="M5 12H3l9-9l9 9h-2M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
};

describe('icon data checks', () => {
  it('reads a viewBox, rejecting anything without a positive size', () => {
    expect(parseViewBox('0 0 24 24')).toEqual([0, 0, 24, 24]);
    expect(parseViewBox('0,0,24,32')).toEqual([0, 0, 24, 32]);
    expect(parseViewBox('0 0 0 24')).toBeNull();
    expect(parseViewBox('0 0 24')).toBeNull();
    expect(parseViewBox(undefined)).toBeNull();
  });

  it('measures how far the paths reach', () => {
    expect(maxPathCoordinate(ELUSIVE_BROKEN.svg)).toBe(931.359);
    expect(maxPathCoordinate(TABLER_STYLE.svg)).toBe(12);
  });

  it('flags a collection drawn far outside its frame, and passes it once fixed', () => {
    expect(offFrameRatio([ELUSIVE_BROKEN, ELUSIVE_BROKEN, TABLER_STYLE])).toBeGreaterThan(OFF_FRAME_RATIO);
    expect(offFrameRatio([ELUSIVE_FIXED, ELUSIVE_FIXED, TABLER_STYLE])).toBeLessThanOrEqual(OFF_FRAME_RATIO);
  });

  it('reports a broken icon record', () => {
    expect(iconProblems(TABLER_STYLE)).toEqual([]);
    expect(iconProblems({ id: 'x', svg: '', viewBox: '0 0 24', style: 'bold' })).toEqual([
      'no artwork',
      'bad viewBox "0 0 24"',
      'unknown style "bold"',
    ]);
    expect(iconProblems({ ...TABLER_STYLE, style: 'thin' })).toEqual(['thin icon without lineWeight']);
  });
});

const DATA_ROOT = path.join(__dirname, '../../../data/icons');
const hasData = fs.existsSync(DATA_ROOT);

function loadCollections(): Array<[string, IconRecord[]]> {
  return fs
    .readdirSync(DATA_ROOT)
    .filter((id) => fs.existsSync(path.join(DATA_ROOT, id, 'icons.json')))
    .sort()
    .map((id) => [id, JSON.parse(fs.readFileSync(path.join(DATA_ROOT, id, 'icons.json'), 'utf8'))]);
}

/** Inked pixels when the icon is drawn at 48px — 0 means it shows nothing. */
async function inkedPixels(icon: IconRecord): Promise<number> {
  const size = 48;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.viewBox}" width="${size}" height="${size}" color="#000" fill="currentColor">${icon.svg}</svg>`;
  const alpha = await sharp(Buffer.from(svg)).resize(size, size).ensureAlpha().extractChannel(3).raw().toBuffer();
  return alpha.reduce((count, value) => count + (value > 20 ? 1 : 0), 0);
}

// Skipped where the data isn't checked out (it is gitignored in some setups).
(hasData ? describe : describe.skip)('icon data in data/icons', () => {
  const collections = hasData ? loadCollections() : [];

  it('has artwork, a frame and a known style on every icon', () => {
    const broken: string[] = [];
    for (const [id, icons] of collections) {
      for (const icon of icons) {
        const problems = iconProblems(icon);
        if (problems.length) broken.push(`${id}/${icon.id}: ${problems.join(', ')}`);
      }
    }
    // Show the first few, not 300k lines, when a whole set breaks.
    expect(broken.slice(0, 20)).toEqual([]);
  });

  it('draws every collection inside its frame', () => {
    const offFrame = collections
      .map(([id, icons]) => [id, Math.round(offFrameRatio(icons) * 10) / 10] as const)
      .filter(([, ratio]) => ratio > OFF_FRAME_RATIO);
    expect(offFrame).toEqual([]);
  });

  it('renders a visible sample of every collection', async () => {
    const SAMPLE = 12;
    const blank: string[] = [];
    let rendered = 0;
    let attempted = 0;
    for (const [id, icons] of collections) {
      // Spread across the set rather than its first few, which are often alike.
      const step = Math.max(1, Math.floor(icons.length / SAMPLE));
      const sample = icons.filter((_, index) => index % step === 0).slice(0, SAMPLE);
      let empty = 0;
      for (const icon of sample) {
        attempted++;
        try {
          if ((await inkedPixels(icon)) === 0) empty++;
          rendered++;
        } catch {
          // librsvg rejects some markup browsers accept; that isn't a blank icon.
        }
      }
      // A stray empty glyph happens (spacers, some "blank" icons); a set whose
      // sample is mostly empty is the broken-frame failure.
      if (empty > sample.length / 2) blank.push(`${id}: ${empty}/${sample.length} blank`);
    }
    expect(blank).toEqual([]);
    // If rendering itself stops working, every icon would be skipped and the
    // check above would pass on nothing. Nearly all of them must draw.
    expect(rendered / attempted).toBeGreaterThan(0.95);
  }, 120_000);
});
