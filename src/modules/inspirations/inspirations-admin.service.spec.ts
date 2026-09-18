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

  describe('uploads', () => {
    it('stores a screenshot at screens/<platform>/<app>/<file>', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      const result = service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, false);

      expect(existsSync(join(store, 'screens', 'ios', 'acme', 'dashboard.png'))).toBe(true);
      expect(result.id).toBe('acme-ios-dashboard');
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
    });

    it('refuses a file that is not a readable image, and keeps nothing on disk', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });

      expect(() =>
        service.uploadScreen('ios', 'acme', 'dashboard.png', Buffer.from('not an image'), false),
      ).toThrow(/not a readable image/i);
      expect(existsSync(join(store, 'screens', 'ios', 'acme', 'dashboard.png'))).toBe(false);
    });

    it('refuses a second upload to the same name unless overwrite is asked for', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, false);

      expect(() => service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, false)).toThrow(
        /already exists/i,
      );
      expect(() => service.uploadScreen('ios', 'acme', 'dashboard.png', PNG_1X1, true)).not.toThrow();
    });

    it('refuses an unknown platform', () => {
      expect(() => service.uploadScreen('desktop', 'acme', 'dashboard.png', PNG_1X1, false)).toThrow(
        /platform must be one of/i,
      );
    });

    it('refuses path traversal in the app name and the file name', () => {
      expect(() => service.uploadScreen('ios', '../../etc', 'dashboard.png', PNG_1X1, false)).toThrow();
      expect(() => service.uploadScreen('ios', 'acme', '../../../evil.png', PNG_1X1, false)).toThrow();

      // Nothing escaped the store.
      expect(existsSync(join(tmp, 'data', 'evil.png'))).toBe(false);
      expect(existsSync(join(tmp, 'evil.png'))).toBe(false);
    });

    it('refuses an empty upload', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      expect(() => service.uploadScreen('ios', 'acme', 'dashboard.png', Buffer.alloc(0), false)).toThrow(
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
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false);
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
      service.uploadScreen('web', 'acme', 'settings.png', PNG_1X1, false);

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
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false);
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

    it('refuses an unknown screen type or style', () => {
      expect(() =>
        service.saveScreenMeta('web', 'acme', 'dashboard.png', { screenType: 'nonsense' as never }),
      ).toThrow(/screenType/i);
      expect(() =>
        service.saveScreenMeta('web', 'acme', 'dashboard.png', { style: ['neon'] as never }),
      ).toThrow(/unknown style/i);
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
      service.uploadScreen('ios', 'other-co', 'login.png', PNG_1X1, false);
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

    it('removes everything stored for an app when it is deleted', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false);
      service.uploadScreen('ios', 'acme', 'login.png', PNG_1X1, false);
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
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false);
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false);
      service.uploadScreen('web', 'other', 'landing.png', PNG_1X1, false);
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

    it('needs at least two screens for a flow', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      expect(() =>
        service.saveFlow({
          id: 'acme-web-onboarding',
          appId: 'acme',
          name: 'Onboarding',
          category: 'onboarding',
          platform: 'web',
          screenIds: ['acme-web-dashboard'],
        }),
      ).toThrow(/at least two/i);
    });

    it('publishes a flow whose screens are all published', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false);
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false);
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

    it('drops flow steps that are not published, and the flow with them', () => {
      service.saveApp({ id: 'acme', name: 'Acme', industry: 'saas' });
      service.uploadScreen('web', 'acme', 'login.png', PNG_1X1, false);
      service.uploadScreen('web', 'acme', 'dashboard.png', PNG_1X1, false);
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
      expect(report.counts.flows).toBe(0);
      expect(report.warnings.join(' ')).toMatch(/acme-web-dashboard/);
    });
  });
});
