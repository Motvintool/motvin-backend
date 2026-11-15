import { ConfigService } from '@nestjs/config';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InspirationsAdminService } from './inspirations-admin.service';
import { InspirationsWatcherService } from './inspirations-watcher.service';
import { InspirationsService } from './inspirations.service';
import { LoaderService } from './loader.service';

/**
 * Files that land in the data folder without going through the admin API (a recorder, a script, a copy by hand)
 * still reach the manifest: the watcher rebuilds once the folder goes quiet.
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The folder an uploaded screen was written to. */
function folderOf(root: string, file: string): string {
  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry === file) return dir;
    }
    return null;
  };
  return walk(join(root, 'screens'))!;
}

describe('InspirationsWatcherService', () => {
  let tmp: string;
  let root: string;
  let watcher: InspirationsWatcherService;
  const manifest = () => JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  beforeEach(() => {
    process.env.INSPIRATIONS_WATCH = 'on';
    process.env.INSPIRATIONS_WATCH_QUIET_MS = '300';
    tmp = mkdtempSync(join(tmpdir(), 'ins-watch-'));
    const dataRoot = join(tmp, 'data');
    root = join(dataRoot, 'inspirations');
    mkdirSync(root, { recursive: true });
    const config = { get: (key: string) => (key === 'dataRoot' ? dataRoot : undefined) } as unknown as ConfigService;
    const loader = new LoaderService(config);
    const admin = new InspirationsAdminService(config, loader);
    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    admin.uploadScreen('ios', 'mobi', 'home.png', PNG_1X1, false, '');
    const inspirations = { backfillWords: () => Promise.resolve() } as unknown as InspirationsService;
    watcher = new InspirationsWatcherService(config, admin, inspirations);
    watcher.onModuleInit();
  });

  afterEach(() => {
    watcher.onModuleDestroy();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.INSPIRATIONS_WATCH;
    delete process.env.INSPIRATIONS_WATCH_QUIET_MS;
  });

  it('rebuilds when screens are copied straight into the folder, new screen types included', async () => {
    expect(manifest().counts.screens).toBe(1);
    const dir = folderOf(root, 'home.png');
    copyFileSync(join(dir, 'home.png'), join(dir, 'cart.png'));
    copyFileSync(join(dir, 'home.png'), join(dir, 'offer.png'));
    writeFileSync(join(dir, 'offer.json'), JSON.stringify({ name: 'Offer', screenType: 'paywall' }));
    await wait(1500);
    const after = manifest();
    expect(after.counts.screens).toBe(3);
    expect(after.taxonomy.screenTypes).toEqual(expect.arrayContaining(['home', 'cart', 'paywall']));
  });

  it('ignores the manifest, hidden files and half-written downloads', () => {
    expect(InspirationsWatcherService.relevant('manifest.json')).toBe(false);
    expect(InspirationsWatcherService.relevant('screens/ios/mobi/.DS_Store')).toBe(false);
    expect(InspirationsWatcherService.relevant('screens/ios/mobi/home.png.crdownload')).toBe(false);
    expect(InspirationsWatcherService.relevant('screens/ios/mobi/home.png')).toBe(true);
    expect(InspirationsWatcherService.relevant('words/mobi-ios-home.json')).toBe(false);
    expect(InspirationsWatcherService.relevant('apps.json')).toBe(true);
  });
});
