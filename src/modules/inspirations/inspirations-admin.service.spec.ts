import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InspirationsAdminService } from './inspirations-admin.service';
import { LoaderService } from './loader.service';

/**
 * Covers what the admin API does to the store: where files land, what is
 * refused, and what the licensing gate publishes.
 *
 * Each test runs against a throwaway data root, so nothing here touches the
 * real library.
 */

/** Smallest thing the builder will accept as an image: a 1x1 PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeService(root: string) {
  const dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'inspirations'), { recursive: true });
  const config = {
    get: (key: string) => (key === 'dataRoot' ? dataRoot : undefined),
  } as unknown as ConfigService;
  // The loader only needs to record that it was told to drop its cache.
  const loader = new LoaderService(config);
  return {
    service: new InspirationsAdminService(config, loader),
    loader,
    store: join(dataRoot, 'inspirations'),
  };
}

function readManifest(store: string) {
  return JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf-8'));
}

describe('InspirationsAdminService', () => {
  let tmp: string;
  let service: InspirationsAdminService;
  let store: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ins-admin-'));
    const made = makeService(tmp);
    service = made.service;
    store = made.store;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('app category', () => {
    const apps = () => JSON.parse(readFileSync(join(store, 'apps.json'), 'utf-8')).apps;

    it('keeps an app whose category could not be worked out, and never offers it as a choice', () => {
      service.saveApp({ id: 'gap', name: 'Gap', industry: 'unsorted' });
      service.uploadScreen('ios', 'gap', 'home.png', PNG_1X1, false, '');
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('ios', 'acme', 'home.png', PNG_1X1, false, '');

      const manifest = readManifest(store);
      expect(manifest.apps.find((a: any) => a.id === 'gap').industry).toBe('unsorted');
      // Public filter and admin vocabulary list real categories only.
      expect(manifest.taxonomy.industries).toEqual(['saas']);
      expect(manifest.vocabulary.industries).not.toContain('unsorted');
    });

    it('records a category chosen here as manual, and keeps the source when it does not change', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      expect(apps()[0].industrySource).toBe('manual');

      // An earlier run (crawler) recorded the store as the source; saving other fields keeps it.
      const file = join(store, 'apps.json');
      const doc = JSON.parse(readFileSync(file, 'utf-8'));
      doc.apps[0].industrySource = 'store';
      writeFileSync(file, JSON.stringify(doc));
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', tagline: 'New tagline' });
      expect(apps()[0].industrySource).toBe('store');

      service.saveApp({ id: 'acme', name: 'Acme', industry: 'travel' });
      expect(apps()[0].industrySource).toBe('manual');
    });
  });

  describe('app platforms', () => {
    const apps = () => JSON.parse(readFileSync(join(store, 'apps.json'), 'utf-8')).apps;

    it('stores the platforms chosen for an app, in library order, and keeps them when a later save omits them', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: ['web', 'ios'] });
      expect(apps()[0].platforms).toEqual(['ios', 'web']);
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', tagline: 'x' });
      expect(apps()[0].platforms).toEqual(['ios', 'web']);
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: [] });
      expect(apps()[0].platforms).toEqual([]);
    });

    it('refuses a platform the library does not cover', () => {
      expect(() => service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: ['android'] })).toThrow(/platforms must be/);
      expect(() => service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: 'ios' })).toThrow(/platforms must be/);
    });

    it('moves an app between platforms when its declared platform is not the folder its screens were filed under', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'home.png', PNG_1X1, false, '');
      expect(readManifest(store).screens[0].platform).toBe('web');

      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: ['webapp'] });
      const manifest = readManifest(store);
      expect(manifest.screens[0].platform).toBe('webapp');
      expect(manifest.screens[0].tags).toContain('webapp');
      expect(manifest.screens[0].tags).not.toContain('web');
      expect(manifest.apps.find((a: any) => a.id === 'acme').platforms).toEqual(['webapp']);
      expect(manifest.taxonomy.platforms).toEqual(['webapp']);
      // The file did not move, so its address and id are unchanged.
      expect(manifest.screens[0].url).toContain('/screens/web/acme/');
    });

    it('keeps a screen on a declared platform of its own kind, and falls back to the first declared one otherwise', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: ['ios', 'webapp'] });
      service.uploadScreen('web', 'acme', 'home.png', PNG_1X1, false, '');
      service.uploadScreen('ios', 'acme', 'login.png', PNG_1X1, false, '');
      const platforms = Object.fromEntries(readManifest(store).screens.map((s: any) => [s.file.split('/')[0], s.platform]));
      // The website's screen is a browser screen, so it goes to the declared browser platform; the iOS one stays.
      expect(platforms).toEqual({ web: 'webapp', ios: 'ios' });
    });

    it('lists a declared platform on the app even before it has screens there', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', platforms: ['ios', 'webapp'] });
      service.uploadScreen('ios', 'acme', 'home.png', PNG_1X1, false, '');
      const manifest = readManifest(store);
      expect(manifest.apps.find((a: any) => a.id === 'acme').platforms).toEqual(['ios', 'webapp']);
    });
  });

  describe('uploads', () => {
    it('stores a screenshot at screens/<platform>/<app>/<file>', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      const result = service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, false, '');

      expect(existsSync(join(store, 'screens', 'ios', 'acme', 'dashboard.png'))).toBe(true);
      expect(result.id).toBe('acme-ios-dashboard');
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
    });

    it('refuses a file that is not a readable image, and keeps nothing on disk', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });

      expect(() =>
        service.uploadScreen('ios', 'acme', 'dashboard.png', Buffer.from('not an image'), false, ''),
      ).toThrow(/not a readable image/i);
      expect(existsSync(join(store, 'screens', 'ios', 'acme', 'dashboard.png'))).toBe(false);
    });

    it('refuses a second upload to the same name unless overwrite is asked for', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, false, '');

      expect(() => service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, false, '')).toThrow(
        /already exists/i,
      );
      expect(() => service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, true, '')).not.toThrow();
    });

    it('refuses an unknown platform', () => {
      expect(() => service.uploadScreen('desktop', 'acme', 'dashboard.png', PNG_1X1, false, '')).toThrow(
        /platform must be one of/i,
      );
    });

    it('refuses path traversal in the app name and the file name', () => {
      expect(() => service.uploadScreen('ios', '../../etc', 'dashboard.png', PNG_1X1, false, '')).toThrow();
      expect(() => service.uploadScreen('ios', 'acme', '../../../evil.png', PNG_1X1, false, '')).toThrow();

      // Nothing escaped the store.
      expect(existsSync(join(tmp, 'data', 'evil.png'))).toBe(false);
      expect(existsSync(join(tmp, 'evil.png'))).toBe(false);
    });

    it('refuses an empty upload', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      expect(() => service.uploadScreen('ios', 'acme', 'dashboard.png', Buffer.alloc(0), false, '')).toThrow(
        /empty/i,
      );
    });

    it('refuses an SVG logo carrying a script', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      const hostile = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

      expect(() => service.uploadLogo('acme', 'acme.svg', hostile)).toThrow(/script/i);
      expect(existsSync(join(store, 'logos', 'acme.svg'))).toBe(false);
    });

    it('stores a clean SVG logo', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');

      expect(service.uploadLogo('acme', 'acme.svg', svg).logo).toBe('acme.svg');
      expect(existsSync(join(store, 'logos', 'acme.svg'))).toBe(true);
    });
  });

  describe('the licensing gate', () => {
    beforeEach(() => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
    });

    it('publishes a new app without a separate approval step', () => {
      const manifest = readManifest(store);

      expect(manifest.counts.screens).toBe(1);
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'dashboard.png'))).toBe(true);
    });

    it('records the app in sources.json so its origin is still tracked', () => {
      const sources = JSON.parse(readFileSync(join(store, 'sources.json'), 'utf-8')).sources;

      expect(sources.acme).toBeDefined();
      expect(sources.acme.status).toBe('approved');
    });

    it('leaves provenance already recorded by hand untouched', () => {
      service.saveSource('acme', {
        permission: 'owner-granted',
        attribution: 'Acme Inc.',
        redistribution: 'view-only',
        status: 'approved',
      });
      // A later upload must not reset what someone entered deliberately.
      service.uploadScreen('web', 'acme', 'settings.png', PNG_1X1, false, '');

      const sources = JSON.parse(readFileSync(join(store, 'sources.json'), 'utf-8')).sources;
      expect(sources.acme.permission).toBe('owner-granted');
      expect(sources.acme.attribution).toBe('Acme Inc.');
      expect(sources.acme.redistribution).toBe('view-only');
    });

    it('publishes once the source entry is approved', () => {
      service.saveSource('acme', {
        permission: 'own-work',
        license: 'CC0',
        attribution: 'Motvin',
        redistribution: 'allowed',
        status: 'approved',
      });

      const manifest = readManifest(store);
      expect(manifest.counts.screens).toBe(1);
      expect(manifest.screens[0].id).toBe('acme-web-dashboard');
      expect(manifest.screens[0].downloadable).toBe(true);
    });

    it('marks an approved but view-only app as not downloadable', () => {
      service.saveSource('acme', {
        permission: 'fair-use-reference',
        license: 'Editorial reference',
        attribution: 'Acme Inc.',
        redistribution: 'view-only',
        status: 'approved',
      });

      expect(readManifest(store).screens[0].downloadable).toBe(false);
    });

    it('refuses to approve without a permission basis', () => {
      expect(() => service.saveSource('acme', { status: 'approved' })).toThrow(/permission basis/i);
      expect(() => service.saveSource('acme', { status: 'approved', permission: '' })).toThrow(
        /permission basis/i,
      );
    });

    it('approves on a permission basis alone, with licence and attribution optional', () => {
      service.saveSource('acme', { status: 'approved', permission: 'own-work' });

      const manifest = readManifest(store);
      expect(manifest.counts.screens).toBe(1);
      expect(manifest.screens[0].source.license).toBeNull();
      expect(manifest.screens[0].source.permission).toBe('own-work');
    });

    it('falls back to the app name when no attribution is given', () => {
      service.saveSource('acme', { status: 'approved', permission: 'own-work' });

      expect(readManifest(store).screens[0].source.attribution).toBe('Acme');
      expect(readManifest(store).apps[0].attribution).toBe('Acme');
    });

    it('unpublishes again when approval is withdrawn', () => {
      service.saveSource('acme', {
        permission: 'own-work',
        license: 'CC0',
        attribution: 'Motvin',
        status: 'approved',
      });
      expect(readManifest(store).counts.screens).toBe(1);

      service.saveSource('acme', { status: 'rejected' });
      expect(readManifest(store).counts.screens).toBe(0);
    });
  });

  describe('metadata and deletion', () => {
    beforeEach(() => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', {
        permission: 'own-work',
        license: 'CC0',
        attribution: 'Motvin',
        status: 'approved',
      });
    });

    it('writes a sidecar next to the image and uses it in the manifest', () => {
      service.saveScreenMeta('web', 'acme', 'dashboard.png', {
        name: 'Revenue overview',
        screenType: 'dashboard',
        tags: ['kpi'],
        elements: ['chart', 'table'],
        style: ['minimal'],
      });

      expect(existsSync(join(store, 'screens', 'web', 'acme', 'dashboard.json'))).toBe(true);
      const screen = readManifest(store).screens[0];
      expect(screen.name).toBe('Revenue overview');
      expect(screen.elements).toEqual(['chart', 'table']);
      expect(screen.tags).toEqual(expect.arrayContaining(['kpi', 'saas', 'dashboard', 'web']));
    });

    it('accepts a new screen type, style or state, but only in filter-safe form', () => {
      expect(() =>
        service.saveScreenMeta('web', 'acme', 'dashboard.png', { screenType: 'paywall' as never, style: ['neon'] as never, states: ['offline'] as never }),
      ).not.toThrow();
      expect(() =>
        service.saveScreenMeta('web', 'acme', 'dashboard.png', { screenType: 'Pay wall!' as never }),
      ).toThrow(/screenType/i);
      expect(() =>
        service.saveScreenMeta('web', 'acme', 'dashboard.png', { style: ['neon glow'] as never }),
      ).toThrow(/style/i);
    });

    it('lets patterns match from the components recorded on a screen', () => {
      service.saveScreenMeta('web', 'acme', 'dashboard.png', { elements: ['chart'] });
      writeFileSync(
        join(store, 'patterns.json'),
        JSON.stringify({
          version: 1,
          patterns: [
            {
              slug: 'bar-line-charts',
              name: 'Bar & line charts',
              category: 'Charts',
              description: 'Charts.',
              tags: ['chart'],
              match: { elements: ['chart'] },
            },
          ],
        }),
      );

      const manifest = service.rebuild();
      expect(manifest.counts.patterns).toBe(1);
      expect(readManifest(store).patterns[0].screenIds).toEqual(['acme-web-dashboard']);
    });

    it('removes the image, its sidecar and its analysis on delete', () => {
      service.saveScreenMeta('web', 'acme', 'dashboard.png', { name: 'Revenue overview' });
      mkdirSync(join(store, 'analysis'), { recursive: true });
      writeFileSync(join(store, 'analysis', 'acme-web-dashboard.json'), '{}');

      service.deleteScreen('web', 'acme', 'dashboard.png');

      expect(existsSync(join(store, 'screens', 'web', 'acme', 'dashboard.png'))).toBe(false);
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'dashboard.json'))).toBe(false);
      expect(existsSync(join(store, 'analysis', 'acme-web-dashboard.json'))).toBe(false);
      expect(readManifest(store).counts.screens).toBe(0);
    });

    it('reports held-back files with a reason in the admin state', () => {
      // Uploading under a slug with no apps.json record is now the main way a
      // file can fail to publish, the licence gate having been removed.
      service.uploadScreen('ios', 'other-co', 'login.png', PNG_1X1, false, '');
      const state = service.getState();

      const held = state.files.find((f) => f.appId === 'other-co');
      expect(held?.published).toBe(false);
      expect(held?.blockedReason).toMatch(/apps\.json/i);
      expect(state.files.find((f) => f.appId === 'acme')?.published).toBe(true);
    });
  });

  describe('apps and flows', () => {
    it('refuses an app with an unknown industry', () => {
      expect(() => service.saveApp({ id: 'acme', name: 'Acme', industry: 'rocketry' })).toThrow(
        /industry must be one of/i,
      );
    });

    it('lists an app\'s files in the order the public app page shows them, not folder order', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      // On disk "browsing/" sorts before "onboarding/"; the flow recorded first
      // is the onboarding one, so the app page (and now the admin) opens on it.
      service.uploadScreen('ios', 'acme', '1.png', PNG_1X1, false, '', 'browsing');
      service.uploadScreen('ios', 'acme', '1.png', PNG_1X1, false, '', 'onboarding');
      service.uploadScreen('ios', 'acme', '2.png', PNG_1X1, false, '', 'onboarding');
      service.saveFlow({ id: 'acme-ios-onboarding', appId: 'acme', name: 'Onboarding', category: 'onboarding', platform: 'ios', screenIds: ['acme-ios-onboarding-1', 'acme-ios-onboarding-2'] });
      service.saveFlow({ id: 'acme-ios-browsing', appId: 'acme', name: 'Browsing', category: 'discovery', platform: 'ios', screenIds: ['acme-ios-browsing-1'] });

      const publicOrder = readManifest(store).screens.map((s: any) => s.id);
      expect(publicOrder).toEqual(['acme-ios-onboarding-1', 'acme-ios-onboarding-2', 'acme-ios-browsing-1']);
      expect(service.getState().files.map((f) => f.id)).toEqual(publicOrder);
    });

    it('keeps the screens picked for the card carousel, in order, and publishes them on the app', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('ios', 'acme', 'splash.png', PNG_1X1, false, '');
      service.uploadScreen('ios', 'acme', 'home.png', PNG_1X1, false, '');
      service.uploadScreen('ios', 'acme', 'cart.png', PNG_1X1, false, '');

      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', cardScreens: ['acme-ios-home', 'acme-ios-cart'] });
      expect(readManifest(store).apps[0].cardScreens).toEqual(['acme-ios-home', 'acme-ios-cart']);

      // A save that says nothing about the card leaves the pick alone.
      service.saveApp({ id: 'acme', name: 'Acme Inc', industry: 'saas' });
      expect(readManifest(store).apps[0].cardScreens).toEqual(['acme-ios-home', 'acme-ios-cart']);

      // An empty list hands the choice back to the card.
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', cardScreens: [] });
      expect(readManifest(store).apps[0].cardScreens).toEqual([]);
    });

    it('refuses card screens that are not stored for the app, or more than four', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.saveApp({ id: 'other', name: 'Other', industry: 'saas' });
      for (const name of ['a', 'b', 'c', 'd', 'e']) service.uploadScreen('ios', 'acme', `${name}.png`, PNG_1X1, false, '');
      service.uploadScreen('ios', 'other', 'home.png', PNG_1X1, false, '');

      expect(() => service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', cardScreens: ['other-ios-home'] })).toThrow(
        /not stored for "acme"/,
      );
      expect(() =>
        service.saveApp({
          id: 'acme',
          name: 'Acme',
          industry: 'saas',
          cardScreens: ['acme-ios-a', 'acme-ios-b', 'acme-ios-c', 'acme-ios-d', 'acme-ios-e'],
        }),
      ).toThrow(/at most 4/);
      expect(() => service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas', cardScreens: 'acme-ios-a' })).toThrow(
        /list of screen ids/,
      );
    });

    it('removes everything stored for an app when it is deleted', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.uploadScreen('ios', 'acme', 'login.png', PNG_1X1, false, '');
      service.saveScreenMeta('web', 'acme', 'dashboard.png', { name: 'Revenue overview' });
      service.uploadLogo('acme', 'acme.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      service.saveSource('acme', {
        permission: 'own-work',
        license: 'CC0',
        attribution: 'Motvin',
        status: 'approved',
      });
      mkdirSync(join(store, 'analysis'), { recursive: true });
      writeFileSync(join(store, 'analysis', 'acme-web-dashboard.json'), '{}');
      expect(readManifest(store).counts.screens).toBe(2);

      const result = service.deleteApp('acme');

      expect(result.removed).toEqual({
        app: true,
        screens: 2,
        analysis: 1,
        flows: 0,
        logo: 'acme.svg',
        source: true,
      });
      expect(existsSync(join(store, 'screens', 'web', 'acme'))).toBe(false);
      expect(existsSync(join(store, 'screens', 'ios', 'acme'))).toBe(false);
      expect(existsSync(join(store, 'analysis', 'acme-web-dashboard.json'))).toBe(false);
      expect(existsSync(join(store, 'logos', 'acme.svg'))).toBe(false);
      expect(readManifest(store).counts.screens).toBe(0);

      const state = service.getState();
      expect(state.apps).toHaveLength(0);
      expect(state.files).toHaveLength(0);
      expect(state.sources.acme).toBeUndefined();
    });

    it('takes the flows with it and leaves other apps untouched', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.saveApp({ id: 'other', name: 'Other', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false, '');
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.uploadScreen('web', 'other', 'landing.png', PNG_1X1, false, '');
      for (const id of ['acme', 'other']) {
        service.saveSource(id, {
          permission: 'own-work',
          license: 'CC0',
          attribution: 'Motvin',
          status: 'approved',
        });
      }
      service.saveFlow({
        id: 'acme-web-signin',
        appId: 'acme',
        name: 'Sign in',
        category: 'authentication',
        platform: 'web',
        screenIds: ['acme-web-login', 'acme-web-dashboard'],
      });

      const result = service.deleteApp('acme');

      expect(result.removed.flows).toBe(1);
      expect(existsSync(join(store, 'screens', 'web', 'other', 'landing.png'))).toBe(true);
      const manifest = readManifest(store);
      expect(manifest.counts.flows).toBe(0);
      expect(manifest.counts.apps).toBe(1);
      expect(manifest.apps[0].id).toBe('other');
    });

    it('is harmless when the app does not exist', () => {
      const result = service.deleteApp('never-existed');

      expect(result.removed.app).toBe(false);
      expect(result.removed.screens).toBe(0);
    });

    it('needs at least one screen for a flow', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      expect(() =>
        service.saveFlow({
          id: 'acme-web-onboarding',
          appId: 'acme',
          name: 'Onboarding',
          category: 'onboarding',
          platform: 'web',
          screenIds: [],
        }),
      ).toThrow(/at least one/i);
    });

    it('publishes a flow whose screens are all published', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false, '');
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', {
        permission: 'own-work',
        license: 'CC0',
        attribution: 'Motvin',
        status: 'approved',
      });

      service.saveFlow({
        id: 'acme-web-signin',
        appId: 'acme',
        name: 'Sign in',
        category: 'authentication',
        platform: 'web',
        screenIds: ['acme-web-login', 'acme-web-dashboard'],
      });

      const manifest = readManifest(store);
      expect(manifest.counts.flows).toBe(1);
      expect(manifest.flows[0].screenIds).toEqual(['acme-web-login', 'acme-web-dashboard']);
    });

    it('drops flow steps that are not published, and keeps the flow with what remains', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false, '');
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', {
        permission: 'own-work',
        license: 'CC0',
        attribution: 'Motvin',
        status: 'approved',
      });
      service.saveFlow({
        id: 'acme-web-signin',
        appId: 'acme',
        name: 'Sign in',
        category: 'authentication',
        platform: 'web',
        screenIds: ['acme-web-login', 'acme-web-dashboard'],
      });

      service.deleteScreen('web', 'acme', 'dashboard.png');

      const report = service.rebuild();
      // A journey of one remaining step is still a journey — a section seen
      // once, a sheet opened and dismissed — so the flow survives, shorter.
      expect(report.counts.flows).toBe(1);
      expect(report.warnings.join(' ')).toMatch(/acme-web-dashboard/);
    });
  });

  describe('versions', () => {
    it('groups legacy (unwrapped) screens into one version, labeled by the source capture date', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', {
        permission: 'own-work',
        capturedAt: '2025-01-15',
        status: 'approved',
      });
      service.rebuild();

      const versions = service.listVersions('acme');
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ id: '2025-01-15', label: '15 Jan 2025', isLatest: true });
      expect(readManifest(store).apps[0].currentVersion).toBe('2025-01-15');
      expect(readManifest(store).screens[0].version).toBe('2025-01-15');
    });

    it('files a fresh upload with no explicit version into a dated folder under versions/, alongside the legacy one', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', { permission: 'own-work', capturedAt: '2025-01-15', status: 'approved' });

      // No version named — lands in a real dated folder, not the legacy bucket.
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false, '2026-09-29');

      expect(existsSync(join(store, 'screens', 'web', 'acme', 'versions', '2026-09-29', 'login.png'))).toBe(true);
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'dashboard.png'))).toBe(true);

      const versions = service.listVersions('acme');
      expect(versions.map((v) => v.id)).toEqual(['2026-09-29', '2025-01-15']);
      expect(versions[0]).toMatchObject({ label: '29 Sep 2026', isLatest: true });
      expect(versions[1]).toMatchObject({ isLatest: false });

      const manifest = readManifest(store);
      expect(manifest.counts.screens).toBe(2);
      const login = manifest.screens.find((s: any) => s.id === 'acme-web-versions-2026-09-29-login');
      expect(login.version).toBe('2026-09-29');
      expect(login.file).toBe('web/acme/versions/2026-09-29/login.png');
    });

    it('renames a version to change which one is "Latest", moving its screens, analysis and flow ids along with it', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', { permission: 'own-work', capturedAt: '2025-01-15', status: 'approved' });

      // Flow-folder screens are written directly to disk by the crawler, not
      // through the admin upload route (which refuses a slash in the file
      // name) — this places one the same way a real ingest would.
      const flowDir = join(store, 'screens', 'web', 'acme', 'versions', '2026-01-05', 'onboarding');
      mkdirSync(flowDir, { recursive: true });
      writeFileSync(join(flowDir, '1.png'), PNG_1X1);
      service.rebuild();

      mkdirSync(join(store, 'analysis'), { recursive: true });
      writeFileSync(join(store, 'analysis', 'acme-web-versions-2026-01-05-onboarding-1.json'), '{}');
      service.saveFlow({
        id: 'acme-web-versions-2026-01-05-onboarding',
        appId: 'acme',
        name: 'Onboarding',
        category: 'onboarding',
        platform: 'web',
        screenIds: ['acme-web-versions-2026-01-05-onboarding-1'],
      });

      expect(() => service.renameVersion('acme', '2099-01-01', '2030-01-01')).toThrow(/not a known version/i);
      expect(() => service.renameVersion('acme', '2026-01-05', '2025-01-15')).toThrow(/already has a version/i);
      // The legacy (undated) bucket isn't stored in a `versions/` folder, so
      // it can't be renamed the same way a real dated version is.
      expect(() => service.renameVersion('acme', '2025-01-15', '2030-01-01')).toThrow(/undated capture/i);

      const result = service.renameVersion('acme', '2026-01-05', '2027-03-10');

      expect(result.versions.map((v) => v.id)).toEqual(['2027-03-10', '2025-01-15']);
      expect(result.versions[0]).toMatchObject({ isLatest: true });
      expect(readManifest(store).apps[0].currentVersion).toBe('2027-03-10');
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'versions', '2027-03-10', 'onboarding', '1.png'))).toBe(true);
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'versions', '2026-01-05'))).toBe(false);
      expect(existsSync(join(store, 'analysis', 'acme-web-versions-2027-03-10-onboarding-1.json'))).toBe(true);

      const flowsDoc = JSON.parse(readFileSync(join(store, 'flows.json'), 'utf-8'));
      const flow = flowsDoc.flows.find((f: any) => f.appId === 'acme');
      expect(flow.id).toBe('acme-web-versions-2027-03-10-onboarding');
      expect(flow.screenIds).toEqual(['acme-web-versions-2027-03-10-onboarding-1']);

      // A subsequent upload with no version named lands in the renamed
      // (now newest) version, not today's date.
      service.uploadScreen('web', 'acme', 'settings.png', PNG_1X1, false);
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'versions', '2027-03-10', 'settings.png'))).toBe(true);
    });

    it('gives an app with no dated folder a version list of exactly one', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', { permission: 'own-work', status: 'approved' });

      expect(service.listVersions('acme')).toHaveLength(1);
    });

    it('deletes a whole version: its screens, sidecars and analysis', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', { permission: 'own-work', capturedAt: '2025-01-15', status: 'approved' });
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false, '2026-09-29');
      mkdirSync(join(store, 'analysis'), { recursive: true });
      writeFileSync(join(store, 'analysis', 'acme-web-versions-2026-09-29-login.json'), '{}');

      const result = service.deleteVersion('acme', '2026-09-29');

      expect(result.removed).toEqual({ screens: 1, analysis: 1 });
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'versions', '2026-09-29'))).toBe(false);
      expect(existsSync(join(store, 'analysis', 'acme-web-versions-2026-09-29-login.json'))).toBe(false);
      expect(existsSync(join(store, 'screens', 'web', 'acme', 'dashboard.png'))).toBe(true);

      // Deleting the newest version falls back to the one that remains.
      const versions = service.listVersions('acme');
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ id: '2025-01-15', isLatest: true });
    });

    it('refuses to delete an unknown version, or an app\'s only version', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false, '');
      service.saveSource('acme', { permission: 'own-work', capturedAt: '2025-01-15', status: 'approved' });

      expect(() => service.deleteVersion('acme', '2099-01-01')).toThrow(/not a known version/i);
      expect(() => service.deleteVersion('acme', '2025-01-15')).toThrow(/only one version/i);
    });
  });
});
